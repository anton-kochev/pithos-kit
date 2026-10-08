import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { parseConfig } from '../src/config.ts';
import { snapshot } from '../src/evidence.ts';
import { runWorker } from '../src/worker.ts';
import { applyProposal } from '../src/apply.ts';

// Test list: explicit root-only authorization/guidance; grounded empty completion;
// package listing remains a terminal safety error (no retry or empty fallback).
const model: Model<any> = {id: 'fixture', name: 'Fixture', provider: 'fixture', api: 'openai-completions', baseUrl: 'http://invalid.local', reasoning: false, input: ['text'], cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: 200000, maxTokens: 8000};
function context(respond: (context: any) => AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop') {
  return {model, thinkingLevel: 'off' as const, modelRegistry: {find: () => model, getAvailable: () => [model], streamSimple: (_m: any, ctx: any) => {
    const message: AssistantMessage = {role: 'assistant', content: respond(ctx), api: model.api, provider: model.provider, model: model.id, usage: {input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}, stopReason, timestamp: Date.now()};
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {stream.push({type: 'done', reason: 'stop', message}); stream.end(message);});
    return stream;
  }}};
}
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'clio-root-only-'));
  try {
    await writeFile(join(root, 'README.md'), 'See pithos.clio for implementation.');
    await mkdir(join(root, 'pithos.clio'));
    await writeFile(join(root, 'pithos.clio/worker.ts'), 'export const implementation = true;');
    await run(root);
  } finally {await rm(root, {recursive: true, force: true});}
}

test('root-only evidence exposes exact authorization and prefers a valid empty grounded completion', async () => fixture(async root => {
  const config = parseConfig({});
  const files = await snapshot(root, ['README.md'], config);
  assert.deepEqual(files.map(f => f.path), ['README.md']);
  let requests = 0;
  const result = await runWorker(context(ctx => {
    requests++;
    const system = ctx.messages.find((m: any) => m.role === 'system');
    const policy = typeof system.content === 'string' ? system.content : system.content.map((c: any) => c.text).join('');
    assert.match(policy, /Explore only explicit authorized scopes or exact readable paths/);
    assert.match(policy, /root-only README\.md evidence does not authorize package subtree listing/);
    assert.match(policy, /relevant evidence is inaccessible, prefer the final valid empty proposal/);
    const tool = system.toolsAdded.find((t: any) => t.name === 'clio_evidence');
    const authorization = JSON.parse(tool.description.match(/Authorization: (\{[^\n]+\})\./)[1]);
    assert.deepEqual(authorization, {scopes: ['docs'], readPaths: ['README.md']});
    assert.match(tool.description, /Exact readable paths do not authorize listing their parent or sibling directories/);
    assert.match(tool.description, /scope "\." permits only immediate root-level files, not subtrees/);
    const input = JSON.parse(ctx.messages.find((m: any) => m.role === 'user').content[0].text);
    assert.deepEqual(input.files, [{path: 'README.md', text: 'See pithos.clio for implementation.', doc: true}]);
    return [{type: 'text', text: '{"findings":[],"edits":[],"unresolved":[]}'}];
  }), files, config, undefined, {root});
  assert.equal(result.problem, undefined);
  assert.equal(requests, 1);
  assert.deepEqual(result.proposal, {findings: [], edits: [], unresolved: []});
  let mutations = 0;
  const applied = await applyProposal(root, result.proposal!, files, config, async () => {mutations++; return {isError: false, result: {}};}, () => {});
  assert.equal(mutations, 0);
  assert.deepEqual(applied.changed, []);
  assert.deepEqual(applied.problems, []);
  assert.equal(await readFile(join(root, 'README.md'), 'utf8'), 'See pithos.clio for implementation.');
}));

test('root-only evidence still refuses package listing as a terminal safety error', async () => fixture(async root => {
  const config = parseConfig({});
  const files = await snapshot(root, ['README.md'], config);
  let requests = 0;
  const result = await runWorker(context(() => {
    requests++;
    return [{type: 'toolCall', id: 'outside-scope', name: 'clio_evidence', arguments: {action: 'list', path: 'pithos.clio'}}];
  }, 'toolUse'), files, config, undefined, {root});
  assert.equal(requests, 1);
  assert.match(result.problem!, /evidence outside observed scope/);
  assert.equal(result.proposal, undefined);
  assert.deepEqual(files.map(f => f.path), ['README.md']);
}));
