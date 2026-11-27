import assert from 'node:assert/strict';
import { test } from 'node:test';
import { USEFUL_EDIT_KINDS } from '../src/classify.ts';
import { extractJson, ProposalSchema, ProposalError, validateProposal, type Evidence } from '../src/proposal.ts';

const config = { docsDirs: [], readOnlyDocs: ['**/adr/**'], maxEdits: 6 };
const evidence = (): Evidence => ({
  readDocs: new Map([['README.md', '# Demo\n\nIntro.\n'], ['docs/guide.md', '# Guide\n\nStep one.\n']]),
  readFiles: new Set(['README.md', 'docs/guide.md', 'src/a.ts']),
  changedPaths: new Set(['src/a.ts']),
  entryIds: new Set(['u3']),
  commits: ['a90c9cb1234567890'],
});
const edit = (overrides: Record<string, unknown> = {}) => ({
  path: 'README.md', oldText: 'Intro.', newText: 'Intro. Walkthroughs are JSON documents.', kind: 'decision',
  value: 'Explains where walkthrough data lives.', sources: ['entry:u3', 'commit:a90c9cb'], ...overrides,
});
const problems = (raw: unknown) => {
  try { validateProposal(raw, evidence(), config); return []; } catch (error) { return (error as ProposalError).problems; }
};

test('a grounded edit of a doc the worker read is accepted', () => {
  const proposal = validateProposal({ edits: [edit()], unresolved: [] }, evidence(), config);
  assert.equal(proposal.edits.length, 1);
});

test('the JSON is found even inside a code fence', () => {
  assert.deepEqual(extractJson('```json\n{"edits":[],"unresolved":[]}\n```'), { edits: [], unresolved: [] });
  assert.throws(() => extractJson('no json here'), ProposalError);
});

test('edits must target docs the worker actually read, with an exact unique oldText', () => {
  assert.match(problems({ edits: [edit({ path: 'src/a.ts' })], unresolved: [] })[0], /only README.md files and Markdown under docs/);
  assert.match(problems({ edits: [edit({ path: 'docs/other.md' })], unresolved: [] })[0], /read the whole file/);
  assert.match(problems({ edits: [edit({ oldText: 'Missing.' })], unresolved: [] })[0], /must match the file exactly/);
  assert.match(problems({ edits: [edit({ path: 'AGENTS.md' })], unresolved: [] })[0], /only README/);
});

test('citations must point at this run\'s entries, commits or files', () => {
  assert.match(problems({ edits: [edit({ sources: ['entry:made-up'] })], unresolved: [] })[0], /unknown source "entry:made-up"/);
  assert.match(problems({ edits: [edit({ sources: ['commit:a90c'] })], unresolved: [] })[0], /unknown source/);
  assert.deepEqual(problems({ edits: [edit({ sources: ['file:src/a.ts'] })], unresolved: [] }), []);
});

test('junk kinds like test narration are not even valid worker output', () => {
  assert.ok(problems({ edits: [edit({ kind: 'test-narration' })], unresolved: [] }).length > 0);
});

test('new pages need a safe name in a docs directory and must not already exist', () => {
  const create = (path: string) => ({ edits: [], creates: [{ path, content: '# New\n', kind: 'howto', value: 'How to run it.', sources: ['commit:a90c9cb'] }], unresolved: [] });
  assert.deepEqual(problems(create('docs/running.md')), []);
  assert.ok(problems(create('docs/guide.md')).some(p => /already exists/.test(p)));
  assert.ok(problems(create('src/notes.md')).length > 0);
  assert.ok(problems(create('docs/bad name.md')).length > 0);
});

test('credentials never make it into docs', () => {
  assert.match(problems({ edits: [edit({ newText: 'Use key sk-abcdefghijklmnopqrstuvwxyz123456.' })], unresolved: [] })[0], /credential/);
});

test('the proposal schema accepts exactly the kinds the gate treats as useful', () => {
  const schemaKinds = (ProposalSchema.properties.edits.items.properties.kind.anyOf as { const: string }[]).map(k => k.const).sort();
  assert.deepEqual(schemaKinds, [...USEFUL_EDIT_KINDS].sort());
});

test('read-only records such as ADRs are never edited or added to, unless readOnlyDocs is emptied', () => {
  const ev = evidence();
  ev.readDocs.set('docs/adr/0046-list-pagination.md', '# ADR 46\n\nStatus: accepted.\n');
  const adrEdit = { edits: [edit({ path: 'docs/adr/0046-list-pagination.md', oldText: 'Status: accepted.', newText: 'Status: superseded.' })], unresolved: [] };
  assert.throws(() => validateProposal(adrEdit, ev, config), (error: ProposalError) => /read-only \(a record such as an ADR\)/.test(error.problems[0]));
  const adrCreate = { edits: [], creates: [{ path: 'docs/adr/0074-new.md', content: '# ADR 74\n', kind: 'decision', value: 'Records the choice.', sources: ['entry:u3'] }], unresolved: [] };
  assert.throws(() => validateProposal(adrCreate, ev, config), (error: ProposalError) => /read-only directory such as ADRs/.test(error.problems[0]));
  assert.equal(validateProposal(adrEdit, ev, { ...config, readOnlyDocs: [] }).edits.length, 1);
});
