import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config.ts';
import { safeDirectory, snapshot } from '../src/evidence.ts';
import { evidenceTool } from '../src/exploration.ts';
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { runWorker } from '../src/worker.ts';
import { applyProposal } from '../src/apply.ts';

const model: Model<any> = {id: 'fixture', name: 'Fixture', provider: 'fixture', api: 'openai-completions', baseUrl: 'http://invalid.local', reasoning: false, input: ['text'], cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: 200000, maxTokens: 8000};
function context(respond: (context: any) => Pick<AssistantMessage, 'content' | 'stopReason'>) {
  return {model, thinkingLevel: 'off' as const, modelRegistry: {find: () => model, getAvailable: () => [model], streamSimple: (_m: any, ctx: any) => {
    const response: AssistantMessage = {role: 'assistant', ...respond(ctx), api: model.api, provider: model.provider, model: model.id, usage: {input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}, timestamp: Date.now()};
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {stream.push({type: 'done', reason: 'stop', message: response}); stream.end(response);});
    return stream;
  }}};
}

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'clio-missing-directory-'));
  try {
    await writeFile(join(root, 'README.md'), 'Cache uses TTL 30.');
    await run(root);
  } finally { await rm(root, {recursive: true, force: true}); }
}

test('absent authorized directory listing returns only not-found feedback without snapshots or creation', async () => fixture(async root => {
  const config = parseConfig({docsDirs: ['handbook/pages']});
  const files = await snapshot(root, ['README.md'], config);
  const before = structuredClone(files);
  const tool = evidenceTool(root, files, config);
  for (const path of ['docs', 'docs/nested', 'handbook/pages']) {
    const result = await tool.execute('missing', {action: 'list', path});
    assert.deepEqual(result.content, [{type: 'text', text: JSON.stringify({status: 'not-found', action: 'list', path})}]);
    assert.equal(result.details, undefined);
    assert.deepEqual(files, before);
    await assert.rejects(lstat(join(root, path.split('/')[0])), {code: 'ENOENT'});
  }
}));

test('actual Agent finalizes after absent docs with explicit non-evidence no-retry guidance', async () => fixture(async root => {
  const config = parseConfig({});
  for (const mode of ['empty', 'grounded', 'cite-missing'] as const) {
    const files = await snapshot(root, ['README.md'], config);
    const before = structuredClone(files);
    let turns = 0;
    let policy = '';
    let description = '';
    const proposal = {findings: mode === 'empty' ? [] : [{claim: 'Cache uses TTL 30.', kind: 'observed', sources: [{path: mode === 'cite-missing' ? 'docs' : 'README.md', startLine: 1, endLine: 1}]}], edits: [], unresolved: []};
    const result = await runWorker(context(ctx => {
      if (++turns === 1) {
        const system = ctx.messages.find((m: any) => m.role === 'system');
        policy = typeof system.content === 'string' ? system.content : system.content.map((c: any) => c.text).join('');
        description = system.toolsAdded.find((t: any) => t.name === 'clio_evidence').description;
        return {content: [{type: 'toolCall', id: 'list-docs', name: 'clio_evidence', arguments: {action: 'list', path: 'docs'}}], stopReason: 'toolUse'};
      }
      const feedback = ctx.messages.filter((m: any) => m.role === 'toolResult').at(-1);
      assert.equal(feedback.isError, false);
      assert.deepEqual(JSON.parse(feedback.content[0].text), {status: 'not-found', action: 'list', path: 'docs'});
      return {content: [{type: 'text', text: JSON.stringify(proposal)}], stopReason: 'stop'};
    }), files, config, undefined, {root});
    assert.equal(turns, 2, 'absence allows a final request, not a fatal tool error');
    if (mode === 'cite-missing') {
      assert.match(result.problem!, /invalid source reference/);
      assert.equal(result.proposal, undefined);
    } else {
      assert.equal(result.problem, undefined);
      assert.deepEqual(result.proposal, proposal);
      let mutations = 0;
      const applied = await applyProposal(root, result.proposal!, files, config, async () => {mutations++; return {isError: false, result: {}};}, () => {});
      assert.equal(mutations, 0);
      assert.deepEqual(applied.changed, []);
      assert.deepEqual(applied.problems, []);
    }
    assert.deepEqual(files, before);
    await assert.rejects(lstat(join(root, 'docs')), {code: 'ENOENT'});
    assert.match(policy, /not-found.*not evidence/);
    assert.match(policy, /absence permits finalization, not retries/);
    assert.match(description, /not-found.*no readable\/citable evidence/);
  }
}));

// Supplemental safety regressions: these refusals already work and must not be
// softened by the new lstat-only absence classification.
test('directory absence handling keeps unsafe scope symlink permission and file-read errors fatal', async t => {
  const cases: {name: string; action: 'list' | 'read'; path: string; reason: RegExp; setup?: (root: string) => Promise<void>}[] = [
    {name: 'absent outside scope', action: 'list', path: 'other', reason: /outside observed scope/},
    {name: 'excluded missing path', action: 'list', path: 'docs/.hidden/absent', reason: /excluded directory/},
    {name: 'traversal', action: 'list', path: 'docs/../README.md', reason: /excluded directory/},
    {name: 'dangling directory symlink', action: 'list', path: 'docs', reason: /unsafe directory/, setup: root => symlink(join(root, 'absent'), join(root, 'docs'))},
    {name: 'dangling ancestor symlink', action: 'list', path: 'docs/absent/child', reason: /unsafe directory/, setup: root => symlink(join(root, 'absent'), join(root, 'docs'))},
    {name: 'outside directory symlink', action: 'list', path: 'docs', reason: /unsafe directory/, setup: root => symlink(tmpdir(), join(root, 'docs'))},
    {name: 'file instead of parent', action: 'list', path: 'docs/child', reason: /unsafe directory/, setup: root => writeFile(join(root, 'docs'), 'not a directory')},
    {name: 'permission denied during lstat', action: 'list', path: 'docs/absent', reason: /EACCES/, setup: async root => {await mkdir(join(root, 'docs')); await chmod(join(root, 'docs'), 0);}},
    {name: 'permission denied during opendir', action: 'list', path: 'docs', reason: /EACCES/, setup: async root => {await mkdir(join(root, 'docs')); await chmod(join(root, 'docs'), 0);}},
    {name: 'missing file read', action: 'read', path: 'docs/absent.md', reason: /ENOENT/, setup: root => mkdir(join(root, 'docs')).then(() => {})},
  ];
  for (const entry of cases) await t.test(entry.name, async () => fixture(async root => {
    const config = parseConfig({});
    const files = await snapshot(root, ['README.md'], config);
    const before = structuredClone(files);
    await entry.setup?.(root);
    try {
      await assert.rejects(evidenceTool(root, files, config).execute('fatal', {action: entry.action, path: entry.path}), entry.reason);
      let turns = 0;
      const result = await runWorker(context(() => {
        turns++;
        return {content: [{type: 'toolCall', id: 'fatal', name: 'clio_evidence', arguments: {action: entry.action, path: entry.path}}], stopReason: 'toolUse'};
      }), files, config, undefined, {root});
      assert.equal(turns, 1);
      assert.match(result.problem!, entry.reason);
      assert.equal(result.proposal, undefined);
      assert.deepEqual(files, before);
    } finally {
      if (entry.name.startsWith('permission')) await chmod(join(root, 'docs'), 0o700);
    }
  }));
});

test('root resolution and ENOTDIR errors are not ordinary missing directory feedback', async () => fixture(async root => {
  await assert.rejects(safeDirectory(join(root, 'absent-root'), 'docs'), {code: 'ENOENT'});
  await assert.rejects(safeDirectory(join(root, 'README.md'), 'docs'), {code: 'ENOTDIR'});
  const config = parseConfig({});
  const files = await snapshot(root, ['README.md'], config);
  for (const [base, code] of [[join(root, 'absent-root'), 'ENOENT'], [join(root, 'README.md'), 'ENOTDIR']]) {
    await assert.rejects(evidenceTool(base, files, config).execute('fatal-root', {action: 'list', path: 'docs'}), {code});
  }
  await mkdir(join(root, 'docs'));
  const result = await evidenceTool(root, files, config).execute('existing', {action: 'list', path: 'docs'});
  assert.ok(result.content[0].type === 'text');
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.status, undefined);
  assert.deepEqual(body.entries, []);
  assert.deepEqual(body.fileSizes, {});
}));
