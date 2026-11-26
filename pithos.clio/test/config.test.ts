import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig } from '../src/config.ts';

test('defaults: auto-commit on, no classifier, budget left to the model size', () => {
  const config = parseConfig({});
  assert.equal(config.autoCommit, true);
  assert.equal(config.classifier, undefined);
  assert.equal(config.maxContextTokens, undefined);
  assert.equal(config.maxCommits, 20);
});

test('classifier block fills its own defaults', () => {
  const config = parseConfig({ classifier: { model: 'openai/gpt-6-luna' } });
  assert.deepEqual(config.classifier, { model: 'openai/gpt-6-luna', collectThreshold: 1, gateThreshold: 1, maxWindows: 8, timeoutMs: 30_000 });
});

test('unknown and malformed fields fail closed with a readable reason', () => {
  assert.throws(() => parseConfig({ maxContextBytes: 120_000 }), /unknown field maxContextBytes/);
  assert.throws(() => parseConfig({ classifier: { model: 'luna' } }), /classifier.model must be provider\/model-id/);
  assert.throws(() => parseConfig({ classifier: { model: 'a/b', collectThreshold: 4 } }), /collectThreshold/);
  assert.throws(() => parseConfig({ autoCommit: 'yes' }), /autoCommit/);
  assert.throws(() => parseConfig({ docsDirs: ['../escape'] }), /docsDirs/);
});

test('maxCostUsd defaults to $0.50 and accepts fractions', () => {
  assert.equal(parseConfig({}).maxCostUsd, 0.5);
  assert.equal(parseConfig({ maxCostUsd: 0.25 }).maxCostUsd, 0.25);
  assert.throws(() => parseConfig({ maxCostUsd: 0 }), /maxCostUsd/);
});
