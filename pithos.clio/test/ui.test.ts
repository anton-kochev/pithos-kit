import assert from 'node:assert/strict';
import { test } from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { completion, progressLine } from '../src/ui.ts';

test('compact progress fits width and completion reports only observed changes/problems with honest cost', () => {
  assert.equal(completion({changed: [], uncertain: [], problems: [], documented: []}, 1800, undefined, []), undefined);
  for (const width of [1, 12, 80]) assert.ok(visibleWidth(progressLine('checking evidence', 42000, 'provider/model', 'high', width)) <= width);
  const result = completion({changed: ['README.md'], uncertain: [], problems: ['Unknown rationale'], documented: [0]}, 78000, {model: 'provider/model', thinking: 'high', proposal: {findings: [{claim: 'TTL 30', kind: 'observed', sources: [{path: 'src/cache.ts', startLine: 1, endLine: 1}]}], edits: [], unresolved: []}}, ['src/cache.ts', 'README.md']);
  assert.match(result!, /78s.*cost unknown.*1 findings.*1 files/);
  assert.match(result!, /TTL 30/); assert.match(result!, /src\/cache.ts/); assert.match(result!, /Unknown rationale/);
});
