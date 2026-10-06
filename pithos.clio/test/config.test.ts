import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig } from '../src/config.ts';

test('strict config defaults to inheritance and finite capture budgets', () => {
  const config = parseConfig({});
  assert.equal(config.model, undefined);
  assert.equal(config.thinking, undefined);
  assert.equal(config.timeoutMs, 180_000);
  assert.equal(config.maxTurns, 20);
  assert.deepEqual(parseConfig({model: 'provider/model/variant', thinking: 'high', docsDirs: ['handbook']}).docsDirs, ['handbook']);
  for (const invalid of [null, [], {enabled: true}, {model: 'bad'}, {thinking: 'auto'}, {maxTurns: 0}, {timeoutMs: Infinity}, {maxContextBytes: 1e9}, {docsDirs: ['../secrets']}, {docsDirs: ['.pi']}, {maxEdits: 1.5}, {timeoutMs: null}, {docsDirs: null}]) {
    assert.throws(() => parseConfig(invalid), /Clio config/);
  }
});
