import assert from 'node:assert/strict';
import { createHarness, deferred, bounded, result, log } from './continuation-runtime-probe-harness.mjs';

const release = deferred(), cleanup = deferred(), answered = deferred(), automatic = deferred();
let launched, reply, settled = 0;
const question = 'Exact idle child question: α?';
const h = await createHarness('idle-question-after-settled', {runner: async options => {
  launched = options;
  await release.promise;
  try {
    reply = await options.onQuestion(question, options.signal);
    answered.resolve();
  } finally { await cleanup.promise; }
  return result(options);
}});
try {
  h.control.onSettled = async (_event, ctx) => {
    assert.equal(ctx.isIdle(), true);
    settled++;
    if (h.state.autoResponses === 1) automatic.resolve();
  };
  assert.equal((await h.tool('guild_start', {role: 'reviewer', profile: 'general', task: 'idle child'})).isError, false);
  assert.ok(settled >= 1, 'Native parent agent_settled must precede release');
  assert.equal(h.control.context.isIdle(), true);
  assert.equal(h.state.autoResponses, 0);
  release.resolve();
  // Notification-only wait: no guild_wait, guild_status, prompt, or idle polling starts delivery.
  await bounded(automatic.promise, 'idle automatic response and native settlement');
  assert.equal(h.state.autoResponses, 1);
  assert.equal(h.state.ownedStarts, 1);
  assert.equal(h.control.accepted.length, 1);
  const notices = h.session.sessionManager.getEntries().filter(e => e.type === 'custom_message' && e.customType === 'pi-parent-continuation');
  assert.equal(notices.length, 1);
  const batch = JSON.parse(notices[0].content);
  assert.equal(batch.items.length, 1);
  const item = batch.items[0];
  assert.equal(item.kind, 'question');
  assert.equal(item.runId, launched.runId);
  assert.equal(item.textPreview, question);
  assert.equal(h.session.sessionManager.getEntries().filter(e => e.type === 'custom' && e.data?.kind === 'collected').length, 0);
  const expectedReply = 'Exact reply: β.';
  assert.equal((await h.tool('guild_send', {runId: item.runId, questionId: item.questionId, message: expectedReply})).isError, false);
  await bounded(answered.promise, 'same child reply');
  assert.equal(reply, expectedReply);
  assert.equal(h.state.autoResponses, 1);
  log({phase: 'idle-question', status: 'passed', notices: 1, autoResponses: 1, exactReply: true, pollingTools: 0, nativeSettledBeforeRelease: true});
} finally {
  release.resolve(); cleanup.resolve();
  await h.dispose();
}
