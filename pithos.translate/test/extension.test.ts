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

function outputConfig(mode: "on" | "off" = "on"): TranslateConfig {
  return { output: { language: "French", model: "provider/model", mode } };
}

function inputConfig(mode: "on" | "off" = "on"): TranslateConfig {
  return { input: { model: "provider/input-model", mode } };
}

type Handler = (event: any, context: any) => unknown;

function createHarness(
  branch: unknown[],
  dependencies: TranslateDependencies,
  commandSources: Array<{ path: string; source: string; scope: "user" | "project" | "temporary"; origin: "package" | "top-level" }> = [
    { path: "/tmp/translate.ts", source: "translate", scope: "temporary", origin: "top-level" },
  ],
  resourceCommands: Array<{ name: string; source: "prompt" | "skill" }> = [],
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
  const editorTexts: string[] = [];
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
    getCommands: () => [
      ...commandSources.map((sourceInfo, index) => ({
        name: commandSources.length === 1 ? "translate" : `translate:${index + 1}`,
        description: commands.get("translate")?.description,
        source: "extension",
        sourceInfo,
      })),
      ...resourceCommands.map((command) => ({
        ...command,
        sourceInfo: { path: `/tmp/${command.name}.md`, source: command.name, scope: "temporary", origin: "top-level" },
      })),
    ],
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
    isIdle: () => true,
    ui: {
      notify: (message: string, type?: string) => notifications.push({ message, ...(type ? { type } : {}) }),
      setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
      setEditorText: (text: string) => editorTexts.push(text),
      theme: { fg: (_color: string, text: string) => text },
    },
    sessionManager: {
      getBranch: () => branch,
    },
    modelRegistry: {},
  };
  return { handlers, commands, entries, notifications, statuses, editorTexts, get transformer() { return transformer; }, renderers, context };
}

async function emit(harness: ReturnType<typeof createHarness>, event: string, payload: object = {}) {
  const results: unknown[] = [];
  for (const handler of harness.handlers.get(event) ?? []) results.push(await handler(payload, harness.context));
  return results;
}

interface CapturedLog {
  level: "info" | "error";
  event: string;
  metadata?: Record<string, unknown>;
}

function capturingLogger(entries: CapturedLog[]) {
  return {
    info: (event: string, metadata?: Record<string, unknown>) => entries.push({ level: "info", event, ...(metadata ? { metadata } : {}) }),
    error: (event: string, metadata?: Record<string, unknown>) => entries.push({ level: "error", event, ...(metadata ? { metadata } : {}) }),
  };
}

describe("translate extension", () => {
  it("suggests every supported argument after /translate ", () => {
    const harness = createHarness([], {});
    const command = harness.commands.get("translate")!;
    const completions = command.getArgumentCompletions;

    assert.match(command.description, /assistant output.*interactive input.*English/i);
    assert.deepEqual(
      completions?.("")?.map((item) => item.value),
      [
        "input-on",
        "input-off",
        "input-status",
        "input-config",
        "output-on",
        "output-off",
        "output-status",
        "output-config",
        "--help",
      ],
    );
  });

  it("filters argument suggestions by prefix and stops after the single argument", () => {
    const harness = createHarness([], {});
    const completions = harness.commands.get("translate")!.getArgumentCompletions!;

    assert.deepEqual(completions("input-o")?.map((item) => item.value), ["input-on", "input-off"]);
    assert.deepEqual(completions("output-st")?.map((item) => item.value), ["output-status"]);
    assert.deepEqual(completions("--h")?.map((item) => item.value), ["--help"]);
    assert.equal(completions("missing"), null);
    assert.equal(completions("output-on "), null);
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
        configure: async () => ({ language: "French", model: "provider/model", mode: "off" }),
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
    await harness.commands.get("translate")!.handler("output-status", harness.context);

    assert.equal(storeCreations, 0);
    assert.match(harness.notifications.at(-1)?.message ?? "", /source.*ambiguous|ambiguously.*source/i);
  });

  it("persists output changes in the loading scope without changing input settings", async () => {
    let stored: TranslateConfig = {
      input: { mode: "on", model: "provider/input" },
      output: { language: "French", model: "provider/model", mode: "off" },
    };
    const saves: TranslateConfig[] = [];
    const configuredFrom: unknown[] = [];
    const harness = createHarness([], {
      createStore: () => ({
        scope: "temporary",
        load: async () => stored,
        save: async (next: TranslateConfig) => {
          stored = next;
          saves.push(next);
        },
      }) as never,
      configure: async (_ctx, current) => {
        configuredFrom.push(current);
        return { language: "German", model: "other/exact", mode: current?.mode ?? "off" };
      },
    });
    await emit(harness, "session_start", { reason: "startup" });
    const command = harness.commands.get("translate")!;

    await command.handler("output-status", harness.context);
    assert.match(harness.notifications.at(-1)?.message ?? "", /temporary.*French.*provider\/model.*off.*60s/is);

    await command.handler("output-on", harness.context);
    assert.equal(stored.output?.mode, "on");
    await command.handler("output-off", harness.context);
    assert.equal(stored.output?.mode, "off");
    await command.handler("output-on", harness.context);
    await command.handler("output-config", harness.context);

    assert.deepEqual(stored.input, { mode: "on", model: "provider/input" });
    assert.deepEqual(stored.output, { language: "German", model: "other/exact", mode: "on" });
    assert.deepEqual(configuredFrom.at(-1), { language: "French", model: "provider/model", mode: "on" });
    assert.equal(saves.length, 4);
  });

  it("persists input changes without changing output settings", async () => {
    let stored: TranslateConfig = {
      input: { mode: "off", model: "provider/input-model" },
      output: { language: "French", model: "provider/output-model", mode: "on" },
    };
    const saves: TranslateConfig[] = [];
    const configuredFrom: unknown[] = [];
    const harness = createHarness([], {
      createStore: () => ({
        scope: "temporary",
        load: async () => stored,
        save: async (next: TranslateConfig) => {
          stored = next;
          saves.push(next);
        },
      }) as never,
      configureInput: async (_ctx, current) => {
        configuredFrom.push(current);
        return { model: "other/exact", mode: current?.mode ?? "off" };
      },
    });
    await emit(harness, "session_start", { reason: "startup" });
    const command = harness.commands.get("translate")!;

    await command.handler("input-status", harness.context);
    assert.match(harness.notifications.at(-1)?.message ?? "", /temporary.*English.*provider\/input-model.*off.*60s/is);
    await command.handler("input-on", harness.context);
    assert.equal(stored.input?.mode, "on");
    await command.handler("input-off", harness.context);
    assert.equal(stored.input?.mode, "off");
    await command.handler("input-on", harness.context);
    await command.handler("input-config", harness.context);

    assert.deepEqual(stored.output, { language: "French", model: "provider/output-model", mode: "on" });
    assert.deepEqual(stored.input, { model: "other/exact", mode: "on" });
    assert.deepEqual(configuredFrom.at(-1), { model: "provider/input-model", mode: "on" });
    assert.equal(saves.length, 4);
  });

  it("logs source-free main-model usage even when automatic output translation is off", async () => {
    const logs: CapturedLog[] = [];
    const response = {
      ...assistant("DO-NOT-LOG-ASSISTANT-TEXT"),
      provider: "main-provider",
      model: "coding-model",
      api: "responses",
      usage: {
        input: 21,
        output: 8,
        cacheRead: 5,
        cacheWrite: 2,
        totalTokens: 36,
        cost: { input: 0.02, output: 0.03, cacheRead: 0.01, cacheWrite: 0.005, total: 0.065 },
      },
    };
    const harness = createHarness([], {
      createStore: () => ({ scope: "temporary", load: async () => outputConfig("off"), save: async () => {} }) as never,
      logger: capturingLogger(logs),
    });
    await emit(harness, "session_start", { reason: "startup" });

    await emit(harness, "message_end", { type: "message_end", message: response });

    const entry = logs.find(({ event }) => event === "agent.response.complete");
    assert.deepEqual(entry?.metadata, {
      sessionId: undefined,
      provider: "main-provider",
      model: "coding-model",
      api: "responses",
      stopReason: "stop",
      usage: {
        inputTokens: 21,
        outputTokens: 8,
        cacheReadTokens: 5,
        cacheWriteTokens: 2,
        totalTokens: 36,
        costUsd: 0.065,
      },
    });
    assert.doesNotMatch(JSON.stringify(logs), /DO-NOT-LOG-ASSISTANT-TEXT/);
  });

  it("transforms ordinary idle TUI input into English, preserves attachments, and logs source-free usage", async () => {
    const images = [{ type: "image", source: { type: "base64", mediaType: "image/png", data: "image-data" } }];
    const calls: Array<{ source: string; config: unknown; registry: unknown }> = [];
    const logs: CapturedLog[] = [];
    const source = "Veuillez examiner l’implémentation.";
    const translated = "Please review the implementation.";
    const harness = createHarness([], {
      createStore: () => ({ scope: "temporary", load: async () => inputConfig(), save: async () => {} }) as never,
      translateInput: async (value, config, registry) => {
        calls.push({ source: value, config, registry });
        return { ok: true, markdown: translated, usage };
      },
      logger: capturingLogger(logs),
    });
    await emit(harness, "session_start", { reason: "startup" });

    const result = await emit(harness, "input", {
      type: "input",
      source: "interactive",
      text: source,
      images,
    });

    assert.deepEqual(result, [{ action: "transform", text: translated, images }]);
    assert.deepEqual(calls, [{
      source,
      config: { mode: "on", model: "provider/input-model" },
      registry: harness.context.modelRegistry,
    }]);
    assert.equal(harness.entries.length, 0);
    assert.deepEqual(harness.statuses.at(-1), { key: "pithos.translate.input", text: undefined });
    const logEntry = logs.find(({ event }) => event === "translation.input.complete");
    assert.equal(logEntry?.metadata?.language, "English");
    assert.equal(logEntry?.metadata?.model, "provider/input-model");
    assert.equal(logEntry?.metadata?.sourceChars, source.length);
    assert.equal(logEntry?.metadata?.changed, true);
    assert.deepEqual(logEntry?.metadata?.usage, {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 2,
      costUsd: 0,
    });
    assert.equal(typeof logEntry?.metadata?.durationMs, "number");
    assert.ok(!JSON.stringify(logs).includes(source));
    assert.ok(!JSON.stringify(logs).includes(translated));
  });

  it("preserves recognized directive tokens and translates only their arguments", async () => {
    const sources: string[] = [];
    const harness = createHarness([], {
      createStore: () => ({ scope: "temporary", load: async () => inputConfig(), save: async () => {} }) as never,
      translateInput: async (source) => {
        sources.push(source);
        return { ok: true, markdown: "Review this code.", usage };
      },
    }, undefined, [
      { name: "review", source: "prompt" },
      { name: "skill:inspect", source: "skill" },
    ]);
    await emit(harness, "session_start", { reason: "startup" });

    assert.deepEqual(await emit(harness, "input", {
      type: "input",
      source: "interactive",
      text: "/review   Révise ce code.",
    }), [{ action: "transform", text: "/review   Review this code." }]);
    assert.deepEqual(await emit(harness, "input", {
      type: "input",
      source: "interactive",
      text: "/skill:inspect",
    }), [{ action: "continue" }]);
    assert.deepEqual(sources, ["Révise ce code."]);
  });

  it("passes through disabled and extension-originated input", async () => {
    let calls = 0;
    const disabled = createHarness([], {
      createStore: () => ({ scope: "temporary", load: async () => inputConfig("off"), save: async () => {} }) as never,
      translateInput: async () => { calls++; return { ok: true, markdown: "Unexpected", usage }; },
    });
    await emit(disabled, "session_start", { reason: "startup" });
    assert.deepEqual(await emit(disabled, "input", {
      type: "input", source: "interactive", text: "Texte source",
    }), [{ action: "continue" }]);

    const enabled = createHarness([], {
      createStore: () => ({ scope: "temporary", load: async () => inputConfig(), save: async () => {} }) as never,
      translateInput: async () => { calls++; return { ok: true, markdown: "Unexpected", usage }; },
    });
    await emit(enabled, "session_start", { reason: "startup" });
    assert.deepEqual(await emit(enabled, "input", {
      type: "input", source: "extension", text: "Texte source",
    }), [{ action: "continue" }]);
    assert.equal(calls, 0);
  });

  it("blocks unsupported inbound paths without calling the translation model", async () => {
    const cases = [
      { name: "rpc source", event: { source: "rpc" } },
      { name: "steering", event: { source: "interactive", streamingBehavior: "steer" } },
      { name: "follow-up", event: { source: "interactive", streamingBehavior: "followUp" } },
      { name: "RPC mode", event: { source: "interactive" }, mode: "rpc" },
      { name: "print mode", event: { source: "interactive" }, mode: "print" },
      { name: "JSON mode", event: { source: "interactive" }, mode: "json" },
      { name: "non-idle", event: { source: "interactive" }, idle: false },
    ] as const;

    for (const testCase of cases) {
      let calls = 0;
      const harness = createHarness([], {
        createStore: () => ({ scope: "temporary", load: async () => inputConfig(), save: async () => {} }) as never,
        translateInput: async () => { calls++; return { ok: true, markdown: "Unexpected", usage }; },
      });
      harness.context.mode = "mode" in testCase ? testCase.mode : "tui";
      harness.context.isIdle = () => "idle" in testCase ? testCase.idle : true;
      await emit(harness, "session_start", { reason: "startup" });

      assert.deepEqual(await emit(harness, "input", {
        type: "input",
        text: `Unsupported ${testCase.name}`,
        ...testCase.event,
      }), [{ action: "handled" }], testCase.name);
      assert.equal(calls, 0, testCase.name);
    }
  });

  it("logs source-free dimensions when an unsupported inbound path is blocked", async () => {
    const logs: CapturedLog[] = [];
    const raw = "DO-NOT-LOG-BLOCKED-PROMPT";
    const harness = createHarness([], {
      createStore: () => ({ scope: "temporary", load: async () => inputConfig(), save: async () => {} }) as never,
      translateInput: async () => { throw new Error("must not translate"); },
      logger: capturingLogger(logs),
    });
    await emit(harness, "session_start", { reason: "startup" });

    await emit(harness, "input", {
      type: "input",
      source: "interactive",
      streamingBehavior: "steer",
      text: raw,
    });

    const entry = logs.find(({ event }) => event === "translation.input.blocked");
    assert.deepEqual(entry?.metadata, {
      sessionId: undefined,
      language: "English",
      model: "provider/input-model",
      sourceChars: raw.length,
      mode: "tui",
      inputSource: "interactive",
      streamingBehavior: "steer",
      idle: true,
    });
    assert.doesNotMatch(JSON.stringify(logs), new RegExp(raw));
  });

  it("fails closed, restores the TUI draft, and never logs or repeats raw input and provider errors", async () => {
    const raw = "RAW-SECRET-PROMPT";
    const providerError = `Provider echoed ${raw}`;
    const logs: CapturedLog[] = [];
    const harness = createHarness([], {
      createStore: () => ({ scope: "temporary", load: async () => inputConfig(), save: async () => {} }) as never,
      translateInput: async () => ({
        ok: false,
        kind: "request-failed",
        error: providerError,
        usage,
      }),
      logger: capturingLogger(logs),
    });
    await emit(harness, "session_start", { reason: "startup" });

    assert.deepEqual(await emit(harness, "input", {
      type: "input", source: "interactive", text: raw,
    }), [{ action: "handled" }]);
    assert.deepEqual(harness.editorTexts, [raw]);
    assert.ok(harness.notifications.every(({ message }) => !message.includes(raw)));
    assert.equal(harness.entries.length, 0);
    assert.deepEqual(harness.statuses.at(-1), { key: "pithos.translate.input", text: undefined });
    const logEntry = logs.find(({ event }) => event === "translation.input.failed");
    assert.equal(logEntry?.metadata?.kind, "request-failed");
    assert.deepEqual(logEntry?.metadata?.usage, {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 2,
      costUsd: 0,
    });
    assert.ok(!JSON.stringify(logs).includes(raw));
    assert.ok(!JSON.stringify(logs).includes(providerError));
  });

  it("fails closed and logs no exception text when the injected inbound translator throws", async () => {
    const raw = "Texte à conserver";
    const logs: CapturedLog[] = [];
    const harness = createHarness([], {
      createStore: () => ({ scope: "temporary", load: async () => inputConfig(), save: async () => {} }) as never,
      translateInput: async () => { throw new Error(`provider echoed ${raw}`); },
      logger: capturingLogger(logs),
    });
    await emit(harness, "session_start", { reason: "startup" });

    assert.deepEqual(await emit(harness, "input", {
      type: "input", source: "interactive", text: raw,
    }), [{ action: "handled" }]);
    assert.deepEqual(harness.editorTexts, [raw]);
    assert.ok(harness.notifications.every(({ message }) => !message.includes(raw)));
    assert.deepEqual(harness.statuses.at(-1), { key: "pithos.translate.input", text: undefined });
    const logEntry = logs.find(({ event }) => event === "translation.input.error");
    assert.equal(logEntry?.metadata?.kind, "unexpected-error");
    assert.equal(logEntry?.metadata?.sourceChars, raw.length);
    assert.ok(!JSON.stringify(logs).includes(raw));
    assert.ok(!JSON.stringify(logs).includes("provider echoed"));
  });

  it("makes no manual or automatic model call outside interactive TUI mode", async () => {
    let configureCalls = 0;
    let translationCalls = 0;
    const harness = createHarness(
      [{ type: "message", message: assistant("Manual source") }],
      {
        createStore: () => ({
          scope: "temporary",
          load: async () => outputConfig(),
          save: async () => {},
        }) as never,
        configure: async () => {
          configureCalls++;
          return { language: "French", model: "provider/model", mode: "off" };
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
        load: async () => outputConfig(),
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
    let stored: TranslateConfig = outputConfig();
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
    await harness.commands.get("translate")!.handler("output-off", harness.context);
    assert.deepEqual(harness.statuses.at(-1), { key: "pithos.translate", text: undefined });
    await finishTranslation(completion);

    await harness.commands.get("translate")!.handler("output-on", harness.context);
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
          load: async () => outputConfig(),
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
        load: async () => outputConfig(),
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
        load: async () => outputConfig(),
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
        load: async () => outputConfig(),
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
        load: async () => outputConfig(),
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
        load: async () => outputConfig(),
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
        load: async () => outputConfig(),
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
          load: async () => outputConfig(),
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
        load: async () => outputConfig(),
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
        load: async () => outputConfig(),
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
        load: async () => outputConfig(),
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
        load: async () => outputConfig("off"),
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

  it("does not configure or write either direction when turning off without configuration", async () => {
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
        return { language: "French", model: "provider/model", mode: "off" };
      },
      configureInput: async () => {
        configureCalls++;
        return { model: "provider/input-model", mode: "off" };
      },
    });
    await emit(harness, "session_start", { reason: "startup" });

    await harness.commands.get("translate")!.handler("input-off", harness.context);
    await harness.commands.get("translate")!.handler("output-off", harness.context);

    assert.equal(configureCalls, 0);
    assert.deepEqual(saves, []);
    assert.match(harness.notifications.at(-1)?.message ?? "", /already off/i);
  });

  it("persists first-use input mode in one valid unified configuration write", async () => {
    const saves: TranslateConfig[] = [];
    const harness = createHarness([], {
      createStore: () => ({
        scope: "temporary",
        load: async () => outputConfig("off"),
        save: async (config: TranslateConfig) => { saves.push(config); },
      }) as never,
      configureInput: async () => ({ model: "provider/input-model", mode: "off" }),
    });
    await emit(harness, "session_start", { reason: "startup" });

    await harness.commands.get("translate")!.handler("input-on", harness.context);

    assert.deepEqual(saves, [{
      input: { model: "provider/input-model", mode: "on" },
      output: { language: "French", model: "provider/model", mode: "off" },
    }]);
  });

  it("persists first-use automatic output mode in one valid unified configuration write", async () => {
    const saves: TranslateConfig[] = [];
    const harness = createHarness([], {
      createStore: () => ({
        scope: "temporary",
        load: async () => undefined,
        save: async (config: TranslateConfig) => { saves.push(config); },
      }) as never,
      configure: async () => ({ language: "French", model: "provider/model", mode: "off" }),
    });
    await emit(harness, "session_start", { reason: "startup" });

    await harness.commands.get("translate")!.handler("output-on", harness.context);

    assert.deepEqual(saves, [{ output: { language: "French", model: "provider/model", mode: "on" } }]);
  });

  it("appends no manual card when translation is cancelled", async () => {
    const harness = createHarness(
      [{ type: "message", message: assistant("Leave this original") }],
      {
        configure: async () => ({ language: "French", model: "provider/model", mode: "off" }),
        translate: async () => ({ ok: false, kind: "cancelled", error: "Translation cancelled." }),
      },
    );
    await emit(harness, "session_start", { reason: "startup" });

    await harness.commands.get("translate")!.handler("", harness.context);

    assert.equal(harness.entries.length, 0);
    assert.match(harness.notifications.at(-1)?.message ?? "", /cancelled/i);
  });
});
