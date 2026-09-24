import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { snapshotCore } from '../src/grading-snapshot-core.ts';

test('snapshot core rejects expired shared deadline before reconstruction', async () => {
  await assert.rejects(snapshotCore(new Map(), 'a'.repeat(64), undefined, Date.now() - 1), /deadline/);
});
test('snapshot public core has no owner, fixture, comparator or bank imports', async () => {
  const source = await readFile(new URL('../src/grading-snapshot-core.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"]\.\//);
});
