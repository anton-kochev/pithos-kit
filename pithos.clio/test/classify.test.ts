import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeError, failureSummary, probeClassifier, resolveClassifier, WINDOW_QUESTIONS } from '../src/classify.ts';

const config = { model: 'openai/gpt-6-luna', collectThreshold: 1, gateThreshold: 1, maxWindows: 8, timeoutMs: 200 };
const registry = (classify: (...args: any[]) => Promise<unknown>) => ({ findOfType: () => ({ id: 'luna' }), classify });
const ok = { stopReason: 'stop', answers: { kind: { type: 'choice', choice: 'decision', confidence: 0.7 }, value: { type: 'score', score: 2, confidence: 0.6 } } };

test('unconfigured, missing API and unregistered models are explained', () => {
  assert.equal((resolveClassifier({}, undefined) as { unavailable: string }).unavailable, 'no classifier configured');
  assert.equal((resolveClassifier({}, config) as { unavailable: string }).unavailable, 'this Pi has no classifier API');
  assert.match((resolveClassifier({ findOfType: () => undefined, classify: async () => ok }, config) as { unavailable: string }).unavailable, /openai\/gpt-6-luna is not registered/);
});

test('a provider error is counted and its reason kept, without URLs or credentials', async () => {
  const resolution = resolveClassifier(registry(async () => ({ stopReason: 'error', errorMessage: '401 no_matching_rule: see https://platform.example/docs\napi_key=sk-abcdefghijklmnop1234' })), config);
  const classifier = resolution.classifier!;
  assert.equal(await classifier.judge({ user: 'x' }, WINDOW_QUESTIONS), undefined);
  assert.equal(classifier.usage.failed, 1);
  assert.match(classifier.usage.lastError!, /^error: 401 no_matching_rule/);
  assert.doesNotMatch(classifier.usage.lastError!, /https?:|sk-/);
  assert.equal(failureSummary(classifier.usage), `1 of 1 classifier calls failed (last: ${classifier.usage.lastError})`);
});

test('a throwing call, a malformed answer and a hanging call each fail with a reason', async () => {
  const throwing = resolveClassifier(registry(async () => { throw new Error('socket hang up'); }), config).classifier!;
  await throwing.judge({}, WINDOW_QUESTIONS);
  assert.equal(throwing.usage.lastError, 'socket hang up');

  const malformed = resolveClassifier(registry(async () => ({ stopReason: 'stop', answers: {} })), config).classifier!;
  await malformed.judge({}, WINDOW_QUESTIONS);
  assert.match(malformed.usage.lastError!, /unexpected shape/);

  const hanging = resolveClassifier(registry(() => new Promise(() => {})), config).classifier!;
  assert.equal(await hanging.judge({}, WINDOW_QUESTIONS), undefined);
  assert.equal(hanging.usage.lastError, 'timed out after 200 ms');
});

test('a healthy classifier reports no failures', async () => {
  const classifier = resolveClassifier(registry(async () => ok), config).classifier!;
  assert.deepEqual(await classifier.judge({}, WINDOW_QUESTIONS), { kind: 'decision', kindConfidence: 0.7, score: 2, scoreConfidence: 0.6 });
  assert.equal(failureSummary(classifier.usage), undefined);
});

test('the probe says whether the classifier answers right now, and why not', async () => {
  assert.equal((await probeClassifier(resolveClassifier(registry(async () => ok), config).classifier!)).ok, true);
  const failed = await probeClassifier(resolveClassifier(registry(async () => ({ stopReason: 'error', errorMessage: '401 no_matching_rule' })), config).classifier!);
  assert.equal(failed.ok, false);
  assert.match(failed.ok ? '' : failed.error, /401 no_matching_rule/);
});

test('describeError keeps one short safe line', () => {
  assert.equal(describeError(new Error('\n\nfirst line\nsecond')), 'first line');
  assert.equal(describeError('x'.repeat(500)).length, 200);
  assert.equal(describeError(undefined), 'unknown error');
});
