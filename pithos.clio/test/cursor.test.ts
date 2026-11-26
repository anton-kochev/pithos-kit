import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planCapture } from '../src/cursor.ts';
import { makeRepo } from './helpers.ts';

test('first run only places the cursor, so old history is never backfilled', async () => {
  const { git } = await makeRepo();
  const plan = await planCapture(git, 20);
  assert.equal(plan.kind, 'reset');
});

test('new commits after the cursor become the capture range', async () => {
  const { git, write, commit } = await makeRepo();
  const start = (await git.head())!;
  await git.writeCursor('main', start);
  await write('src/a.ts', 'export const a = 1;\n');
  const first = await commit('feat: a');
  await write('src/b.ts', 'export const b = 2;\n');
  const second = await commit('feat: b');
  const plan = await planCapture(git, 20);
  assert.equal(plan.kind, 'capture');
  if (plan.kind !== 'capture') return;
  assert.equal(plan.from, start);
  assert.equal(plan.to, second);
  assert.deepEqual(plan.commits.map(c => c.sha), [first, second]);
  assert.equal(plan.truncated, false);
});

test('Clio commits and their reverts are never documented', async () => {
  const { git, write } = await makeRepo();
  await git.writeCursor('main', (await git.head())!);
  await write('README.md', '# Demo\n\nBetter intro.\n');
  await git.commitOnly(['README.md'], 'docs(clio): update README.md', '', 'abc..def', []);
  assert.equal((await planCapture(git, 20)).kind, 'skip');
  await git.revert((await git.head())!);
  assert.equal((await planCapture(git, 20)).kind, 'skip');
});

test('rewritten history resets the cursor instead of capturing a bogus range', async () => {
  const { git, write, commit } = await makeRepo();
  await write('a.md', 'a\n');
  const lost = await commit('lost');
  await git.writeCursor('main', lost);
  await git.run(['reset', '-q', '--hard', 'HEAD~1']);
  await write('b.md', 'b\n');
  await commit('replacement');
  const plan = await planCapture(git, 20);
  assert.equal(plan.kind, 'reset');
});

test('the range is capped to the newest commits', async () => {
  const { git, write, commit } = await makeRepo();
  await git.writeCursor('main', (await git.head())!);
  for (let i = 0; i < 4; i++) { await write(`f${i}.md`, `${i}\n`); await commit(`c${i}`); }
  const plan = await planCapture(git, 2);
  assert.equal(plan.kind, 'capture');
  if (plan.kind !== 'capture') return;
  assert.equal(plan.truncated, true);
  assert.deepEqual(plan.commits.map(c => c.subject), ['c2', 'c3']);
});

test('a detached HEAD is left alone', async () => {
  const { git } = await makeRepo();
  await git.run(['checkout', '-q', '--detach']);
  assert.equal((await planCapture(git, 20)).kind, 'none');
});
