import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAssistantMessageEventStream, type Model, type AssistantMessage, type Usage } from '@earendil-works/pi-ai';
import { parseConfig } from '../src/config.ts';
import { runWorker } from '../src/worker.ts';
export const model: Model<any> = {id: 'fixture', name: 'Fixture', provider: 'fixture', api: 'openai-completions', baseUrl: 'http://invalid.local', reasoning: false, input: ['text'], cost: {input: 1, output: 1, cacheRead: 0, cacheWrite: 0}, contextWindow: 200000, maxTokens: 8000};
export const usage: Usage = {input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: {input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03}};
export function answer(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {return {role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, usage, stopReason, timestamp: Date.now()};}
export function stream(message: AssistantMessage) { const s = createAssistantMessageEventStream(); queueMicrotask(() => {s.push({type: 'done', reason: 'stop', message}); s.end(message);}); return s; }

test('plain Agent worker inherits registry auth boundary, exposes no mutations, accounts usage and awaits cancellation', async () => {
  let calls = 0;
  const registry = {find: () => model, getAvailable: () => [model], streamSimple: (_m: any, context: any, options: any) => {
    calls++;
    assert.equal(options.reasoning, undefined);
    assert.ok(!JSON.stringify(context).includes('RAW_SECRET_TRANSCRIPT'));
    const system = context.messages.filter((m: any) => m.role === 'system');
    assert.ok(system.every((m: any) => !m.tools?.length));
    return stream(answer([{type: 'text', text: '{"findings":[],"edits":[],"unresolved":[]}'}]));
  }};
  const ctx = {model, thinkingLevel: 'off' as const, modelRegistry: registry};
  const result = await runWorker(ctx, [], parseConfig({}), undefined);
  assert.equal(calls, 1);
  assert.deepEqual(result.proposal?.edits, []);
  assert.equal(result.usage?.totalTokens, 30);
  assert.equal(result.model, 'fixture/fixture');
  await assert.rejects(runWorker({...ctx, modelRegistry: {...registry, find: () => undefined}}, [], parseConfig({model: 'missing/model'}), undefined), /unavailable/);
  await assert.rejects(runWorker(ctx, [], parseConfig({thinking: 'high'}), undefined), /thinking/);
  let cleaned = false;
  let started!: () => void;
  const ready = new Promise<void>(resolve => {started = resolve;});
  const controller = new AbortController();
  const pending = runWorker({...ctx, modelRegistry: {...registry, streamSimple: (_m: any, _c: any, options: any) => {
    const s = createAssistantMessageEventStream();
    options.signal.addEventListener('abort', () => {setTimeout(() => {
      cleaned = true;
      const message = answer([], 'aborted');
      s.push({type: 'error', reason: 'aborted', error: message}); s.end(message);
    }, 10);}, {once: true});
    started(); return s;
  }}}, [], parseConfig({}), controller.signal);
  await ready; controller.abort();
  const cancelled = await pending;
  assert.equal(cleaned, true);
  assert.match(cancelled.problem!, /cancel/i);
});

test('unsupported worker tool attempts stop after one response without losing usage', async () => {
  let calls = 0;
  const result = await runWorker({model, thinkingLevel: 'off', modelRegistry: {
    find: () => model, getAvailable: () => [model],
    streamSimple: () => {calls++; return stream(answer([{type: 'toolCall', id: 'bad', name: 'write', arguments: {path: 'README.md', content: 'bad'}}], 'toolUse'));},
  }}, [], parseConfig({}), undefined);
  assert.equal(calls, 1);
  assert.match(result.problem!, /incomplete/);
  assert.equal(result.usage?.totalTokens, 30);
});
