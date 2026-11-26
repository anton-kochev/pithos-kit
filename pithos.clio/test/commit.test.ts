import assert from 'node:assert/strict';
import { chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyAndCommit } from '../src/commit.ts';
import { gate, type Change } from '../src/gate.ts';
import { isClioMessage } from '../src/git.ts';
import type { ProposedEdit } from '../src/proposal.ts';
import { judgement, makeRepo, stubClassifier } from './helpers.ts';

const readmeEdit: ProposedEdit = { path: 'README.md', oldText: 'Intro.', newText: 'Intro. Walkthroughs are JSON.', kind: 'decision', value: 'Where walkthrough data lives.', sources: ['commit:abcdef0'] };
const editReadme: Change = { type: 'edit', edit: readmeEdit };
const newPage: Change = { type: 'create', create: { path: 'docs/running.md', content: '# Running\n\nStart the guide with npm run dev.', kind: 'howto', value: 'How to run the guide.', sources: ['commit:abcdef0'] } };

test('commits only Clio\'s files, with the trailer, and leaves the user\'s staged work staged', async () => {
  const { root, git, write } = await makeRepo({ 'README.md': '# Demo\n\nIntro.\n', 'docs/index.md': '# Docs\n', 'src/a.ts': 'export const a = 1;\n' });
  await write('src/a.ts', 'export const a = 2;\n');
  await git.run(['add', 'src/a.ts']);
  const head = (await git.head())!;
  const outcome = await applyAndCommit(git, root, [editReadme, newPage], head, 'abc..def');
  assert.ok(outcome.committed);
  assert.deepEqual(outcome.deferred, []);
  assert.deepEqual((await git.run(['show', '--name-only', '--format=', outcome.committed!])).trim().split('\n').sort(), ['README.md', 'docs/running.md']);
  assert.ok(isClioMessage(await git.message(outcome.committed!)));
  assert.match(await readFile(join(root, 'README.md'), 'utf8'), /Walkthroughs are JSON/);
  assert.equal((await git.run(['diff', '--cached', '--name-only'])).trim(), 'src/a.ts', 'user staging is untouched');
});

test('a doc with uncommitted changes is deferred, never committed over', async () => {
  const { root, git, write } = await makeRepo();
  await write('README.md', '# Demo\n\nIntro.\n\nWork in progress.\n');
  const outcome = await applyAndCommit(git, root, [editReadme], (await git.head())!, 'r');
  assert.equal(outcome.committed, undefined);
  assert.match(outcome.deferred[0].reason, /uncommitted changes/);
  assert.match(await readFile(join(root, 'README.md'), 'utf8'), /Work in progress/);
});

test('if HEAD moved, nothing is written and everything is deferred', async () => {
  const { root, git, write, commit } = await makeRepo();
  const head = (await git.head())!;
  await write('other.md', 'x\n');
  await commit('someone else');
  const outcome = await applyAndCommit(git, root, [editReadme], head, 'r');
  assert.equal(outcome.committed, undefined);
  assert.match(outcome.deferred[0].reason, /HEAD moved/);
  assert.equal(await readFile(join(root, 'README.md'), 'utf8'), '# Demo\n\nIntro.\n');
});

test('a failed commit rolls back Clio\'s writes', async () => {
  const { root, git, write } = await makeRepo({ 'README.md': '# Demo\n\nIntro.\n', 'docs/index.md': '# Docs\n' });
  await write('.git/hooks/pre-commit', '#!/bin/sh\nexit 1\n');
  await chmod(join(root, '.git/hooks/pre-commit'), 0o755);
  const outcome = await applyAndCommit(git, root, [editReadme, newPage], (await git.head())!, 'r');
  assert.equal(outcome.committed, undefined);
  assert.equal(outcome.deferred.length, 2);
  assert.match(outcome.deferred[0].reason, /commit failed/);
  assert.equal(await readFile(join(root, 'README.md'), 'utf8'), '# Demo\n\nIntro.\n');
  await assert.rejects(readFile(join(root, 'docs/running.md')));
  assert.equal((await git.run(['status', '--porcelain', '--', 'docs'])).trim(), '');
});

test('the gate commits useful changes, reviews weak ones, drops junk, and reviews everything without a classifier', async () => {
  const classifier = stubClassifier(state => state.file === 'README.md' ? judgement('decision', 1.8) : state.file === 'docs/running.md' ? judgement('howto', 0.6) : judgement('test-narration', 2.5));
  const narration: Change = { type: 'edit', edit: { ...readmeEdit, path: 'docs/tests.md' } };
  const config = { model: 'stub/c', collectThreshold: 1, gateThreshold: 1, maxWindows: 8, timeoutMs: 1000 };
  const verdicts = (await gate([editReadme, newPage, narration], classifier, config, undefined)).map(g => g.verdict);
  assert.deepEqual(verdicts, ['commit', 'inbox', 'drop']);
  const unreviewed = await gate([editReadme], undefined, undefined, 'no classifier configured');
  assert.equal(unreviewed[0].verdict, 'inbox');
  assert.match(unreviewed[0].reason, /no classifier configured/);
});
