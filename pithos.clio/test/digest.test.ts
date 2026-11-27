import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTask, mapDocs } from '../src/digest.ts';
import { parseConfig } from '../src/config.ts';
import { globToRegExp, isEditableDoc } from '../src/paths.ts';
import { makeRepo } from './helpers.ts';

test('the docs map lists ADRs as read-only context and never offers their directory for new pages', async () => {
  const { root } = await makeRepo({
    'README.md': '# Demo\n', 'docs/guide.md': '# Guide\n', 'docs/adr/0001-records.md': '# ADR 1\n',
    'docs/adr/0002-scope.md': '# ADR 2\n', 'backend/go/README.md': '# Go\n', 'backend/go/item.go': 'package main\n',
  });
  const docs = await mapDocs(root, ['backend/go/item.go'], parseConfig({}));
  assert.deepEqual(docs.nearby, ['README.md', 'backend/go/README.md']);
  assert.deepEqual(docs.pages, ['docs/guide.md']);
  assert.deepEqual(docs.readOnly, ['docs/adr/0001-records.md', 'docs/adr/0002-scope.md']);
  assert.deepEqual(docs.directories, ['docs']);
  const task = buildTask({ from: 'a'.repeat(40), to: 'b'.repeat(40), commits: [], truncatedRange: false, diff: '', changedPaths: [], collection: { windows: [], considered: 0, classified: false }, docs }, 10_000);
  assert.match(task, /Read-only records, for context only \(never edit them or add pages next to them\): docs\/adr\/0001-records\.md, docs\/adr\/0002-scope\.md/);

  const open = await mapDocs(root, ['backend/go/item.go'], parseConfig({ readOnlyDocs: [] }));
  assert.deepEqual(open.readOnly, []);
  assert.deepEqual(open.directories, ['docs', 'docs/adr']);
});

test('globs: ** spans directories, * and ? stay inside one', () => {
  assert.ok(globToRegExp('**/adr/**').test('adr/x.md'));
  assert.ok(globToRegExp('**/adr/**').test('services/api/adr/x.md'));
  assert.ok(!globToRegExp('**/adr/**').test('docs/adrs/x.md'));
  assert.ok(globToRegExp('docs/*.md').test('docs/a.md'));
  assert.ok(!globToRegExp('docs/*.md').test('docs/x/a.md'));
  assert.ok(!globToRegExp('a.b?.md').test('aXbc.md'), 'dots are literal');
  assert.equal(isEditableDoc('docs/adr/0001.md', { docsDirs: [], readOnlyDocs: ['**/adr/**'] }), false);
});
