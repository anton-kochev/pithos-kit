import { relative } from 'node:path';
import { failureSummary, resolveClassifier, type ClassifierUsage } from './classify.ts';
import { buildWindows, collect, type Collection } from './collect.ts';
import { applyAndCommit, type ApplyOutcome } from './commit.ts';
import type { Config } from './config.ts';
import { planCapture } from './cursor.ts';
import { buildTask, mapDocs } from './digest.ts';
import { changePath, changesOf, gate, type Change, type GatedChange } from './gate.ts';
import type { Git } from './git.ts';
import { Inbox } from './inbox.ts';
import type { Evidence } from './proposal.ts';
import { writeRecord, type RunRecord } from './record.ts';
import { contextBudget, runWorker, selectWorker, type WorkerContext, type WorkerResult } from './worker.ts';

export interface RunInput {
  git: Git;
  root: string;
  ctx: WorkerContext;
  /** Current session branch entries. */
  entries: readonly unknown[];
  config: Config;
  signal?: AbortSignal;
  /** Resolves when the main agent is idle; Clio only commits then. */
  waitIdle: () => Promise<void>;
  /** Capture from this revision instead of the stored cursor. */
  since?: string;
  /** Reports what the run is doing right now, for the progress status. */
  onProgress?: (step: string, range: string) => void;
}

export interface RunReport {
  /** none and reset are quiet; everything else is worth showing. */
  status: 'none' | 'reset' | 'nothing' | 'done' | 'failed';
  text: string;
  committed?: string;
  inboxed: number;
  /** Classifier health for this run, when one was configured and used. */
  classifier?: { model: string; calls: number; failed: number; lastError?: string };
  /** Run record path, relative to the project root when possible. */
  record?: string;
}

const short = (sha: string) => sha.slice(0, 7);

function costLine(worker: WorkerResult | undefined, classifier: ClassifierUsage | undefined, elapsedMs: number): string {
  const parts = [`${Math.round(elapsedMs / 1000)}s`];
  const known = (worker?.usage.measuredTurns ?? 0) > 0 || (classifier?.cost ?? 0) > 0;
  const cost = (worker?.usage.cost ?? 0) + (classifier?.cost ?? 0);
  parts.push(known ? `~$${cost.toFixed(4)}${worker && worker.usage.measuredTurns < worker.usage.turns ? ' (partial)' : ''}` : 'cost unknown');
  return parts.join(' · ');
}

export async function runCapture(input: RunInput): Promise<RunReport> {
  const started = Date.now();
  const { git, config } = input;
  const plan = await planCapture(git, config.maxCommits, input.since);
  if (plan.kind === 'none') return { status: 'none', text: `Clio · nothing to do: ${plan.reason}`, inboxed: 0 };
  if (plan.kind === 'reset' || plan.kind === 'skip') {
    await git.writeCursor(plan.branch, plan.head);
    return plan.kind === 'reset'
      ? { status: 'reset', text: `Clio · watching ${plan.branch} from ${short(plan.head)} (${plan.reason}); new commits after this get documented`, inboxed: 0 }
      : { status: 'none', text: 'Clio · only its own commits are new', inboxed: 0 };
  }

  const range = `${short(plan.from)}..${short(plan.to)}`;
  const progress = (step: string) => { try { input.onProgress?.(step, range); } catch { /* display only */ } };
  const resolution = resolveClassifier(input.ctx.modelRegistry, config.classifier);
  const classifier = resolution.classifier;
  const unavailable = resolution.classifier ? undefined : resolution.unavailable;
  // Filled in as the run goes, for the run record.
  const trace: { collection?: Collection; worker?: WorkerResult; gated: { change: Change; verdict: string; reason: string }[] } = { gated: [] };
  let classifierBroken = false;

  const finish = async (report: Omit<RunReport, 'inboxed'> & { inboxed?: number }, cursor = plan.to): Promise<RunReport> => {
    // A cancelled run (shutdown) keeps the cursor, so the next session documents these commits.
    // Anything already committed carries the trailer and is skipped then.
    const cancelled = !!input.signal?.aborted;
    const result: RunReport = cancelled
      ? { status: 'failed', text: `Clio · ${range} · cancelled; will retry on the next run`, inboxed: report.inboxed ?? 0 }
      : { inboxed: 0, ...report };
    if (!cancelled) await git.writeCursor(plan.branch, cursor);
    if (classifier) {
      const { calls, failed, lastError } = classifier.usage;
      result.classifier = { model: classifier.model, calls, failed, lastError };
      const summary = failureSummary(classifier.usage);
      if (summary && !cancelled) {
        // Classifier trouble must always reach the user, never hide behind a quiet notice.
        if (result.status === 'nothing') result.status = 'done';
        result.text += `\nClassifier ${classifier.model}: ${summary}${classifierBroken ? '; nothing was auto-committed, changes went to the inbox. Check it with /clio status --probe' : ''}`;
      }
    }
    const worker = trace.worker;
    if (worker && !config.model && (worker.stop === 'timeout' || worker.stop === 'cost-limit' || worker.nudges.length)) {
      result.text += `\nTip: the worker uses this session's model (${worker.model}, thinking ${worker.thinking}). Set a faster, cheaper "model" and "thinking": "low" in .pi/clio.json.`;
    }
    try {
      const record: RunRecord = {
        version: 1, startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(),
        branch: plan.branch, range, status: result.status, summary: result.text.split('\n')[0],
        session: trace.collection && { considered: trace.collection.considered, kept: trace.collection.windows.length, classified: trace.collection.classified, classifierFailure: trace.collection.classifierFailure },
        classifier: classifier && { model: classifier.model, ...classifier.usage },
        worker: worker && { model: worker.model, thinking: worker.thinking, stop: worker.stop, problem: worker.problem, repaired: worker.repaired, nudges: worker.nudges, usage: worker.usage, requests: worker.requests, tools: worker.tools },
        changes: trace.gated.map(g => ({ path: changePath(g.change), type: g.change.type, verdict: g.verdict, reason: g.reason })),
        committed: result.committed, inboxed: result.inboxed,
      };
      const path = await writeRecord(await git.clioDir(), record);
      const shown = relative(input.root, path);
      result.record = shown.startsWith('..') ? path : shown;
      if (result.status === 'failed' || worker?.nudges.length) result.text += `\nDetails: ${result.record}`;
    } catch { /* the record is a diagnostic aid; never fail a run over it */ }
    return result;
  };

  // 1. Session knowledge, picked by the classifier.
  const windows = buildWindows(input.entries, await git.commitTime(plan.from));
  progress(classifier ? `sorting ${windows.length} session excerpts` : 'reading the session');
  const collection = trace.collection = await collect(windows, classifier, config.classifier, input.signal);
  // A failing classifier is treated as unavailable for the rest of the run: no auto-commits.
  classifierBroken = !!collection.classifierFailure;
  const gateClassifier = classifierBroken ? undefined : classifier;
  const gateUnavailable = collection.classifierFailure
    ? `the classifier is failing (${collection.classifierFailure.error})`
    : unavailable;
  const sessionLine = collection.classified
    ? `session: ${collection.windows.length} of ${collection.considered} excerpts kept`
    : `session: ${collection.windows.length} recent excerpts, unjudged (${collection.classifierFailure ? `classifier failed on ${collection.classifierFailure.failed} of ${collection.classifierFailure.total} excerpts` : unavailable})`;
  if (collection.classified && collection.considered > 0 && collection.windows.length === 0) {
    return finish({ status: 'nothing', text: `Clio · ${range} · nothing worth documenting (${sessionLine}) · ${costLine(undefined, classifier?.usage, Date.now() - started)}` });
  }

  // 2. The worker drafts changes from the commits, the diff and those excerpts.
  progress('drafting');
  const changedPaths = await git.changedPaths(plan.from, plan.to);
  const evidence: Evidence = {
    readDocs: new Map(), readFiles: new Set(), changedPaths: new Set(changedPaths),
    entryIds: new Set(collection.windows.flatMap(w => [...w.entryIds, ...(w.previous?.entryIds ?? [])])),
    commits: plan.commits.map(c => c.sha),
  };
  const task = buildTask({
    from: plan.from, to: plan.to, commits: plan.commits, truncatedRange: plan.truncated,
    diff: await git.diff(plan.from, plan.to), changedPaths, collection,
    docs: await mapDocs(input.root, changedPaths, config),
  }, Math.floor(contextBudget(selectWorker(input.ctx, config).model, config) * 3.5 * 0.35));
  const worker = trace.worker = await runWorker(input.ctx, config, {
    root: input.root, task, evidence,
    onRequest: (request, max) => progress(`drafting, request ${request} of ${max}`),
  }, input.signal);
  if (!worker.proposal) {
    return finish({ status: 'failed', text: `Clio · ${range} · ${worker.problem} · ${costLine(worker, classifier?.usage, Date.now() - started)}\nRetry with /clio --since ${short(plan.from)}` });
  }
  const unresolved = worker.proposal.unresolved.map(u => `Unresolved: ${u}`);
  const changes = changesOf(worker.proposal);
  if (!changes.length) {
    return finish({ status: unresolved.length ? 'done' : 'nothing', text: [`Clio · ${range} · no doc changes needed (${sessionLine}) · ${costLine(worker, classifier?.usage, Date.now() - started)}`, ...unresolved].join('\n') });
  }

  // 3. The classifier grades each change: commit, review or drop.
  progress(`grading ${changes.length} change${changes.length === 1 ? '' : 's'}`);
  const gated = await gate(changes, gateClassifier, config.classifier, gateUnavailable, input.signal);
  trace.gated = gated.map(g => ({ change: g.change, verdict: g.verdict === 'commit' && !config.autoCommit ? 'inbox' : g.verdict, reason: g.verdict === 'commit' && !config.autoCommit ? 'autoCommit is off' : g.reason }));
  const toCommit = config.autoCommit ? gated.filter(g => g.verdict === 'commit') : [];
  const toReview: { change: Change; reason: string }[] = gated
    .filter(g => g.verdict === 'inbox' || (g.verdict === 'commit' && !config.autoCommit))
    .map(g => ({ change: g.change, reason: g.verdict === 'commit' ? 'autoCommit is off' : g.reason }));
  const dropped = gated.filter(g => g.verdict === 'drop');

  // 4. Commit when the main agent is idle, so Clio never races its edits or commits.
  let outcome: ApplyOutcome = { paths: [], deferred: [] };
  let cursor = plan.to;
  if (toCommit.length) {
    progress('waiting for the agent to go idle to commit');
    await input.waitIdle();
    progress('committing');
    const head = await git.head();
    if (head && (head === plan.to || await git.isAncestor(plan.to, head))) {
      outcome = await applyAndCommit(git, input.root, toCommit.map(g => g.change), head, range);
      if (outcome.committed && head === plan.to) cursor = outcome.committed;
    } else {
      outcome.deferred.push(...toCommit.map(g => ({ change: g.change, reason: 'the branch moved to unrelated history' })));
    }
    for (const deferred of outcome.deferred) {
      const entry = trace.gated.find(g => g.change === deferred.change);
      if (entry) { entry.verdict = 'inbox'; entry.reason = deferred.reason; }
    }
  }
  const inbox = new Inbox(await git.clioDir());
  for (const item of [...toReview, ...outcome.deferred]) await inbox.add(range, item.reason, item.change);
  const inboxed = toReview.length + outcome.deferred.length;

  const describe = (g: Pick<GatedChange, 'change'> & { reason: string }) => `${changePath(g.change)} (${g.reason})`;
  const committedChanges = toCommit.filter(g => outcome.paths.includes(changePath(g.change)));
  const head = outcome.committed ? `docs(clio) ${short(outcome.committed)} · ${committedChanges.length} committed` : '0 committed';
  const lines = [
    `Clio · ${range} · ${head} · ${inboxed} to review · ${dropped.length} dropped · ${costLine(worker, classifier?.usage, Date.now() - started)}`,
    ...committedChanges.map(g => `- ${changePath(g.change)}: ${g.change.type === 'edit' ? g.change.edit.value : g.change.create.value}`),
    ...(inboxed ? [`Review with /clio review: ${[...toReview, ...outcome.deferred].map(describe).join('; ')}`] : []),
    ...(dropped.length ? [`Dropped: ${dropped.map(describe).join('; ')}`] : []),
    ...unresolved,
    sessionLine + (worker.repaired ? ' · proposal needed one repair' : '') + (worker.nudges.length ? ` · worker was told to answer early (${worker.nudges.join(', ')})` : ''),
  ];
  return finish({ status: 'done', text: lines.join('\n'), committed: outcome.committed, inboxed }, cursor);
}
