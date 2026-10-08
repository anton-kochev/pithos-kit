import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage, type Model, type Usage } from '@earendil-works/pi-ai';
import { parseConfig } from '../src/config.ts';
import { snapshot } from '../src/evidence.ts';
import { runWorker } from '../src/worker.ts';

// Test list: streamed error; synchronous error; evidence refusal/correlation;
// missing reason; oversized sensitive reason; unsafe diagnostic paths; later turns.
const model: Model<any> = {id: 'selected/model', name: 'Fixture', provider: 'fixture', api: 'openai-completions', baseUrl: 'http://invalid.local', reasoning: false, input: ['text'], cost: {input: 1, output: 1, cacheRead: 0, cacheWrite: 0}, contextWindow: 200000, maxTokens: 8000};
const usage: Usage = {input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: {input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03}};
function message(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'], errorMessage?: string): AssistantMessage {
  return {role: 'assistant', content, api: model.api, provider: 'untrusted-provider', model: 'untrusted-model', usage, stopReason, errorMessage, timestamp: Date.now()};
}
function context(respond: () => AssistantMessage) {
  let calls = 0;
  return {get calls() { return calls; }, ctx: {model, thinkingLevel: 'off' as const, modelRegistry: {
    find: () => model, getAvailable: () => [model], streamSimple: () => {
      calls++;
      const response = respond();
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        if (response.stopReason === 'error') stream.push({type: 'error', reason: 'error', error: response});
        else stream.push({type: 'done', reason: response.stopReason as 'stop' | 'toolUse', message: response});
        stream.end(response);
      });
      return stream;
    },
  }}};
}

test('diagnostics streamed provider error retains safe explanation, selected model and worker turn', async () => {
  const provider = context(() => message([{type: 'text', text: 'PRIVATE_PARTIAL_PROPOSAL'}], 'error', 'HTTP 429: provider quota exhausted'));
  const result = await runWorker(provider.ctx, [], parseConfig({}), undefined);
  assert.match(result.problem!, /^Clio: worker incomplete \(error\)/);
  assert.match(result.problem!, /HTTP 429: provider quota exhausted/);
  assert.match(result.problem!, /model=fixture\/selected\/model; turn=1/);
  assert.doesNotMatch(result.problem!, /PRIVATE_PARTIAL_PROPOSAL|untrusted-provider|untrusted-model/);
  assert.equal(provider.calls, 1);
  assert.equal(result.proposal, undefined);
  assert.equal(result.usage?.totalTokens, 30);
  assert.equal(result.usageStatus, 'complete');
});

test('diagnostics synchronous streaming exception is sanitized without exposing credentials or terminal controls', async () => {
  const reason = 'HTTP 401: authentication failed\u001b]52;c;CLIPBOARD_SECRET\u0007\u001b[31m\n' +
    'password=hunter-two\nAuthorization: Bearer bearer-value\n' +
    'Authorization: Basic basic-value\nCookie: session=cookie-value\nx-amz-signature=bare-signature\n' +
    '-----BEGIN PRIVATE KEY-----\nKEY_BODY\n-----END PRIVATE KEY-----\n' +
    'endpoint https://url-user:url-pass@invalid.local/v1\n' +
    'query https://invalid.local/v1?access_token=query-value&x-amz-signature=signed-value\n' +
    'api_\u200bkey=split-value\n' +
    'details\r\t\u0008\u009b31m\u202e reversed';
  const provider = context(() => { throw new Error(reason); });
  const result = await runWorker(provider.ctx, [], parseConfig({}), undefined);
  assert.match(result.problem!, /^Clio: worker incomplete \(error\)/);
  assert.match(result.problem!, /HTTP 401: authentication failed/);
  assert.match(result.problem!, /model=fixture\/selected\/model; turn=1/);
  assert.doesNotMatch(result.problem!, /hunter-two|bearer-value|basic-value|cookie-value|bare-signature|KEY_BODY|url-user|url-pass|query-value|signed-value|split-value|CLIPBOARD_SECRET/);
  assert.doesNotMatch(result.problem!, /[\p{Cc}\p{Cf}]/u);
  assert.equal(provider.calls, 1);
  assert.equal(result.proposal, undefined);
});

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'clio-diagnostics-'));
  try {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src/cache.ts'), 'export const cache = true;');
    await writeFile(join(root, 'src/rules.ts'), 'export const body = "SUCCESSFUL_FILE_BODY";');
    await writeFile(join(root, 'README.md'), 'Old');
    await run(root);
  } finally { await rm(root, {recursive: true, force: true}); }
}

test('diagnostics evidence denial correlates the failed call, retaining host reason but no successful content', async () => fixture(async root => {
  const config = parseConfig({});
  const files = await snapshot(root, ['src/cache.ts'], config);
  const provider = context(() => message([
    {type: 'toolCall', id: 'call-success-123', name: 'clio_evidence', arguments: {action: 'read', path: 'src/rules.ts'}},
    {type: 'toolCall', id: 'call-failure-456', name: 'clio_evidence', arguments: {action: 'list', path: 'other'}},
  ], 'toolUse'));
  const result = await runWorker(provider.ctx, files, config, undefined, {root});
  assert.match(result.problem!, /^Clio: worker incomplete \(evidence tool refused or failed\)/);
  assert.match(result.problem!, /Clio: evidence outside observed scope/);
  assert.match(result.problem!, /model=fixture\/selected\/model; turn=1/);
  assert.match(result.problem!, /action=list; path=other/);
  assert.doesNotMatch(result.problem!, /SUCCESSFUL_FILE_BODY|src\/rules.ts|call-success-123|call-failure-456|arguments|export const/);
  assert.equal(provider.calls, 1);
  assert.equal(result.proposal, undefined);
  assert.equal(result.usage?.totalTokens, 30);
  assert.equal(await readFile(join(root, 'README.md'), 'utf8'), 'Old');
  assert.equal(await readFile(join(root, 'src/rules.ts'), 'utf8'), 'export const body = "SUCCESSFUL_FILE_BODY";');
}));

test('diagnostics bounds UTF-8 output and redacts before truncating long sensitive lines', async () => {
  const provider = context(() => message([], 'error', 'HTTP 400: request rejected\n' +
    'api_key=' + 'LONG_SECRET'.repeat(500) + '\n' + '🧪'.repeat(1000)));
  const result = await runWorker(provider.ctx, [], parseConfig({}), undefined);
  assert.ok(Buffer.byteLength(result.problem!) <= 900);
  assert.match(result.problem!, /HTTP 400: request rejected/);
  assert.match(result.problem!, /REDACTED SENSITIVE LINE/);
  assert.doesNotMatch(result.problem!, /LONG_SECRET|\ufffd/);
});

test('diagnostics omits reflected request payloads, retaining only the error explanation', async () => {
  const provider = context(() => message([], 'error', 'HTTP 400: unsupported option\nRequest body: {"messages":[{"content":"PRIVATE_REQUEST_BODY"}]}'));
  const result = await runWorker(provider.ctx, [], parseConfig({}), undefined);
  assert.match(result.problem!, /HTTP 400: unsupported option/);
  assert.doesNotMatch(result.problem!, /PRIVATE_REQUEST_BODY|messages|content/);
});

test('diagnostics evidence paths omit absolute, sensitive and malformed inputs but retain filesystem codes', async () => fixture(async root => {
  const config = parseConfig({});
  for (const path of [root + '/src/missing.ts', 'src/password-huntertwo.ts', 'src/../README.md', '.pi/settings.ts', 'other/\u001b[31mhidden.ts']) {
    const files = await snapshot(root, ['src/cache.ts'], config);
    const provider = context(() => message([{type: 'toolCall', id: 'denied', name: 'clio_evidence', arguments: {action: 'read', path}}], 'toolUse'));
    const result = await runWorker(provider.ctx, files, config, undefined, {root});
    assert.match(result.problem!, /path=\[OMITTED PATH\]/);
    assert.doesNotMatch(result.problem!, /huntertwo|settings|hidden|\.\.\/|\u001b/);
    assert.ok(!result.problem!.includes(root));
    assert.equal(result.proposal, undefined);
    assert.equal(provider.calls, 1);
  }
  const files = await snapshot(root, ['src/cache.ts'], config);
  const provider = context(() => message([{type: 'toolCall', id: 'missing', name: 'clio_evidence', arguments: {action: 'read', path: 'src/missing.ts'}}], 'toolUse'));
  const result = await runWorker(provider.ctx, files, config, undefined, {root});
  assert.match(result.problem!, /action=read; path=src\/missing.ts/);
  assert.match(result.problem!, /ENOENT/);
  assert.ok(!result.problem!.includes(root));
}));

test('diagnostics missing failure reason has an explicit fallback without using assistant content', async () => {
  const provider = context(() => message([{type: 'text', text: 'PRIVATE_ASSISTANT_CONTENT'}], 'error'));
  const result = await runWorker(provider.ctx, [], parseConfig({}), undefined);
  assert.match(result.problem!, /No failure reason available/);
  assert.doesNotMatch(result.problem!, /PRIVATE_ASSISTANT_CONTENT/);
  assert.equal(result.proposal, undefined);
});

test('diagnostics provider error after exploration uses the failed turn and retains summed usage', async () => fixture(async root => {
  let turns = 0;
  const provider = context(() => ++turns === 1 ? message([{type: 'toolCall', id: 'read', name: 'clio_evidence', arguments: {action: 'read', path: 'src/rules.ts'}}], 'toolUse') : message([], 'error', 'HTTP 503: service unavailable'));
  const config = parseConfig({});
  const files = await snapshot(root, ['src/cache.ts'], config);
  const result = await runWorker(provider.ctx, files, config, undefined, {root});
  assert.match(result.problem!, /turn=2: HTTP 503: service unavailable/);
  assert.doesNotMatch(result.problem!, /SUCCESSFUL_FILE_BODY/);
  assert.equal(provider.calls, 2);
  assert.equal(result.usage?.totalTokens, 60);
  assert.equal(result.proposal, undefined);
}));
