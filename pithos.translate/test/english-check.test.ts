import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { it } from "node:test";
import { checkEnglish } from "../src/english-check.ts";
import { protectMarkdown } from "../src/markdown-protection.ts";

const config = { model: "openai/gpt-6-luna" };
const response = (probability: unknown = 0.98) => ({
  stopReason: "stop", answers: { english: { type: "bool", probability } },
});

it("skips only a valid strong bool positive from the exact classifier using full protected source", async () => {
  const source = "Check `secret code` https://secret.example\n" + "English prose. ".repeat(3000) + "fin";
  const calls: unknown[] = [];
  let result: unknown = response();
  const model = { type: "classifier", provider: "openai", id: "gpt-6-luna" };
  const registry = {
    findOfType: (...args: unknown[]) => { calls.push(args); return model; },
    classify: async (selected: unknown, context: any, options: any) => {
      assert.equal(selected, model);
      assert.equal(context.state.source, protectMarkdown(source).markdown);
      assert.equal(context.questions.english.type, "bool");
      assert.match(context.questions.english.instructions, /data|instructions/i);
      assert.ok(options.signal instanceof AbortSignal);
      return result;
    },
  };
  assert.equal((await checkEnglish(source, config, registry as never)).outcome, "skip");
  assert.deepEqual(calls[0], ["classifier", "openai", "gpt-6-luna"]);
  for (result of [null, {}, { stopReason: "stop" }, { stopReason: "stop", answers: {} },
    { ...response(), stopReason: "error", errorMessage: source },
    { ...response(), stopReason: "aborted" },
    { stopReason: "stop", answers: { english: { type: "choice", probability: 1 } } },
    { stopReason: "stop", answers: { english: { type: "bool" } } },
    ...[null, "1", NaN, Infinity, -0.01, 1.01, 0, 0.9799].map(response)]) {
    assert.equal((await checkEnglish(source, config, registry as never)).outcome, "fallback");
  }
  result = response(0.99);
  assert.equal((await checkEnglish(source, { ...config, threshold: 1 }, registry as never)).outcome, "fallback");
  result = response(1);
  assert.equal((await checkEnglish(source, { ...config, threshold: 1 }, registry as never)).outcome, "skip");
});

it("falls back safely for unavailable APIs, models, auth and exceptions without exposing errors", async () => {
  for (const registry of [
    {},
    { findOfType: () => undefined, classify: () => { throw Error("must not call"); } },
    { findOfType: () => { throw Error("PRIVATE"); }, classify: async () => response() },
    { findOfType: () => ({}), classify: async () => { throw Error("PRIVATE"); } },
    { findOfType: () => ({}), classify: async () => ({ stopReason: "error", errorMessage: "PRIVATE auth" }) },
  ]) {
    const result = await checkEnglish("PRIVATE source", config, registry as never);
    assert.equal(result.outcome, "fallback");
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  }
});

it("bounds ignored-signal requests and prioritizes caller cancellation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let requestSignal: AbortSignal | undefined;
  let calls = 0;
  const registry = {
    findOfType: () => ({}),
    classify: (_model: unknown, _context: unknown, options: any) => {
      calls++;
      requestSignal = options.signal;
      return new Promise(() => {});
    },
  };
  const pending = checkEnglish("Hello", config, registry as never);
  t.mock.timers.tick(9999);
  assert.equal(requestSignal?.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(requestSignal?.aborted, true);
  assert.equal((await pending).outcome, "fallback");
  const controller = new AbortController();
  const cancelled = checkEnglish("Hello", config, registry as never, controller.signal);
  controller.abort();
  assert.equal((await cancelled).outcome, "cancelled");
  assert.equal(requestSignal?.aborted, true);
  const before = calls;
  assert.equal((await checkEnglish("Hello", config, registry as never, controller.signal)).outcome, "cancelled");
  assert.equal(calls, before);
  const custom = checkEnglish("Hello", { ...config, timeoutMs: 1000 }, registry as never);
  t.mock.timers.tick(1000);
  assert.equal((await custom).outcome, "fallback");
});

it("returns only finite source-free classifier usage dimensions", async () => {
  const registry = {
    findOfType: () => ({}),
    classify: async () => ({ ...response(), usage: { input: 12, output: 2, totalTokens: 14, cost: { total: 0.01, secret: "PRIVATE" }, secret: "PRIVATE" } }),
  };
  assert.deepEqual(await checkEnglish("PRIVATE", config, registry as never), {
    outcome: "skip", classifierUsage: { inputTokens: 12, outputTokens: 2, totalTokens: 14, costUsd: 0.01 },
  });
});


it("releases timeout and caller listeners after success and provider failure", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const fails of [false, true]) {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const registry = {
      findOfType: () => ({}),
      classify: async (_model: unknown, _context: unknown, options: any) => {
        requestSignal = options.signal;
        if (fails) throw Error("PRIVATE");
        return response();
      },
    };
    assert.equal((await checkEnglish("Hello", config, registry as never, controller.signal)).outcome, fails ? "fallback" : "skip");
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    t.mock.timers.tick(10_000);
    assert.equal(requestSignal?.aborted, false, "settled requests must not retain a deadline timer");
  }
});
