import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { probeClassifier, resolveClassifier, type Resolution } from '../src/classify.ts';
import { applyAndCommit } from '../src/commit.ts';
import { loadConfig } from '../src/config.ts';
import { changePath } from '../src/gate.ts';
import { Git } from '../src/git.ts';
import { Inbox, type InboxItem } from '../src/inbox.ts';
import { runCapture, type RunReport } from '../src/pipeline.ts';

export const HELP = `Usage: /clio [--since <rev>] | /clio review | /clio undo [--yes] | /clio status [--probe] | /clio --help

Clio documents committed work in the background. After the agent settles and the branch has new
commits, it reads the commits, the diff and the session, drafts doc updates, and commits the good
ones as their own "docs(clio):" commit. Changes it is unsure about wait in the inbox.

  /clio                 capture new commits now
  /clio --since <rev>   capture <rev>..HEAD, for example to retry a failed run
  /clio review          apply or drop the changes waiting in the inbox
  /clio undo [--yes]    revert Clio's most recent docs commit
  /clio status          show the cursor, classifier health, inbox and last run
  /clio status --probe  also make one tiny classifier call to test the model and its credentials`;

const IDLE_POLL_MS = 1_000;
const IDLE_LIMIT_MS = 15 * 60_000;

/** Plan's persisted state: an active (or malformed) Plan blocks automatic runs. */
export function planInactive(entries: readonly unknown[]): boolean {
  for (const raw of [...entries].reverse()) {
    const entry = raw as { type?: string; customType?: string; data?: { active?: unknown } } | null;
    if (entry?.type === 'custom' && entry.customType === 'plan-theme-state') return entry.data?.active === false;
  }
  return true;
}

function eligible(ctx: ExtensionContext): string | undefined {
  if (!ctx.isProjectTrusted()) return 'the project is not trusted';
  if (ctx.sessionManager.getHeader()?.parentSession) return 'this is a child session';
  if (!planInactive(ctx.sessionManager.getBranch())) return 'Plan is active';
}

function preview(item: InboxItem): string {
  const lines = item.change.type === 'edit'
    ? [...item.change.edit.oldText.split('\n').map(l => `- ${l}`), ...item.change.edit.newText.split('\n').map(l => `+ ${l}`)]
    : item.change.create.content.split('\n').map(l => `+ ${l}`);
  const purpose = item.change.type === 'edit' ? item.change.edit.value : item.change.create.value;
  const shown = lines.slice(0, 40);
  return [`${changePath(item.change)} · ${item.reason}`, `Why: ${purpose}`, '', ...shown, ...(lines.length > shown.length ? [`… ${lines.length - shown.length} more lines`] : [])].join('\n');
}

export default function clio(pi: ExtensionAPI) {
  let running: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let again = false;
  let lastReport: RunReport | undefined;

  const git = (ctx: ExtensionContext) => new Git((command, args, options) => pi.exec(command, args, options), ctx.cwd);

  let lastFailure: string | undefined;
  const post = (ctx: ExtensionContext, report: RunReport) => {
    if (report.status === 'failed' && report.text === lastFailure) return;
    lastFailure = report.status === 'failed' ? report.text : undefined;
    // "Nothing worth documenting" is a passing notice, not something to keep in the session.
    if (report.status === 'nothing') { if (ctx.hasUI) ctx.ui.notify(report.text, 'info'); return; }
    try {
      const message = { customType: 'clio-result', content: report.text, display: true };
      if (ctx.isIdle()) pi.sendMessage(message);
      else { pi.sendMessage(message, { deliverAs: 'nextTurn' }); if (ctx.hasUI) ctx.ui.notify(report.text.split('\n')[0], 'info'); }
    } catch { /* the session may be gone; the commit and inbox are the record */ }
  };

  const waitIdle = (ctx: ExtensionContext, signal: AbortSignal) => async () => {
    const deadline = Date.now() + IDLE_LIMIT_MS;
    while (!(ctx.isIdle() && !ctx.hasPendingMessages())) {
      signal.throwIfAborted();
      if (Date.now() > deadline) throw new Error('the agent stayed busy for 15 minutes');
      await new Promise(resolve => setTimeout(resolve, IDLE_POLL_MS));
    }
  };

  const capture = async (ctx: ExtensionContext, since?: string): Promise<RunReport> => {
    controller = new AbortController();
    const signal = controller.signal;
    try {
      const repo = git(ctx);
      if (!(await repo.isRepository())) return { status: 'none', text: 'Clio · not a git repository', inboxed: 0 };
      const config = await loadConfig(ctx.cwd);
      const report = await runCapture({
        git: repo, root: ctx.cwd, ctx, entries: ctx.sessionManager.getBranch(), config, signal, waitIdle: waitIdle(ctx, signal), since,
      });
      lastReport = report;
      return report;
    } catch (error) {
      const report: RunReport = { status: 'failed', text: `Clio · failed: ${error instanceof Error ? error.message : String(error)}`, inboxed: 0 };
      lastReport = report;
      return report;
    } finally {
      controller = undefined;
    }
  };

  /** One line on the classifier: configured or not, how the last run went, and an optional live probe. */
  const classifierStatus = async (resolution: Resolution | undefined, probe: boolean): Promise<string> => {
    if (!resolution) return 'Classifier: - (fix the config first)';
    if (!resolution.classifier) return `Classifier: unavailable (${resolution.unavailable}); nothing is auto-committed, every change goes to the inbox`;
    const { model } = resolution.classifier;
    const last = lastReport?.classifier?.model === model ? lastReport.classifier : undefined;
    const parts = [`Classifier: ${model}`];
    if (!last) parts.push('not used yet in this session');
    else if (last.failed) parts.push(`last run: ${last.failed} of ${last.calls} calls failed (last: ${last.lastError ?? 'unknown'})`);
    else parts.push(`last run: ${last.calls} calls ok`);
    if (probe) {
      const result = await probeClassifier(resolution.classifier);
      parts.push(result.ok ? `probe ok (${result.ms} ms)` : `probe FAILED: ${result.error}`);
    } else if (!last || last.failed) {
      parts.push('test it with /clio status --probe');
    }
    return parts.join(' · ');
  };

  /** One background run at a time; triggers during a run fold into one follow-up run. */
  const trigger = (ctx: ExtensionContext) => {
    if (running) { again = true; return; }
    running = (async () => {
      do {
        again = false;
        const report = await capture(ctx);
        if (report.status !== 'none') post(ctx, report);
      } while (again);
    })().finally(() => { running = undefined; });
  };

  pi.on('agent_settled', (_event, ctx) => {
    if (!eligible(ctx)) trigger(ctx);
  });
  pi.on('session_shutdown', async () => {
    controller?.abort();
    await running?.catch(() => {});
  });

  pi.registerCommand('clio', {
    description: 'Clio: document committed work (run, review, undo, status, --help)',
    getArgumentCompletions: prefix => ['review', 'undo', 'status', 'status --probe', '--since', '--help']
      .filter(option => option.startsWith(prefix)).map(value => ({ value, label: value })),
    handler: async (args, ctx) => {
      const words = args.trim().split(/\s+/).filter(Boolean);
      const [first] = words;
      const say = (text: string) => pi.sendMessage({ customType: 'clio-result', content: text, display: true });

      if (first === '--help' || first === '-h' || first === 'help') return say(HELP);

      if (first === 'status') {
        const repo = git(ctx);
        if (!(await repo.isRepository())) return say('Clio · not a git repository');
        const config = await loadConfig(ctx.cwd).catch(error => error as Error);
        const branch = await repo.branch();
        const cursor = branch ? await repo.readCursor(branch) : undefined;
        const head = await repo.head();
        const inbox = await new Inbox(await repo.clioDir()).list();
        const resolution = config instanceof Error ? undefined : resolveClassifier(ctx.modelRegistry, config.classifier);
        return say([
          `Clio status · branch ${branch ?? '(detached)'} · HEAD ${head?.slice(0, 7) ?? '-'} · cursor ${cursor?.slice(0, 7) ?? '(none yet)'}`,
          config instanceof Error ? `Config: ${config.message}` : `Config: autoCommit ${config.autoCommit ? 'on' : 'off'} · worker ${config.model ?? 'session model'}`,
          await classifierStatus(resolution, words.includes('--probe')),
          `Inbox: ${inbox.length} waiting${inbox.length ? ' (/clio review)' : ''}`,
          `Automatic runs: ${eligible(ctx) ? `off here (${eligible(ctx)})` : 'on'}${running ? ' · a run is in progress' : ''}`,
          `Last run: ${lastReport ? lastReport.text.split('\n')[0] : 'none in this session'}`,
        ].join('\n'));
      }

      if (first === 'review') {
        const repo = git(ctx);
        const inbox = new Inbox(await repo.clioDir());
        const items = await inbox.list();
        if (!items.length) return say('Clio · the inbox is empty');
        if (!ctx.hasUI) return say([`Clio inbox · ${items.length} waiting (review needs the TUI):`, ...items.map(i => `- ${changePath(i.change)}: ${i.reason}`)].join('\n'));
        for (const [index, item] of items.entries()) {
          const choice = await ctx.ui.select(`Clio inbox ${index + 1}/${items.length}\n\n${preview(item)}`, ['Commit it', 'Drop it', 'Skip', 'Stop']);
          if (!choice || choice === 'Stop') break;
          if (choice === 'Skip') continue;
          if (choice === 'Drop it') { await inbox.remove(item.id); continue; }
          const head = await repo.head();
          if (!head) { ctx.ui.notify('Clio: the branch has no commits', 'error'); break; }
          const outcome = await applyAndCommit(repo, ctx.cwd, [item.change], head, `review ${item.range}`);
          if (outcome.committed) {
            await inbox.remove(item.id);
            ctx.ui.notify(`Clio: committed ${changePath(item.change)} as ${outcome.committed.slice(0, 7)}`, 'info');
          } else {
            ctx.ui.notify(`Clio: not committed, ${outcome.deferred[0]?.reason ?? 'unknown reason'}`, 'warning');
          }
        }
        return;
      }

      if (first === 'undo') {
        const repo = git(ctx);
        const last = await repo.lastClioCommit();
        if (!last) return say('Clio · no Clio commit in the last 50 commits');
        const confirmed = words.includes('--yes') || (ctx.hasUI && await ctx.ui.confirm('Revert Clio commit?', `${last.sha.slice(0, 7)} ${last.subject}`));
        if (!confirmed) return say(ctx.hasUI ? 'Clio · undo cancelled' : 'Clio · run /clio undo --yes to revert without a prompt');
        try {
          const revert = await repo.revert(last.sha);
          return say(`Clio · reverted ${last.sha.slice(0, 7)} with ${revert.slice(0, 7)}`);
        } catch (error) {
          return say(`Clio · undo failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (first && first !== '--since') return say(`Clio · unknown argument "${first}"\n\n${HELP}`);
      if (running) return say('Clio · a run is already in progress; check /clio status');
      const since = first === '--since' ? words[1] : undefined;
      if (first === '--since' && !since) return say('Clio · --since needs a revision, for example /clio --since HEAD~3');
      let sinceSha: string | undefined;
      if (since) {
        sinceSha = (await git(ctx).tryRun(['rev-parse', '--verify', '--quiet', `${since}^{commit}`]))?.trim();
        if (!sinceSha) return say(`Clio · unknown revision ${since}`);
      }
      ctx.ui.notify('Clio: capturing…', 'info');
      running = capture(ctx, sinceSha).then(report => say(report.text)).finally(() => { running = undefined; });
      await running;
    },
  });
}
