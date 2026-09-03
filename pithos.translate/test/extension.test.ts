import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MANUAL_ENTRY_TYPE,
  registerTranslate,
  type TranslateDependencies,
} from "../src/translate.ts";
import type { TranslateConfig } from "../src/config.ts";
import { AUTOMATIC_ENTRY_TYPE, fingerprintMarkdown } from "../src/display-cache.ts";

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(text: string, extras: unknown[] = []) {
  return {
    role: "assistant",
    content: [{ type: "text", text }, ...extras],
    stopReason: extras.length ? "toolUse" : "stop",
    provider: "main",
    model: "coding",
    api: "test",
    usage,
    timestamp: 1,
  };
}

type Handler = (event: any, context: any) => unknown;

function createHarness(
  branch: unknown[],
  dependencies: TranslateDependencies,
  commandSources: Array<{ path: string; source: string; scope: "user" | "project" | "temporary"; origin: "package" | "top-level" }> = [
    { path: "/tmp/translate.ts", source: "translate", scope: "temporary", origin: "top-level" },
  ],
) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, {
    handler: Handler;
    description: string;
    getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string; description?: string }> | null;
  }>();
  const entries: Array<{ type: string; data: any }> = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  let transformer: ((markdown: string, context: any) => string) | undefined;
  const renderers = new Map<string, unknown>();
  const pi = {
    on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    registerCommand: (name: string, options: {
      handler: Handler;
      description: string;
      getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string; description?: string }> | null;
    }) => commands.set(name, options),
    registerMarkdownTransformer: (value: typeof transformer) => { transformer = value; },
    registerEntryRenderer: (type: string, renderer: unknown) => renderers.set(type, renderer),
    appendEntry: (type: string, data: any) => entries.push({ type, data }),
    getCommands: () => commandSources.map((sourceInfo, index) => ({
      name: commandSources.length === 1 ? "translate" : `translate:${index + 1}`,
      description: commands.get("translate")?.description,
      source: "extension",
      sourceInfo,
    })),
  };
  registerTranslate(pi as never, {
    runWithUi: async (ctx, _language, _model, task) => task(ctx.signal),
    ...dependencies,
  });
  const context = {
    cwd: "/repo",
    mode: "tui",
    hasUI: true,
    signal: undefined as AbortSignal | undefined,
    ui: {
      notify: (message: string, type?: string) => notifications.push({ message, ...(type ? { type } : {}) }),
      setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
      theme: { fg: (_color: string, text: string) => text },
    },
    sessionManager: {
      getBranch: () => branch,
    },
    modelRegistry: {},
  };
  return { handlers, commands, entries, notifications, statuses, get transformer() { return transformer; }, renderers, context };
}

async function emit(harness: ReturnType<typeof createHarness>, event: string, payload: object = {}) {
  const results: unknown[] = [];
  for (const handler of harness.handlers.get(event) ?? []) results.push(await handler(payload, harness.context));
  return results;
}

describe("translate extension", () => {
  it("suggests every supported argument after /translate ", () => {
    const harness = createHarness([], {});
    const command = harness.commands.get("translate")!;
    const completions = command.getArgumentCompletions;

    assert.match(command.description, /automatic display-only translation/i);
    assert.deepEqual(
      completions?.("")?.map((item) => item.value),
      ["on", "off", "status", "config", "--help"],
    );
  });

  it("filters argument suggestions by prefix and stops after the single argument", () => {
    const harness = createHarness([], {});
    const completions = harness.commands.get("translate")!.getArgumentCompletions!;

    assert.deepEqual(completions("o")?.map((item) => item.value), ["on", "off"]);
    assert.deepEqual(completions("st")?.map((item) => item.value), ["status"]);
    assert.deepEqual(completions("--h")?.map((item) => item.value), ["--help"]);
    assert.equal(completions("missing"), null);
    assert.equal(completions("on "), null);
  });

  it("configures on first use and appends a context-free manual translation card", async () => {
    const translatedSources: string[] = [];
    const harness = createHarness(
      [
        { type: "message", message: assistant("Older") },
        { type: "message", message: assistant("Do not translate", [{ type: "toolCall", id: "1", name: "read", arguments: {} }]) },
        { type: "message", message: assistant("Latest prose") },
      ],
      {
        configure: async () => ({ language: "French", model: "provider/model", mode: "manual" }),
        translate: async (source) => {
          translatedSources.push(source);
          return { ok: true, markdown: "Dernière prose", usage };
        },
      },
    );
    await emit(harness, "session_start", { reason: "startup" });
    await harness.commands.get("translate")!.handler("--help", harness.context);
    assert.match(harness.notifications.at(-1)?.message ?? "", /Usage: \/translate/);

    await harness.commands.get("translate")!.handler("", harness.context);

    assert.deepEqual(translatedSources, ["Latest prose"]);
    assert.equal(harness.entries.at(-1)?.type, MANUAL_ENTRY_TYPE);
    assert.equal(harness.entries.at(-1)?.data.translated, "Dernière prose");
    assert.equal(harness.entries.at(-1)?.data.source, "Latest prose");
    assert.equal(
      harness.transformer?.("Latest prose", { messageType: "assistant", isStreaming: false }),
      "Latest prose",
      "manual cards keep their own heading and must not create automatic display markers",
    );
    assert.ok(harness.renderers.has(MANUAL_ENTRY_TYPE));
  });

  it("fails closed when Pi cannot unambiguously correlate this command's source", async () => {
    let storeCreations = 0;
    const harness = createHarness([], {
      createStore: () => {
        storeCreations++;
        throw new Error("must not create a store for ambiguous provenance");
      },
    }, [
      { path: "/tmp/translate-a.ts", source: "cli-a", scope: "temporary", origin: "top-level" },
      { path: "/tmp/translate-b.ts", source: "cli-b", scope: "temporary", origin: "top-level" },
    ]);

    await emit(harness, "session_start", { reason: "startup" });
    await harness.commands.get("translate")!.handler("status", harness.context);

    assert.equal(storeCreations, 0);
    assert.match(harness.notifications.at(-1)?.message ?? "", /source.*ambiguous|ambiguously.*source/i);
  });

  it("persists on/off/config changes in the loading scope and reports status", async () => {
    let stored: TranslateConfig = { language: "French", model: "provider/model", mode: "manual" };
    const saves: unknown[] = [];
    const configuredFrom: unknown[] = [];
    const harness = createHarness([], {
      createStore: () => ({
        scope: "temporary",
        load: async () => stored,
        save: async (next: typeof stored) => {
          stored = next;
          saves.push(next);
        },
      }) as never,
      configure: async (_ctx, current) => {
        configuredFrom.push(current);
        return { language: "German", model: "other/exact", mode: current?.mode ?? "manual" };
      },
    });
    await emit(harness, "session_start", { reason: "startup" });
    const command = harness.commands.get("translate")!;

    await command.handler("status", harness.context);
    assert.match(harness.notifications.at(-1)?.message ?? "", /temporary.*French.*provider\/model.*manual.*60s/is);

    await command.handler("on", harness.context);
    assert.equal(stored.mode, "automatic");
    await command.handler("off", harness.context);
    assert.equal(stored.mode, "manual");
    await command.handler("on", harness.context);
    await command.handler("config", harness.context);

    assert.equal(stored.language, "German");
    assert.equal(stored.model, "other/exact");
    assert.equal(stored.mode, "automatic");
    assert.equal((configuredFrom.at(-1) as any).mode, "automatic");
    assert.equal(saves.length, 4);
  });

  it("makes no manual or automatic model call outside interactive TUI mode", async () => {
    let configureCalls = 0;
    let translationCalls = 0;
    const harness = createHarness(
      [{ type: "message", message: assistant("Manual source") }],
      {
        createStore: () => ({
          scope: "temporary",
          load: async () => ({ language: "French", model: "provider/model", mode: "automatic" }),
          save: async () => {},
        }) as never,
        configure: async () => {
          configureCalls++;
          return { language: "French", model: "provider/model", mode: "manual" };
        },
        translate: async () => {
          translationCalls++;
          return { ok: true, markdown: "Ne doit pas arriver", usage };
        },
      },
    );
    harness.context.mode = "rpc";
    await emit(harness, "session_start", { reason: "startup" });

    await harness.commands.get("translate")!.handler("", harness.context);
    await emit(harness, "message_end", { message: assistant("Automatic source") });
    await emit(harness, "turn_end", { turnIndex: 0, message: assistant("Automatic source"), toolResults: [] });

    assert.equal(configureCalls, 0);
    assert.equal(translationCalls, 0);
    assert.equal(harness.entries.length, 0);
    assert.deepEqual(harness.statuses, []);
    assert.match(harness.notifications.at(-1)?.message ?? "", /interactive TUI/i);
  });

  it("starts the keyed footer only at the first automatic translation request", async () => {
    let resolveTranslation!: (result: { ok: true; markdown: string; usage: typeof usage }) => void;
    let markTranslationStarted!: () => void;
    const translationStarted = new Promise<void>((resolve) => { markTranslationStarted = resolve; });
    const statusAtTranslationStart: Array<string | undefined> = [];
    const harness = createHarness([], {
      createStore: () => ({
        scope: "temporary",
        load: async () => ({ language: "French", model: "provider/model", mode: "automatic" }),
        save: async () => {},
      }) as never,
      translate: async () => {
        statusAtTranslationStart.push(harness.statuses.at(-1)?.text);
        markTranslationStarted();
        return new Promise((resolve) => { resolveTranslation = resolve; });
      },
    });
    await emit(harness, "session_start", { reason: "startup" });
    const message = assistant("Hello");

    await emit(harness, "message_start", { message });

    assert.equal(harness.statuses.length, 0, "main-model generation must use only Pi's working indicator");
    assert.equal(harness.transformer?.("partial prose", { messageType: "assistant", isStreaming: true }), "");

    const messageEnd = emit(harness, "message_end", { message });
    await translationStarted;
    assert.match(statusAtTranslationStart[0] ?? "", /^⠋ Translating into French with provider\/model\.\.\.$/);
    assert.match(harness.statuses.at(-1)?.text ?? "", /Translating into French with provider\/model/);

    resolveTranslation({ ok: true, markdown: "Bonjour", usage });
    await messageEnd;

    assert.deepEqual(harness.statuses.at(-1), { key: "pithos.translate", text: undefined });
    assert.ok(harness.statuses.every((status) => status.key === "pithos.translate"));
  });

  it("clears an active automatic footer indicator on mode, branch, session, and shutdown changes", async () => {
    let stored: TranslateConfig = { language: "French", model: "provider/model", mode: "automatic" };
    let resolveTranslation: ((result: { ok: true; markdown: string; usage: typeof usage }) => void) | undefined;
    const harness = createHarness([], {
      createStore: () => ({
        scope: "temporary",
        load: async () => stored,
        save: async (next: TranslateConfig) => { stored = next; },
      }) as never,
      translate: async () => new Promise((resolve) => { resolveTranslation = resolve; }),
    });
    await emit(harness, "session_start", { reason: "startup" });
    let messageIndex = 0;
    const startTranslation = (): Promise<unknown[]> => {
      const completion = emit(harness, "message_end", { message: assistant(`Pending prose ${messageIndex++}`) });
      assert.match(harness.statuses.at(-1)?.text ?? "", /Translating into French/);
      return completion;
    };
    const finishTranslation = async (completion: Promise<unknown[]>): Promise<void> => {
      resolveTranslation?.({ ok: true, markdown: "Traduit", usage });
      await completion;
      resolveTranslation = undefined;
    };

    let completion = startTranslation();
    await harness.commands.get("translate")!.handler("off", harness.context);
    assert.deepEqual(harness.statuses.at(-1), { key: "pithos.translate", text: undefined });
    await finishTranslation(completion);

    await harness.commands.get("translate")!.handler("on", harness.context);
    completion = startTranslation();
    await emit(harness, "session_tree", { newLeafId: "other-branch" });
    assert.deepEqual(harness.statuses.at(-1), { key: "pithos.translate", text: undefined });
    await finishTranslation(completion);

    completion = startTranslation();
    await emit(harness, "session_start", { reason: "resume" });
    assert.deepEqual(harness.statuses.at(-1), { key: "pithos.translate", text: undefined });
    await finishTranslation(completion);

    completion = startTranslation();
    await emit(harness, "session_shutdown", { reason: "quit" });
    assert.deepEqual(harness.statuses.at(-1), { key: "pithos.translate", text: undefined });
    await finishTranslation(completion);
  });

  it("clears the automatic footer after requests and never starts it for ineligible messages", async () => {
    const outcomes = [
      { name: "failure", result: { ok: false, kind: "request-failed", error: "provider down" } },
      { name: "cancellation", result: { ok: false, kind: "cancelled", error: "Translation cancelled." } },
      { name: "timeout", result: { ok: false, kind: "timeout", error: "Translation timed out after 60s." } },
    ] as const;

    for (const outcome of outcomes) {
      const harness = createHarness([], {
        createStore: () => ({
          scope: "temporary",
          load: async () => ({ language: "French", model: "provider/model", mode: "automatic" }),
          save: async () => {},
        }) as never,
        translate: async () => outcome.result,
      });
      await emit(harness, "session_start", { reason: "startup" });
      const message = assistant(`Automatic ${outcome.name}`);
      await emit(harness, "message_start", { message });
      await emit(harness, "message_end", { message });
      assert.deepEqual(
        harness.statuses.at(-1),
        { key: "pithos.translate", text: undefined },
        outcome.name,
      );
    }

    const thrownHarness = createHarness([], {
      createStore: () => ({
        scope: "temporary",
        load: async () => ({ language: "French", model: "provider/model", mode: "automatic" }),
        save: async () => {},
      }) as never,
      translate: async () => { throw new Error("unexpected translator failure"); },
    });
    await emit(thrownHarness, "session_start", { reason: "startup" });
    const thrownMessage = assistant("Thrown failure");
    await emit(thrownHarness, "message_start", { message: thrownMessage });
    await assert.rejects(emit(thrownHarness, "message_end", { message: thrownMessage }), /unexpected translator failure/);
    assert.deepEqual(thrownHarness.statuses.at(-1), { key: "pithos.translate", text: undefined });

    let skippedCalls = 0;
    const skippedHarness = createHarness([], {
      createStore: () => ({
        scope: "temporary",
        load: async () => ({ language: "French", model: "provider/model", mode: "automatic" }),
        save: async () => {},
      }) as never,
      translate: async () => {
        skippedCalls++;
        return { ok: true, markdown: "unexpected", usage };
      },
    });
    await emit(skippedHarness, "session_start", { reason: "startup" });
    const allMermaid = assistant("```mermaid\ngraph TD\n  A --> B\n```");
    allMermaid.content.push({ type: "text", text: "```mermaid\ngraph LR\n  C --> D\n```" });
    for (const message of [
      allMermaid,
      assistant("Tool prose", [{ type: "toolCall", id: "2", name: "read", arguments: {} }]),
      { ...assistant("Errored prose"), stopReason: "error" },
      { ...assistant("Truncated prose"), stopReason: "length" },
      assistant("   "),
    ]) {
      await emit(skippedHarness, "message_start", { message });
      await emit(skippedHarness, "message_end", { message });
      assert.equal(skippedHarness.statuses.length, 0, "ineligible messages must never show Translate's footer");
    }
    assert.equal(skippedCalls, 0);
  });

  it("clears the automatic footer indicator as soon as the active turn is cancelled", async () => {
    const controller = new AbortController();
    let resolveTranslation!: (result: { ok: false; kind: "cancelled"; error: string }) => void;
    let markTranslationStarted!: () => void;
    const translationStarted = new Promise<void>((resolve) => { markTranslationStarted = resolve; });
    const harness = createHarness([], {
      createStore: () => ({
        scope: "temporary",
        load: async () => ({ language: "French", model: "provider/model", mode: "automatic" }),
        save: async () => {},
      }) as never,
      translate: async () => {
        markTranslationStarted();
        return new Promise((resolve) => { resolveTranslation = resolve; });
      },
    });
    await emit(harness, "session_start", { reason: "startup" });
    const message = assistant("Pending cancellation");
    harness.context.signal = controller.signal;
    const messageEnd = emit(harness, "message_end", { message });
    await translationStarted;

    controller.abort();
    assert.deepEqual(harness.statuses.at(-1), { key: "pithos.translate", text: undefined });

    resolveTranslation({ ok: false, kind: "cancelled", error: "Translation cancelled." });
    await messageEnd;
    assert.deepEqual(harness.statuses.at(-1), { key: "pithos.translate", text: undefined });
  });

  it("automatically caches display-only block translations and persists them after the source message", async () => {
    const calls: string[] = [];
    const activeStatusAtCalls: Array<string | undefined> = [];
    const harness = createHarness([], {
      createStore: () => ({
        scope: "temporary",
        load: async () => ({ language: "French", model: "provider/model", mode: "automatic" }),
        save: async () => {},
      }) as never,
      translate: async (source) => {
        calls.push(source);
        activeStatusAtCalls.push(harness.statuses.at(-1)?.text);
        if (source === "Failure") return { ok: false, kind: "request-failed", error: "provider down" };
        return { ok: true, markdown: `FR:${source}`, usage };
      },
    });
    await emit(harness, "session_start", { reason: "startup" });
    assert.equal(harness.transformer?.("partial", { messageType: "assistant", isStreaming: true }), "");

    const message = assistant(" \n First \n ");
    message.content.push({ type: "text", text: "Second" });
    const snapshot = structuredClone(message);
    const results = await emit(harness, "message_end", { message });

    assert.deepEqual(message, snapshot);
    assert.deepEqual(results, [undefined]);
    assert.deepEqual(calls, ["First", "Second"]);
    assert.ok(
      activeStatusAtCalls.every((status) => status?.includes("Translating into French with provider/model")),
      "the footer must remain active through every translation request",
    );
    assert.deepEqual(harness.statuses.at(-1), { key: "pithos.translate", text: undefined });
    assert.equal(
      harness.transformer?.("First", { messageType: "assistant", isStreaming: false }),
      "*Translated · French*\n\nFR:First",
    );
    assert.equal(
      harness.transformer?.("Second", { messageType: "assistant", isStreaming: false }),
      "*Translated · French*\n\nFR:Second",
    );
    assert.equal(harness.entries.length, 0, "message_end must not append before Pi persists the source");

    await emit(harness, "turn_end", { turnIndex: 0, message: structuredClone(message), toolResults: [] });
    assert.equal(harness.entries.length, 1, "correlation must use public message fields rather than object identity alone");
    assert.equal(harness.entries[0]?.type, "pithos.translate.automatic");
    assert.deepEqual(
      harness.entries[0]?.data.outcomes.map((outcome: any) => [outcome.kind, outcome.source, outcome.translated]),
      [["translated", "First", "FR:First"], ["translated", "Second", "FR:Second"]],
      "the display marker must not enter persisted translation bodies or model context",
    );

    await emit(harness, "message_end", { message: assistant("Tool prose", [{ type: "toolCall", id: "2", name: "bash", arguments: {} }]) });
    assert.deepEqual(calls, ["First", "Second"]);

    const failedMessage = assistant("Failure");
    await emit(harness, "message_end", { message: failedMessage });
    assert.equal(harness.transformer?.("Failure", { messageType: "assistant", isStreaming: false }), "Failure");
    await emit(harness, "turn_end", { turnIndex: 1, message: failedMessage, toolResults: [] });
    assert.equal(harness.entries.length, 2);
    assert.deepEqual(harness.entries[1]?.data.outcomes.map((outcome: any) => outcome.kind), ["suppressed"]);
    assert.deepEqual(harness.entries[1]?.data.usage, {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: 0,
    });
    assert.match(harness.notifications.at(-1)?.message ?? "", /provider down/);
  });

  it("aggregates model-returned failure usage into automatic suppression records", async () => {
    const failureUsage = {
      input: 7,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      totalTokens: 16,
      cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
    };
    const harness = createHarness([], {
      createStore: () => ({
        scope: "temporary",
        load: async () => ({ language: "French", model: "provider/model", mode: "automatic" }),
        save: async () => {},
      }) as never,
      translate: async (source) => source === "First"
        ? { ok: true, markdown: "Premier", usage }
        : { ok: false, kind: "request-failed", error: "provider rejected request", usage: failureUsage },
    });
    await emit(harness, "session_start", { reason: "startup" });
    const message = assistant("First");
    message.content.push({ type: "text", text: "Failure" });

    await emit(harness, "message_end", { message });
    await emit(harness, "turn_end", { turnIndex: 0, message, toolResults: [] });

    assert.deepEqual(harness.entries[0]?.data.outcomes.map((outcome: any) => outcome.kind), ["suppressed", "suppressed"]);
    assert.deepEqual(harness.entries[0]?.data.usage, {
      input: 8,
      output: 3,
      cacheRead: 3,
      cacheWrite: 4,
      totalTokens: 18,
      cost: 1,
    });
  });

  it("aggregates aborted model response usage into the automatic tombstone", async () => {
    const abortedUsage = {
      input: 5,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      totalTokens: 14,
      cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
    };
    let completions = 0;
    const model = { provider: "provider", id: "model" };
    const harness = createHarness([], {
      createStore: () => ({
        scope: "temporary",
        load: async () => ({ language: "French", model: "provider/model", mode: "automatic" }),
        save: async () => {},
      }) as never,
    });
    harness.context.modelRegistry = {
      find: () => model,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "secret" }),
      complete: async () => {
        completions++;
        if (completions === 1) return assistant("Premier");
        return { ...assistant("Traduction partielle"), stopReason: "aborted", usage: abortedUsage };
      },
    };
    await emit(harness, "session_start", { reason: "startup" });
    const message = assistant("First");
    message.content.push({ type: "text", text: "Cancelled" });

    await emit(harness, "message_end", { message });
    await emit(harness, "turn_end", { turnIndex: 0, message, toolResults: [] });

    assert.deepEqual(harness.entries[0]?.data.outcomes.map((outcome: any) => outcome.kind), ["suppressed", "suppressed"]);
    assert.deepEqual(harness.entries[0]?.data.usage, {
      input: 6,
      output: 3,
      cacheRead: 3,
      cacheWrite: 4,
      totalTokens: 16,
      cost: 1,
    });
  });

  it("persists repeated-source suppression when a newer automatic attempt fails or is cancelled", async () => {
    for (const failure of [
      { kind: "request-failed" as const, error: "provider down" },
      { kind: "cancelled" as const, error: "Translation cancelled." },
    ]) {
      const source = `Repeated source ${failure.kind}`;
      const branch = [{
        type: "custom",
        customType: AUTOMATIC_ENTRY_TYPE,
        data: {
          version: 1,
          language: "French",
          model: "provider/model",
          sourceFingerprint: fingerprintMarkdown(source),
          blocks: [{ source, sourceFingerprint: fingerprintMarkdown(source), translated: "Ancienne traduction" }],
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0 },
          timestamp: 1,
        },
      }];
      const harness = createHarness(branch, {
        createStore: () => ({
          scope: "temporary",
          load: async () => ({ language: "French", model: "provider/model", mode: "automatic" }),
          save: async () => {},
        }) as never,
        translate: async () => ({ ok: false, ...failure }),
      });
      await emit(harness, "session_start", { reason: "resume" });
      assert.equal(
        harness.transformer?.(source, { messageType: "assistant", isStreaming: false }),
        "*Translated · French*\n\nAncienne traduction",
      );

      const message = assistant(source);
      await emit(harness, "message_end", { message });
      assert.equal(harness.transformer?.(source, { messageType: "assistant", isStreaming: false }), source);

      await emit(harness, "turn_end", { turnIndex: 0, message, toolResults: [] });
      assert.equal(harness.entries.length, 1, "the failed attempt must append its tombstone on turn_end");
      assert.deepEqual(harness.entries[0]?.data.outcomes, [{
        kind: "suppressed",
        source,
        sourceFingerprint: fingerprintMarkdown(source),
      }]);

      branch.push({ type: "custom", customType: AUTOMATIC_ENTRY_TYPE, data: harness.entries[0]!.data });
      await emit(harness, "session_tree", { newLeafId: "resumed" });
      assert.equal(
        harness.transformer?.(source, { messageType: "assistant", isStreaming: false }),
        source,
        "resuming the active branch must not resurrect the older translation",
      );
    }
  });

  it("persists mixed translated and Mermaid-suppressed blocks before calling the model", async () => {
    const calls: string[] = [];
    const mermaid = "```mermaid\r\ngraph TD\r\n  A --> B\r\n```\r\nDiagram explanation";
    const plain = "Plain prose";
    const oldRecord = (source: string, translated: string) => ({
      type: "custom",
      customType: AUTOMATIC_ENTRY_TYPE,
      data: {
        version: 1,
        language: "French",
        model: "provider/model",
        sourceFingerprint: fingerprintMarkdown(source),
        blocks: [{ source, sourceFingerprint: fingerprintMarkdown(source), translated }],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0 },
        timestamp: 1,
      },
    });
    const branch = [oldRecord(mermaid, "Ancien diagramme"), oldRecord(plain, "Ancienne prose")];
    const harness = createHarness(branch, {
      createStore: () => ({
        scope: "temporary",
        load: async () => ({ language: "French", model: "provider/model", mode: "automatic" }),
        save: async () => {},
      }) as never,
      translate: async (source) => {
        calls.push(source);
        return { ok: true, markdown: `FR:${source}`, usage };
      },
    });
    await emit(harness, "session_start", { reason: "resume" });

    const message = assistant(mermaid);
    message.content.push({ type: "text", text: plain });
    await emit(harness, "message_end", { message });

    assert.deepEqual(calls, [plain]);
    assert.equal(harness.transformer?.(mermaid, { messageType: "assistant", isStreaming: false }), mermaid);
    assert.equal(
      harness.transformer?.(plain, { messageType: "assistant", isStreaming: false }),
      `*Translated · French*\n\nFR:${plain}`,
    );

    await emit(harness, "turn_end", { turnIndex: 0, message, toolResults: [] });
    assert.deepEqual(harness.entries[0]?.data.outcomes.map((outcome: any) => outcome.kind), ["suppressed", "translated"]);
    branch.push({ type: "custom", customType: AUTOMATIC_ENTRY_TYPE, data: harness.entries[0]!.data });
    await emit(harness, "session_tree", { newLeafId: "resumed" });
    assert.equal(harness.transformer?.(mermaid, { messageType: "assistant", isStreaming: false }), mermaid);
    assert.equal(
      harness.transformer?.(plain, { messageType: "assistant", isStreaming: false }),
      `*Translated · French*\n\nFR:${plain}`,
    );
  });

  it("persists a tombstone when every automatic block is deliberately skipped", async () => {
    const source = "```mermaid\ngraph TD\n  A --> B\n```";
    const harness = createHarness([], {
      createStore: () => ({
        scope: "temporary",
        load: async () => ({ language: "French", model: "provider/model", mode: "automatic" }),
        save: async () => {},
      }) as never,
      translate: async () => { throw new Error("Mermaid must not reach the model"); },
    });
    await emit(harness, "session_start", { reason: "startup" });
    const message = assistant(source);

    await emit(harness, "message_end", { message });
    await emit(harness, "turn_end", { turnIndex: 0, message, toolResults: [] });

    assert.deepEqual(harness.entries[0]?.data.outcomes, [{
      kind: "suppressed",
      source,
      sourceFingerprint: fingerprintMarkdown(source),
    }]);
  });

  it("correlates queued turns individually and drops pending records on branch changes", async () => {
    const branch: unknown[] = [];
    const harness = createHarness(branch, {
      createStore: () => ({
        scope: "temporary",
        load: async () => ({ language: "French", model: "provider/model", mode: "automatic" }),
        save: async () => {},
      }) as never,
      translate: async (source) => ({ ok: true, markdown: `FR:${source}`, usage }),
    });
    await emit(harness, "session_start", { reason: "startup" });

    const firstQueuedTurn = assistant("First queued turn");
    await emit(harness, "message_end", { message: firstQueuedTurn });
    await emit(harness, "turn_end", { turnIndex: 0, message: firstQueuedTurn, toolResults: [] });
    assert.deepEqual(harness.entries.map((entry) => entry.data.outcomes[0].source), ["First queued turn"]);

    const abandonedTurn = assistant("Abandoned branch");
    await emit(harness, "message_end", { message: abandonedTurn });
    await emit(harness, "session_tree", { newLeafId: "other-branch" });
    await emit(harness, "turn_end", { turnIndex: 1, message: abandonedTurn, toolResults: [] });
    assert.deepEqual(harness.entries.map((entry) => entry.data.outcomes[0].source), ["First queued turn"]);

    const secondQueuedTurn = assistant("Second queued turn");
    await emit(harness, "message_end", { message: secondQueuedTurn });
    await emit(harness, "turn_end", { turnIndex: 0, message: secondQueuedTurn, toolResults: [] });
    await emit(harness, "agent_settled", {});
    assert.deepEqual(harness.entries.map((entry) => entry.data.outcomes[0].source), [
      "First queued turn",
      "Second queued turn",
    ]);
  });

  it("rebuilds historical display substitutions from the active branch", async () => {
    const makeEntry = (source: string, translated: string) => ({
      type: "custom",
      customType: AUTOMATIC_ENTRY_TYPE,
      data: {
        version: 1,
        language: "French",
        model: "provider/model",
        sourceFingerprint: fingerprintMarkdown(source),
        blocks: [{ source, sourceFingerprint: fingerprintMarkdown(source), translated }],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0 },
        timestamp: 1,
      },
    });
    const branch = [makeEntry("Old source", "Ancienne source")];
    const harness = createHarness(branch, {
      createStore: () => ({
        scope: "temporary",
        load: async () => ({ language: "French", model: "provider/model", mode: "manual" }),
        save: async () => {},
      }) as never,
    });

    await emit(harness, "session_start", { reason: "resume" });
    assert.equal(
      harness.transformer?.("Old source", { messageType: "assistant", isStreaming: false }),
      "*Translated · French*\n\nAncienne source",
    );

    branch.splice(0, branch.length, makeEntry("Other branch", "Autre branche"));
    await emit(harness, "session_tree", {});
    assert.equal(harness.transformer?.("Old source", { messageType: "assistant", isStreaming: false }), "Old source");
    assert.equal(
      harness.transformer?.("Other branch", { messageType: "assistant", isStreaming: false }),
      "*Translated · French*\n\nAutre branche",
    );
  });

  it("does not configure or write when turning off without valid configuration", async () => {
    let configureCalls = 0;
    const saves: TranslateConfig[] = [];
    const harness = createHarness([], {
      createStore: () => ({
        scope: "temporary",
        load: async () => undefined,
        save: async (config: TranslateConfig) => { saves.push(config); },
      }) as never,
      configure: async () => {
        configureCalls++;
        return { language: "French", model: "provider/model", mode: "manual" };
      },
    });
    await emit(harness, "session_start", { reason: "startup" });

    await harness.commands.get("translate")!.handler("off", harness.context);

    assert.equal(configureCalls, 0);
    assert.deepEqual(saves, []);
    assert.match(harness.notifications.at(-1)?.message ?? "", /already off/i);
  });

  it("persists first-use automatic mode in one completed configuration write", async () => {
    const saves: TranslateConfig[] = [];
    const harness = createHarness([], {
      createStore: () => ({
        scope: "temporary",
        load: async () => undefined,
        save: async (config: TranslateConfig) => { saves.push(config); },
      }) as never,
      configure: async () => ({ language: "French", model: "provider/model", mode: "manual" }),
    });
    await emit(harness, "session_start", { reason: "startup" });

    await harness.commands.get("translate")!.handler("on", harness.context);

    assert.deepEqual(saves, [{ language: "French", model: "provider/model", mode: "automatic" }]);
  });

  it("appends no manual card when translation is cancelled", async () => {
    const harness = createHarness(
      [{ type: "message", message: assistant("Leave this original") }],
      {
        configure: async () => ({ language: "French", model: "provider/model", mode: "manual" }),
        translate: async () => ({ ok: false, kind: "cancelled", error: "Translation cancelled." }),
      },
    );
    await emit(harness, "session_start", { reason: "startup" });

    await harness.commands.get("translate")!.handler("", harness.context);

    assert.equal(harness.entries.length, 0);
    assert.match(harness.notifications.at(-1)?.message ?? "", /cancelled/i);
  });
});
