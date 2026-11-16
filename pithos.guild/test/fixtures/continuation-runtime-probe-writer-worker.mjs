import assert from 'node:assert/strict';
import { createHarness, deferred, bounded, result, log } from './continuation-runtime-probe-harness.mjs';

// Acceptance list: asynchronous writer admission; settled native parent; a second
// editor request answered while work is held; no cancellation; one automatic
// terminal wake; validated writer payload and exactly-once native usage collection.
const release = deferred(), launched = deferred(), secondSettled = deferred(), automatic = deferred();
let options, returned = false, settlements = 0;
const payload = {
  artifacts: [{path: 'draft.md', description: 'Scripted writing artifact claim'}],
  sources: [{reference: 'supplied brief', usage: 'Scope and audience'}],
  checks: [{check: 'Brief coverage', outcome: 'Scripted check claim'}],
};
const h = await createHarness('writer-second-user-request', {runner: async value => {
  options = value; launched.resolve();
  await release.promise;
  returned = true;
  return {...result(value), status: 'completed', activity: 'Completed', usageKnown: true,
    usage: {input: 11, output: 17, cacheRead: 23, cacheWrite: 29, cost: 0.8, contextTokens: 80, turns: 1},
    providerUsage: {input: 11, output: 17, cacheRead: 23, cacheWrite: 29, totalTokens: 80,
      cost: {input: 0.11, output: 0.17, cacheRead: 0.23, cacheWrite: 0.29, total: 0.8}},
    report: {protocol: 'guild/2', version: 2, runId: value.runId, taskId: value.taskId,
      role: value.role, profile: value.profile, taskOutcome: 'succeeded', compliance: [],
      summary: 'Writer finished', blockers: [], limitations: ['In-process scripted runner; no file written'], payload}};
}});
// init() mounts the editor; run() owns dispatch of ordinary submitted requests.
const interaction = h.mode.run();
void interaction.catch(() => {});
const entries = () => h.session.sessionManager.getEntries();
const notices = () => entries().filter(e => e.type === 'custom_message' && e.customType === 'pi-parent-continuation');
const collections = () => entries().filter(e => e.type === 'custom' && e.data?.kind === 'collected');
try {
  h.control.onSettled = async (_event, ctx) => {
    assert.equal(ctx.isIdle(), true);
    settlements++;
    if (h.state.requests.some(r => r.kind === 'ordinary')) secondSettled.resolve();
    if (h.state.autoResponses === 1) automatic.resolve();
  };
  assert.deepEqual([...h.control.writerTools].sort(),
    ['read', 'grep', 'find', 'ls', 'git_read', 'edit', 'write', 'guild_submit_result', 'guild_ask_parent'].sort());
  const start = await h.tool('guild_start', {role: 'writer', profile: 'general', task: 'Write a scoped draft from the supplied brief'});
  assert.equal(start.isError, false);
  await bounded(launched.promise, 'writer launch');
  assert.equal(options.role, 'writer');
  assert.equal(options.profile, 'general');
  assert.ok(settlements >= 1, 'Native parent settled before second user request');
  assert.equal(h.control.context.isIdle(), true);
  assert.equal(returned, false);
  assert.equal(options.signal.aborted, false);

  const text = 'While the writer works, answer this separate user request.';
  h.planOrdinary({label: 'second actual user request', count: 1, matches: context => {
    const last = context.messages.filter(m => m.role === 'user').at(-1);
    return typeof last?.content === 'string' ? last.content === text : last?.content.some(p => p.type === 'text' && p.text === text);
  }});
  h.control.allowAgent = true;
  try {
    h.control.context.ui.setEditorText(text);
    h.terminal.input('\r');
    await bounded(secondSettled.promise, 'second editor request answered and settled');
  } finally { h.control.allowAgent = false; }
  h.assertOrdinaryPlansConsumed();
  assert.equal(h.session.getLastAssistantText(), 'done');
  assert.equal(returned, false, 'Second response must precede child release');
  assert.equal(options.signal.aborted, false, 'Fresh input must not cancel the writer');
  assert.equal(notices().length, 0);
  assert.equal(h.state.autoResponses, 0);

  release.resolve();
  // Only native notification wakes the parent; no prompt/status/wait polling.
  await bounded(automatic.promise, 'writer automatic completion and native settlement');
  assert.equal(options.signal.aborted, false);
  assert.equal(h.state.autoResponses, 1);
  assert.equal(h.state.ownedStarts, 1);
  assert.equal(h.control.accepted.length, 1);
  assert.equal(notices().length, 1);
  const batch = JSON.parse(notices()[0].content);
  assert.equal(batch.items.length, 1);
  assert.equal(batch.items[0].kind, 'terminal');
  assert.equal(batch.items[0].runId, options.runId);
  assert.equal(collections().length, 0);
  assert.equal(h.session.getSessionStats().tokens.total, 0);
  const first = await h.tool('guild_wait', {runId: options.runId, timeoutMs: 0});
  assert.equal(first.isError, false);
  assert.equal(first.details.runs.length, 1);
  assert.equal(first.details.runs[0].status, 'completed');
  assert.equal(first.details.runs[0].reportAvailable, true);
  assert.equal(first.details.guildBackground.runId, options.runId);
  assert.equal(first.details.guildBackground.taskId, options.taskId);
  const reportText = first.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
  assert.match(reportText, /Writer finished/);
  for (const records of Object.values(payload)) for (const record of records)
    for (const value of Object.values(record)) assert.ok(reportText.includes(value), `Collected writer field: ${value}`);
  assert.equal((await h.tool('guild_wait', {runId: options.runId, timeoutMs: 0})).isError, false);
  assert.equal(collections().length, 1);
  assert.equal(h.session.getSessionStats().tokens.total, 80);
  assert.equal(h.session.getSessionStats().cost, 0.8);
  assert.equal(notices().length, 1);
  assert.equal(h.state.autoResponses, 1);
  log({phase: 'writer-second-request', status: 'passed', route: 'editor', childAliveAfterSecondResponse: true,
    notices: 1, autoResponses: 1, collections: 1, tokens: 80, cost: 0.8});
} finally {
  release.resolve();
  await h.dispose();
  await bounded(interaction, 'native input loop stopped');
}
