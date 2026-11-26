import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from '@earendil-works/pi-ai';
import { parseConfig } from '../src/config.ts';
import type { Evidence } from '../src/proposal.ts';
import { addUsage, runWorker } from '../src/worker.ts';
import { fauxWorker, makeRepo } from './helpers.ts';

const evidence = (): Evidence => ({ readDocs: new Map(), readFiles: new Set(), changedPaths: new Set(['src/a.ts']), entryIds: new Set(['u3']), commits: ['a90c9cb1234567890'] });
const proposal = (path = 'README.md') => JSON.stringify({
  edits: [{ path, oldText: 'Intro.', newText: 'Intro. Walkthroughs are versioned JSON documents.', kind: 'decision', value: 'Where walkthrough data lives.', sources: ['entry:u3', 'commit:a90c9cb'] }],
  unresolved: [],
});
const readReadme = fauxAssistantMessage([fauxToolCall('clio_read', { action: 'read', path: 'README.md' })], { stopReason: 'toolUse' });

test('reads the doc, then returns a grounded proposal', async () => {
  const { root } = await makeRepo();
  const { ctx } = fauxWorker([readReadme, fauxAssistantMessage(proposal())]);
  const ev = evidence();
  const result = await runWorker(ctx, parseConfig({}), { root, task: 'task', evidence: ev });
  assert.equal(result.problem, undefined);
  assert.equal(result.proposal?.edits[0].path, 'README.md');
  assert.equal(ev.readDocs.get('README.md'), '# Demo\n\nIntro.\n');
  assert.equal(result.usage.turns, 2);
});

test('regression: a huge reasoning block does not abort the worker (old maxResultBytes bug)', async () => {
  const { root } = await makeRepo();
  const thinking = 'x'.repeat(300_000);
  const { ctx } = fauxWorker([readReadme, fauxAssistantMessage([fauxThinking(thinking), fauxText(proposal())])], { reasoning: true });
  const result = await runWorker(ctx, parseConfig({}), { root, task: 'task', evidence: evidence() });
  assert.equal(result.problem, undefined);
  assert.ok(result.proposal);
});

test('regression: cost is measured even when usage.cost carries extra keys', () => {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 2, measuredTurns: 0 };
  addUsage(total, { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 1200, cost: { input: 0.01, output: 0.004, cacheRead: 0, cacheWrite: 0, total: 0.014, totalFromProvider: false } as never });
  addUsage(total, { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  assert.equal(total.cost, 0.014);
  assert.equal(total.measuredTurns, 1, 'a zero-cost response is unmeasured, not free');
  assert.equal(total.input, 1010);
});

test('one repair turn fixes a rejected proposal', async () => {
  const { root } = await makeRepo({ 'README.md': '# Demo\n\nIntro.\n', 'docs/guide.md': '# Guide\n' });
  const { ctx } = fauxWorker([readReadme, fauxAssistantMessage(proposal('docs/guide.md')), fauxAssistantMessage(proposal('README.md'))]);
  const result = await runWorker(ctx, parseConfig({}), { root, task: 'task', evidence: evidence() });
  assert.equal(result.repaired, true);
  assert.equal(result.proposal?.edits[0].path, 'README.md');
});

test('a proposal that stays invalid after the repair turn is reported, not applied', async () => {
  const { root } = await makeRepo();
  const { ctx } = fauxWorker([fauxAssistantMessage('not json'), fauxAssistantMessage('still not json')]);
  const result = await runWorker(ctx, parseConfig({}), { root, task: 'task', evidence: evidence() });
  assert.equal(result.stop, 'invalid-proposal');
  assert.match(result.problem!, /invalid-proposal/);
});

test('the read tool refuses work near the turn limit, so the worker answers instead of looping', async () => {
  const { root } = await makeRepo();
  const looping = Array.from({ length: 3 }, () => fauxAssistantMessage([fauxToolCall('clio_read', { action: 'list', path: '.' })], { stopReason: 'toolUse' }));
  let lastToolText = '';
  const { ctx } = fauxWorker([...looping, (context: any) => {
    const results = context.messages.filter((m: any) => m.role === 'toolResult');
    lastToolText = results.at(-1)?.content?.[0]?.text ?? '';
    return fauxAssistantMessage('{"edits":[],"unresolved":[]}');
  }]);
  const result = await runWorker(ctx, parseConfig({ maxTurns: 4 }), { root, task: 'task', evidence: evidence() });
  assert.match(lastToolText, /Turn limit reached/);
  assert.deepEqual(result.proposal?.edits, []);
});

test('reads outside the project or into hidden paths are refused with a reason, not a crash', async () => {
  const { root } = await makeRepo();
  let toolText = '';
  const { ctx } = fauxWorker([
    fauxAssistantMessage([fauxToolCall('clio_read', { action: 'read', path: '../etc/passwd' })], { stopReason: 'toolUse' }),
    (context: any) => { toolText = context.messages.filter((m: any) => m.role === 'toolResult').at(-1).content[0].text; return fauxAssistantMessage('{"edits":[],"unresolved":[]}'); },
  ]);
  const result = await runWorker(ctx, parseConfig({}), { root, task: 'task', evidence: evidence() });
  assert.match(toolText, /Could not read \.\.\/etc\/passwd/);
  assert.ok(result.proposal);
});

test('cancellation stops the worker and says so', async () => {
  const { root } = await makeRepo();
  const controller = new AbortController();
  const { ctx } = fauxWorker([() => { controller.abort(); return fauxAssistantMessage('{"edits":[],"unresolved":[]}'); }]);
  const result = await runWorker(ctx, parseConfig({}), { root, task: 'task', evidence: evidence() }, controller.signal);
  assert.equal(result.stop, 'cancelled');
});
