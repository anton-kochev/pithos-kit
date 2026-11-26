import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { parseConfig } from '../src/config.ts';
import { Inbox } from '../src/inbox.ts';
import { isClioMessage } from '../src/git.ts';
import { runCapture } from '../src/pipeline.ts';
import { fauxWorker, makeRepo } from './helpers.ts';

// Built after the repo's commits: Clio ignores talk from before the capture range.
const now = () => new Date().toISOString();
const makeSession = () => [
  { type: 'message', id: 'a1', timestamp: now(), message: { role: 'assistant', content: [{ type: 'text', text: 'I would store each walkthrough as one versioned JSON document.' }] } },
  { type: 'message', id: 'u1', timestamp: now(), message: { role: 'user', content: [{ type: 'text', text: 'Yes, do it.' }] } },
  { type: 'message', id: 'a2', timestamp: now(), message: { role: 'assistant', content: [{ type: 'text', text: 'Done; tests pass.' }] } },
  { type: 'message', id: 'u2', timestamp: now(), message: { role: 'user', content: [{ type: 'text', text: 'thanks' }] } },
];

/** A model registry with a classifier: windows/edits are judged by simple text rules. */
function withClassifier(ctx: ReturnType<typeof fauxWorker>['ctx'], rules: { window: (s: any) => [string, number]; edit: (s: any) => [string, number] }) {
  const calls = { count: 0 };
  const registry = {
    ...(ctx.modelRegistry as object),
    findOfType: (type: string) => type === 'classifier' ? { id: 'stub' } : undefined,
    classify: async (_model: unknown, { state }: { state: Record<string, unknown> }) => {
      calls.count++;
      const [kind, score] = 'file' in state ? rules.edit(state) : rules.window(state);
      return { stopReason: 'stop', answers: { kind: { type: 'choice', choice: kind, confidence: 0.6, probabilities: {} }, value: { type: 'score', score, confidence: 0.6 } }, usage: { input: 10, output: 0, cost: { total: 0.0001 } } };
    },
  };
  return { ctx: { ...ctx, modelRegistry: registry as never }, calls };
}

const proposal = JSON.stringify({
  edits: [{ path: 'README.md', oldText: 'Intro.', newText: 'Intro.\n\nEach walkthrough is one versioned JSON document.', kind: 'decision', value: 'Where walkthrough data lives.', sources: ['entry:u1'] }],
  unresolved: ['The source link targets the first match in the file, which can be the wrong function.'],
});
const readThenPropose = [
  fauxAssistantMessage([fauxToolCall('clio_read', { action: 'read', path: 'README.md' })], { stopReason: 'toolUse' }),
  fauxAssistantMessage(proposal),
];
const classifierConfig = { classifier: { model: 'stub/classifier' } };

async function repoWithNewCommit() {
  const repo = await makeRepo({ 'README.md': '# Guide\n\nIntro.\n', 'src/flow.js': 'export const steps = [];\n' });
  const base = (await repo.git.head())!;
  await repo.git.writeCursor('main', base);
  await repo.write('src/flow.json', '{"version":1,"steps":[]}\n');
  const feature = await repo.commit('feat(guide): define walkthroughs in versioned json');
  return { ...repo, base, feature, session: makeSession() };
}

test('end to end: a useful decision becomes its own docs(clio) commit, and the next run has nothing to do', async () => {
  const { root, git, feature, session } = await repoWithNewCommit();
  const { ctx } = withClassifier(fauxWorker(readThenPropose).ctx, {
    window: s => s.user === 'Yes, do it.' ? ['decision', 1.9] : ['chatter', 0.1],
    edit: () => ['decision', 1.8],
  });
  const report = await runCapture({ git, root, ctx, entries: session, config: parseConfig(classifierConfig), waitIdle: async () => {} });
  assert.equal(report.status, 'done', report.text);
  assert.ok(report.committed);
  assert.ok(isClioMessage(await git.message(report.committed!)));
  assert.equal(await git.parent(report.committed!), feature);
  assert.match(await readFile(join(root, 'README.md'), 'utf8'), /versioned JSON document/);
  assert.match(report.text, /1 committed/);
  assert.match(report.text, /Unresolved: The source link/);
  assert.match(report.text, /session: 1 of 2 excerpts kept/);
  assert.equal(await git.readCursor('main'), report.committed, 'cursor moves past Clio\'s own commit');
  const again = await runCapture({ git, root, ctx, entries: session, config: parseConfig(classifierConfig), waitIdle: async () => {} });
  assert.equal(again.status, 'none');
});

test('when the classifier finds nothing worth keeping, the worker never runs', async () => {
  const { root, git, feature, session } = await repoWithNewCommit();
  const faux = fauxWorker(readThenPropose);
  const { ctx } = withClassifier(faux.ctx, { window: () => ['status-report', 2.0], edit: () => ['decision', 2] });
  const report = await runCapture({ git, root, ctx, entries: session, config: parseConfig(classifierConfig), waitIdle: async () => {} });
  assert.equal(report.status, 'nothing');
  assert.equal(faux.core.state.callCount, 0);
  assert.equal(await git.readCursor('main'), feature);
});

test('without a classifier nothing is auto-committed: the change waits in the inbox', async () => {
  const { root, git, feature, session } = await repoWithNewCommit();
  const { ctx } = fauxWorker(readThenPropose);
  const report = await runCapture({ git, root, ctx, entries: session, config: parseConfig({}), waitIdle: async () => {} });
  assert.equal(report.committed, undefined);
  assert.equal(report.inboxed, 1);
  assert.equal(await git.head(), feature);
  const items = await new Inbox(await git.clioDir()).list();
  assert.equal(items.length, 1);
  assert.match(items[0].reason, /no classifier configured/);
  assert.match(report.text, /unjudged/);
});

test('autoCommit off sends even good changes to the inbox', async () => {
  const { root, git, session } = await repoWithNewCommit();
  const { ctx } = withClassifier(fauxWorker(readThenPropose).ctx, { window: () => ['decision', 2], edit: () => ['decision', 2] });
  const report = await runCapture({ git, root, ctx, entries: session, config: parseConfig({ ...classifierConfig, autoCommit: false }), waitIdle: async () => {} });
  assert.equal(report.committed, undefined);
  assert.equal(report.inboxed, 1);
});

test('test narration is dropped by the gate, never committed or queued', async () => {
  const { root, git, feature, session } = await repoWithNewCommit();
  const { ctx } = withClassifier(fauxWorker(readThenPropose).ctx, { window: () => ['decision', 2], edit: () => ['test-narration', 2.4] });
  const report = await runCapture({ git, root, ctx, entries: session, config: parseConfig(classifierConfig), waitIdle: async () => {} });
  assert.equal(report.committed, undefined);
  assert.equal(report.inboxed, 0);
  assert.match(report.text, /1 dropped/);
  assert.equal(await git.head(), feature);
});

test('a failed worker run advances the cursor and says how to retry', async () => {
  const { root, git, base, feature, session } = await repoWithNewCommit();
  const { ctx } = withClassifier(fauxWorker([fauxAssistantMessage('nope'), fauxAssistantMessage('still nope')]).ctx, { window: () => ['decision', 2], edit: () => ['decision', 2] });
  const report = await runCapture({ git, root, ctx, entries: session, config: parseConfig(classifierConfig), waitIdle: async () => {} });
  assert.equal(report.status, 'failed');
  assert.match(report.text, new RegExp(`/clio --since ${base.slice(0, 7)}`));
  assert.equal(await git.readCursor('main'), feature);
});

test('a cancelled run (for example at shutdown) keeps the cursor, so the commits are not lost', async () => {
  const { root, git, base, session } = await repoWithNewCommit();
  const controller = new AbortController();
  const { ctx } = withClassifier(fauxWorker(readThenPropose).ctx, { window: () => { controller.abort(); return ['decision', 2]; }, edit: () => ['decision', 2] });
  const report = await runCapture({ git, root, ctx, entries: session, config: parseConfig(classifierConfig), waitIdle: async () => {}, signal: controller.signal });
  assert.equal(report.status, 'failed');
  assert.match(report.text, /cancelled/);
  assert.equal(await git.readCursor('main'), base);
});

test('a broken classifier credential is reported loudly; the worker still runs and changes wait in the inbox', async () => {
  const { root, git, feature, session } = await repoWithNewCommit();
  const faux = fauxWorker(readThenPropose);
  const ctx = { ...faux.ctx, modelRegistry: { ...(faux.ctx.modelRegistry as object), findOfType: () => ({ id: 'luna' }), classify: async () => ({ stopReason: 'error', errorMessage: '401 no_matching_rule' }) } as never };
  const report = await runCapture({ git, root, ctx, entries: session, config: parseConfig(classifierConfig), waitIdle: async () => {} });
  assert.equal(report.status, 'done');
  assert.equal(faux.core.state.callCount, 2, 'the worker ran despite the classifier');
  assert.equal(report.committed, undefined, 'nothing is auto-committed with a failing classifier');
  assert.equal(report.inboxed, 1);
  assert.match(report.text, /classifier failed on 2 of 2 excerpts/);
  assert.match(report.text, /Classifier stub\/classifier: 2 of 2 classifier calls failed \(last: error: 401 no_matching_rule\); nothing was auto-committed/);
  assert.match(report.text, /\/clio status --probe/);
  const items = await new Inbox(await git.clioDir()).list();
  assert.match(items[0].reason, /the classifier is failing \(error: 401 no_matching_rule\)/);
  assert.deepEqual(report.classifier, { model: 'stub/classifier', calls: 2, failed: 2, lastError: 'error: 401 no_matching_rule' });
  assert.equal(await git.readCursor('main'), feature);
});

test('even a few failed classifier calls turn a quiet "nothing" into a visible report', async () => {
  const { root, git, session } = await repoWithNewCommit();
  let calls = 0;
  const faux = fauxWorker(readThenPropose);
  const ctx = { ...faux.ctx, modelRegistry: { ...(faux.ctx.modelRegistry as object), findOfType: () => ({ id: 'luna' }), classify: async () => (++calls === 1
    ? { stopReason: 'error', errorMessage: '429 rate limited' }
    : { stopReason: 'stop', answers: { kind: { type: 'choice', choice: 'chatter', confidence: 0.9 }, value: { type: 'score', score: 0.1, confidence: 0.9 } } }) } as never };
  const report = await runCapture({ git, root, ctx, entries: session, config: parseConfig(classifierConfig), waitIdle: async () => {} });
  assert.equal(report.status, 'done');
  assert.match(report.text, /nothing worth documenting/);
  assert.match(report.text, /1 of 2 classifier calls failed \(last: error: 429 rate limited\)/);
  assert.equal(faux.core.state.callCount, 0);
});

test('progress steps are reported in order, and every capture leaves a run record without contents', async () => {
  const { root, git, session } = await repoWithNewCommit();
  const steps: string[] = [];
  const { ctx } = withClassifier(fauxWorker(readThenPropose).ctx, { window: s => s.user === 'Yes, do it.' ? ['decision', 1.9] : ['chatter', 0.1], edit: () => ['decision', 1.8] });
  const report = await runCapture({ git, root, ctx, entries: session, config: parseConfig(classifierConfig), waitIdle: async () => {}, onProgress: step => steps.push(step) });
  assert.deepEqual(steps, ['sorting 2 session excerpts', 'drafting', 'drafting, request 1 of 16', 'drafting, request 2 of 16', 'grading 1 change', 'waiting for the agent to go idle to commit', 'committing']);
  assert.ok(report.record?.startsWith('.git/clio/runs/'), report.record);
  const record = JSON.parse(await readFile(join(root, report.record!), 'utf8'));
  assert.equal(record.status, 'done');
  assert.equal(record.committed, report.committed);
  assert.deepEqual(record.session, { considered: 2, kept: 1, classified: true });
  assert.deepEqual(record.changes, [{ path: 'README.md', type: 'edit', verdict: 'commit', reason: 'decision, score 1.80' }]);
  assert.equal(record.worker.requests.length, 2);
  const raw = JSON.stringify(record);
  assert.ok(!raw.includes('Yes, do it.') && !raw.includes('versioned JSON document'), 'no session text or doc content in the record');
});

test('a worker stopped by its cost limit points at the record and at a cheaper worker model', async () => {
  const { root, git, session } = await repoWithNewCommit();
  const list = () => fauxAssistantMessage([fauxToolCall('clio_read', { action: 'list', path: '.' })], { stopReason: 'toolUse' });
  const { ctx } = withClassifier(fauxWorker([list(), list()], { costPerRequest: 1 }).ctx, { window: () => ['decision', 2], edit: () => ['decision', 2] });
  const report = await runCapture({ git, root, ctx, entries: session, config: parseConfig({ ...classifierConfig, maxCostUsd: 0.5 }), waitIdle: async () => {} });
  assert.equal(report.status, 'failed');
  assert.match(report.text, /worker stopped \(cost-limit at \$0\.75\)/);
  assert.match(report.text, /Tip: the worker uses this session's model \(clio-test\/worker, thinking off\)/);
  assert.match(report.text, /Details: \.git\/clio\/runs\//);
});
