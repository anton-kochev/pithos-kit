import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import contextBar from "../src/context-bar.ts";

const CONTEXT_BAR_EXTENSION_PATH = resolve(
  fileURLToPath(new URL("..", import.meta.url)),
  "extensions/index.ts",
);

type Handler = (event: any, context: any) => unknown;

const temporaryDirs: string[] = [];
after(() => {
  for (const path of temporaryDirs) rmSync(path, { recursive: true, force: true });
});

function temporaryAgentDir(): string {
  const path = mkdtempSync(resolve(tmpdir(), "context-bar-test-"));
  temporaryDirs.push(path);
  return path;
}

type HarnessOptions = {
  agentDir?: string;
  model?: any;
  providerAuth?: any;
  getProviderAuth?: (provider: string) => Promise<any>;
  isUsingOAuth?: () => boolean;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  offline?: boolean;
  codexUsageTimeoutMs?: number;
  codexUsageAuthPollMs?: number;
  commandInvocationNames?: string[];
  foreignCommandInvocationNames?: string[];
};

function codexToken(accountId = "account-123"): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })}.signature`;
}

function codexUsageResponse(primary = 68, secondary = 74): Response {
  return new Response(JSON.stringify({
    plan_type: "plus",
    rate_limit: {
      primary_window: { used_percent: primary },
      secondary_window: { used_percent: secondary },
    },
  }), { status: 200 });
}

function createHarness(branch: any[] = [], options: HarnessOptions = {}) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, {
    handler: Handler;
    description?: string;
    getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string; description?: string }> | null;
  }>();
  const entries: Array<{ type: string; data: unknown }> = [];
  const widgets: Array<{ key: string; content: unknown; options: unknown }> = [];
  const editorFactories: unknown[] = [];
  let editorFactory: unknown;
  const notifications: Array<{ message: string; type: string | undefined }> = [];
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  const autocompleteWrappers: Array<(current: any) => any> = [];
  const runtime = {
    systemPrompt: "",
    usage: { tokens: null as number | null, contextWindow: 100, percent: null as number | null },
    usageReads: 0,
    model: options.model ?? { provider: "openai", id: "gpt-test", contextWindow: 100 },
  };
  const pi = {
    on: (event: string, handler: Handler) => {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
    registerCommand: (name: string, options: {
      handler: Handler;
      description?: string;
      getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string; description?: string }> | null;
    }) => {
      commands.set(name, options);
    },
    appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
    getActiveTools: () => [],
    getAllTools: () => [],
    getCommands: () => [
      ...(options.commandInvocationNames ?? [...commands.keys()]).map((name) => ({
        name,
        source: "extension",
        sourceInfo: { path: CONTEXT_BAR_EXTENSION_PATH },
      })),
      ...(options.foreignCommandInvocationNames ?? []).map((name) => ({
        name,
        source: "extension",
        sourceInfo: { path: "/tmp/another-extension/index.ts" },
      })),
    ],
  };
  contextBar(pi as never, {
    agentDir: options.agentDir ?? temporaryAgentDir(),
    fetch: options.fetch,
    now: options.now,
    isOffline: () => options.offline ?? false,
    codexUsageTimeoutMs: options.codexUsageTimeoutMs,
    codexUsageAuthPollMs: options.codexUsageAuthPollMs,
  });

  const context = {
    mode: "tui",
    cwd: "/workspace/pi-extensions",
    hasUI: true,
    ui: {
      setWidget: (key: string, content: unknown, options: unknown) => {
        widgets.push({ key, content, options });
      },
      setEditorComponent: (factory: unknown) => {
        editorFactory = factory;
        editorFactories.push(factory);
      },
      getEditorComponent: () => editorFactory,
      notify: (message: string, type?: string) => notifications.push({ message, type }),
      setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
      addAutocompleteProvider: (wrapper: (current: any) => any) => autocompleteWrappers.push(wrapper),
      theme: { fg: (_color: string, text: string) => text },
    },
    get model() { return runtime.model; },
    modelRegistry: {
      isUsingOAuth: options.isUsingOAuth ?? (() => options.providerAuth?.source === "OAuth"),
      getProviderAuth: options.getProviderAuth ?? (async () => options.providerAuth),
    },
    sessionManager: {
      getBranch: () => branch,
      buildContextEntries: () => [],
    },
    getSystemPrompt: () => runtime.systemPrompt,
    getSystemPromptOptions: () => ({ cwd: "/repo" }),
    getContextUsage: () => {
      runtime.usageReads++;
      return runtime.usage;
    },
  };

  return { handlers, commands, entries, widgets, editorFactories, notifications, statuses, autocompleteWrappers, runtime, context };
}

async function emit(harness: ReturnType<typeof createHarness>, event: string, payload: object = {}) {
  for (const handler of harness.handlers.get(event) ?? []) {
    await handler({ type: event, ...payload }, harness.context);
  }
}

async function flushBackground(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate: () => boolean, timeoutMs = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail("condition was not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe("context-bar extension", () => {
  it("registers the command and installs an enabled above-editor widget for TUI sessions", async () => {
    const harness = createHarness();

    await emit(harness, "session_start", { reason: "startup" });

    assert.ok(harness.commands.has("context-bar"));
    assert.equal(harness.widgets.at(-1)?.key, "context-bar");
    assert.equal(typeof harness.widgets.at(-1)?.content, "function");
    assert.deepEqual(harness.widgets.at(-1)?.options, { placement: "aboveEditor" });
    assert.equal(typeof harness.editorFactories.at(-1), "function");
  });

  it("toggles the widget and persists each explicit state change", async () => {
    const harness = createHarness();
    await emit(harness, "session_start", { reason: "startup" });
    const command = harness.commands.get("context-bar")!;

    await command.handler("", harness.context);
    assert.equal(harness.widgets.at(-1)?.content, undefined);
    assert.equal(harness.editorFactories.at(-1), undefined);
    assert.deepEqual(harness.entries.at(-1), {
      type: "context-bar-enabled",
      data: { enabled: false },
    });

    await command.handler("", harness.context);
    assert.equal(typeof harness.widgets.at(-1)?.content, "function");
    assert.equal(typeof harness.editorFactories.at(-1), "function");
    assert.deepEqual(harness.entries.at(-1), {
      type: "context-bar-enabled",
      data: { enabled: true },
    });
  });

  it("opts an OpenAI subscription into the separate Codex account meter without changing models", async () => {
    const providers: string[] = [];
    const requests: string[] = [];
    const harness = createHarness([], {
      model: { provider: "openai", id: "gpt-test", contextWindow: 100 },
      isUsingOAuth: () => true,
      getProviderAuth: async provider => {
        providers.push(provider);
        return { source: "OAuth", auth: { apiKey: codexToken() } };
      },
      fetch: async url => { requests.push(String(url)); return codexUsageResponse(12, 34); },
    });
    const run = (arg: string) => harness.commands.get("context-bar")!.handler(arg, harness.context);
    await emit(harness, "session_start");
    await run("refresh");
    assert.deepEqual(providers, []);
    await run("codex-on");
    assert.deepEqual(harness.entries, []);
    assert.equal(harness.statuses.at(-1)?.text, "Codex · 5h 12% · week 34%");
    assert.deepEqual([...new Set(providers)], ["openai-codex"]);
    assert.deepEqual(requests, ["https://chatgpt.com/backend-api/wham/usage"]);
    assert.equal(harness.runtime.model.provider, "openai");
    await run("refresh");
    assert.equal(requests.length, 2);
    await run("status");
    assert.match(harness.notifications.at(-1)?.message ?? "", /week: 34% used/);
    await run("codex-off");
    assert.equal(harness.statuses.at(-1)?.text, undefined);
    await emit(harness, "agent_settled");
    assert.equal(requests.length, 2);
    await emit(harness, "session_shutdown");
  });

  it("keeps codex-on enabled in a new session with a fresh extension instance", async () => {
    const options = {
      agentDir: temporaryAgentDir(),
      providerAuth: { source: "OAuth", auth: { apiKey: codexToken() } },
      fetch: async () => codexUsageResponse(12, 34),
    };
    const first = createHarness([], options);
    await emit(first, "session_start");
    await first.commands.get("context-bar")!.handler("codex-on", first.context);
    await emit(first, "session_shutdown");

    const next = createHarness([], options);
    await emit(next, "session_start", { reason: "new" });
    await flushBackground();
    assert.equal(next.statuses.at(-1)?.text, "Codex · 5h 12% · week 34%");
    await emit(next, "session_shutdown");
  });

  it("keeps the saved Codex choice across resume, reload, fork, and tree navigation", async () => {
    const agentDir = temporaryAgentDir();
    const options = {
      agentDir,
      providerAuth: { source: "OAuth", auth: { apiKey: codexToken() } },
      fetch: async () => codexUsageResponse(12, 34),
    };
    const first = createHarness([], options);
    await first.commands.get("context-bar")!.handler("codex-on", first.context);
    await emit(first, "session_shutdown");

    for (const reason of ["resume", "reload", "fork"]) {
      const branch = [{ type: "custom", customType: "context-bar-openai-codex-meter", data: { enabled: false } }];
      const next = createHarness(branch, options);
      await emit(next, "session_start", { reason });
      await flushBackground();
      assert.equal(next.statuses.at(-1)?.text, "Codex · 5h 12% · week 34%", reason);
      await emit(next, "session_tree");
      await flushBackground();
      assert.equal(next.statuses.at(-1)?.text, "Codex · 5h 12% · week 34%", `${reason}: tree`);
      branch.pop();
      await emit(next, "session_tree");
      assert.equal(next.statuses.at(-1)?.text, "Codex · 5h 12% · week 34%", `${reason}: empty branch`);
      await emit(next, "session_shutdown");
    }
  });

  it("disables the opt-in and warns without breaking startup when preferences are invalid or unreadable", async () => {
    for (const contents of ["{broken", "null", "[]", "{}", '{"openAICodexMeter":"true"}', "directory"]) {
      const agentDir = temporaryAgentDir();
      const path = resolve(agentDir, "context-bar.json");
      if (contents === "directory") mkdirSync(path);
      else writeFileSync(path, contents);
      let authReads = 0;
      const harness = createHarness([
        { type: "custom", customType: "context-bar-openai-codex-meter", data: { enabled: true } },
      ], {
        agentDir,
        isUsingOAuth: () => true,
        getProviderAuth: async () => { authReads++; return undefined; },
      });
      await emit(harness, "session_start");
      await flushBackground();
      assert.equal(typeof harness.widgets.at(-1)?.content, "function", contents);
      assert.equal(authReads, 0, contents);
      assert.match(harness.notifications.at(-1)?.message ?? "", /could not read.*Codex meter.*off/i);
      assert.equal(harness.notifications.at(-1)?.type, "warning");
      await emit(harness, "session_shutdown");
    }
  });

  it("reports a failed save without changing the meter or claiming success, then allows retry", async () => {
    const agentDir = temporaryAgentDir();
    const path = resolve(agentDir, "context-bar.json");
    mkdirSync(path);
    const harness = createHarness([], {
      agentDir,
      providerAuth: { source: "OAuth", auth: { apiKey: codexToken() } },
      fetch: async () => codexUsageResponse(12, 34),
    });
    await emit(harness, "session_start");
    await harness.commands.get("context-bar")!.handler("codex-on", harness.context);
    assert.equal(harness.notifications.at(-1)?.type, "error");
    assert.match(harness.notifications.at(-1)?.message ?? "", /could not save.*unchanged/i);
    assert.equal(harness.statuses.at(-1)?.text, undefined);
    assert.deepEqual(harness.entries, []);
    assert.deepEqual(readdirSync(agentDir), ["context-bar.json"]);

    rmSync(path, { recursive: true });
    await harness.commands.get("context-bar")!.handler("codex-on", harness.context);
    assert.equal(harness.statuses.at(-1)?.text, "Codex · 5h 12% · week 34%");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { openAICodexMeter: true });
    await emit(harness, "session_shutdown");
  });

  it("persists codex-off over an earlier codex-on and ignores old enabled branch entries", async () => {
    let fetches = 0;
    const options = {
      agentDir: temporaryAgentDir(),
      providerAuth: { source: "OAuth", auth: { apiKey: codexToken() } },
      fetch: async () => { fetches++; return codexUsageResponse(); },
    };
    const first = createHarness([], options);
    await emit(first, "session_start");
    assert.deepEqual(readdirSync(options.agentDir), []);
    const command = first.commands.get("context-bar")!;
    await command.handler("codex-on", first.context);
    await command.handler("codex-off", first.context);
    assert.equal(first.statuses.at(-1)?.text, undefined);
    await emit(first, "session_shutdown");
    assert.deepEqual(JSON.parse(readFileSync(resolve(options.agentDir, "context-bar.json"), "utf8")), {
      openAICodexMeter: false,
    });

    for (const branch of [[], [{ type: "custom", customType: "context-bar-openai-codex-meter", data: { enabled: true } }]]) {
      const next = createHarness(branch, options);
      await emit(next, "session_start");
      await emit(next, "session_tree");
      await flushBackground();
      assert.equal(next.statuses.at(-1)?.text, undefined);
      assert.equal(fetches, 1);
      await emit(next, "session_shutdown");
    }
  });

  it("saves explicit Codex commands even when the current state already matches", async () => {
    for (const enabled of [true, false]) {
      const agentDir = temporaryAgentDir();
      const harness = createHarness([
        { type: "custom", customType: "context-bar-openai-codex-meter", data: { enabled } },
      ], { agentDir });
      await emit(harness, "session_start");
      assert.deepEqual(readdirSync(agentDir), []);
      const command = harness.commands.get("context-bar")!;
      await command.handler(enabled ? "codex-on" : "codex-off", harness.context);
      assert.deepEqual(JSON.parse(readFileSync(resolve(agentDir, "context-bar.json"), "utf8")), {
        openAICodexMeter: enabled,
      });
      assert.deepEqual(harness.entries, []);
      assert.match(harness.notifications.at(-1)?.message ?? "", /saved for future sessions/i);
      await emit(harness, "session_shutdown");
    }
  });

  it("updates the weekly countdown across the one-day boundary without refetching", async () => {
    let now = 1_900_000_000_000;
    let requests = 0;
    const harness = createHarness([], {
      providerAuth: { source: "OAuth", auth: { apiKey: codexToken() } },
      now: () => now,
      fetch: async () => {
        requests++;
        return Response.json({ rate_limit: { secondary_window: { used_percent: 6, reset_after_seconds: 86_400 } } });
      },
    });
    await harness.commands.get("context-bar")!.handler("codex-on", harness.context);
    assert.equal(harness.statuses.at(-1)?.text, "Codex · week 6% (resets in 1d)");
    now += 15_000;
    await emit(harness, "agent_settled");
    await flushBackground();
    assert.equal(harness.statuses.at(-1)?.text, "Codex · week 6% (resets in 23h)");
    assert.equal(requests, 1);
  });

  it("uses the legacy branch opt-in until a preference is saved and cancels requests when leaving that branch", async () => {
    const branch = [{ type: "custom", customType: "context-bar-openai-codex-meter", data: { enabled: true } }];
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { finish = resolve; });
    let requestSignal: AbortSignal | null | undefined;
    const harness = createHarness(branch, {
      providerAuth: { source: "OAuth", auth: { apiKey: codexToken() } },
      fetch: async (_url, init) => { requestSignal = init?.signal; return pending; },
    });
    await emit(harness, "session_start", { reason: "resume" });
    await flushBackground();
    assert.equal(requestSignal?.aborted, false);
    branch.pop();
    await emit(harness, "session_tree");
    assert.equal(requestSignal?.aborted, true);
    finish(codexUsageResponse());
    await flushBackground();
    assert.equal(harness.statuses.at(-1)?.text, undefined);
    await emit(harness, "session_shutdown");
  });

  it("does not resolve credentials for API-key OpenAI or unrelated providers even with the meter enabled", async () => {
    for (const [provider, oauth] of [["openai", false], ["anthropic", true]] as const) {
      let authReads = 0;
      const harness = createHarness([], {
        model: { provider, id: "test", contextWindow: 100 }, isUsingOAuth: () => oauth,
        getProviderAuth: async () => { authReads++; },
      });
      const command = harness.commands.get("context-bar")!;
      await command.handler("codex-on", harness.context);
      await command.handler("refresh", harness.context);
      assert.equal(authReads, 0);
      assert.equal(harness.statuses.at(-1)?.text, undefined);
    }
  });

  it("asks for the separate Codex login if it is missing and never falls back to the OpenAI token", async () => {
    const providers: string[] = [];
    let fetches = 0;
    const harness = createHarness([], {
      isUsingOAuth: () => true,
      getProviderAuth: async provider => {
        providers.push(provider);
        return provider === "openai" ? { source: "OAuth", auth: { apiKey: "openai-token" } } : undefined;
      },
      fetch: async () => { fetches++; return codexUsageResponse(); },
    });
    await harness.commands.get("context-bar")!.handler("codex-on", harness.context);
    assert.deepEqual(providers, ["openai-codex"]);
    assert.equal(fetches, 0);
    assert.equal(harness.statuses.at(-1)?.text, undefined);
    assert.match(harness.notifications.at(-1)?.message ?? "", /sign in to openai-codex/i);
  });

  it("starts Codex usage refresh when explicitly enabled", async () => {
    let fetches = 0;
    const harness = createHarness([
      { type: "custom", customType: "context-bar-enabled", data: { enabled: false } },
    ], {
      model: { provider: "openai-codex", id: "gpt-5.4", contextWindow: 100 },
      providerAuth: { auth: { apiKey: codexToken() }, source: "OAuth" },
      fetch: async () => {
        fetches++;
        return codexUsageResponse();
      },
    });
    await emit(harness, "session_start", { reason: "startup" });
    assert.equal(fetches, 0);

    await harness.commands.get("context-bar")!.handler("on", harness.context);

    assert.equal(fetches, 1);
    assert.equal(harness.statuses.at(-1)?.text, "Codex · 5h 68% · week 74%");
  });

  it("supports idempotent explicit on and off arguments", async () => {
    const harness = createHarness();
    await emit(harness, "session_start", { reason: "startup" });
    const command = harness.commands.get("context-bar")!;

    await command.handler("off", harness.context);
    assert.equal(harness.widgets.at(-1)?.content, undefined);
    assert.deepEqual(harness.entries.at(-1)?.data, { enabled: false });
    const entryCount = harness.entries.length;

    await command.handler("off", harness.context);
    assert.equal(harness.entries.length, entryCount);

    await command.handler("on", harness.context);
    assert.equal(typeof harness.widgets.at(-1)?.content, "function");
    assert.deepEqual(harness.entries.at(-1)?.data, { enabled: true });
  });

  it("reports the detailed status and legend without changing state", async () => {
    const harness = createHarness();
    await emit(harness, "session_start", { reason: "startup" });
    const command = harness.commands.get("context-bar")!;
    const widgetCount = harness.widgets.length;

    await command.handler("status", harness.context);

    assert.equal(harness.entries.length, 0);
    assert.equal(harness.widgets.length, widgetCount);
    assert.match(harness.notifications.at(-1)?.message ?? "", /context-bar is on/);
    assert.match(harness.notifications.at(-1)?.message ?? "", /Approximate composition:/);
  });

  it("does not block lifecycle completion on automatic Codex usage requests", async () => {
    for (const event of ["session_start", "model_select", "agent_settled"]) {
      const harness = createHarness([], {
        model: { provider: "openai-codex", id: "gpt-5.4", contextWindow: 100 },
        providerAuth: { auth: { apiKey: codexToken() }, source: "OAuth" },
        fetch: async () => new Promise<Response>(() => {}),
      });
      const handler = harness.handlers.get(event)![0]!;
      const completion = Promise.resolve(handler({ type: event, reason: "startup" }, harness.context))
        .then(() => "settled");
      const outcome = await Promise.race([
        completion,
        new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
      ]);
      assert.equal(outcome, "settled", `${event} should not await account usage`);
    }
  });

  it("shows both Codex used percentages for an OAuth-authenticated Codex model", async () => {
    let fetches = 0;
    const harness = createHarness([], {
      model: { provider: "openai-codex", id: "gpt-5.4", contextWindow: 100 },
      providerAuth: { auth: { apiKey: codexToken() }, source: "OAuth" },
      fetch: async () => {
        fetches++;
        return codexUsageResponse();
      },
      now: () => 1_900_000_000_000,
    });

    await emit(harness, "session_start", { reason: "startup" });
    await flushBackground();

    assert.equal(fetches, 1);
    assert.deepEqual(harness.statuses.at(-1), {
      key: "context-bar-codex-usage",
      text: "Codex · 5h 68% · week 74%",
    });
  });

  it("throttles automatic Codex usage checks for one minute and lets refresh bypass the cache", async () => {
    let currentTime = 1_900_000_000_000;
    let fetches = 0;
    const harness = createHarness([], {
      model: { provider: "openai-codex", id: "gpt-5.4", contextWindow: 100 },
      providerAuth: { auth: { apiKey: codexToken() }, source: "OAuth" },
      fetch: async () => codexUsageResponse(++fetches === 1 ? 10 : 20, 30),
      now: () => currentTime,
    });

    await emit(harness, "session_start", { reason: "startup" });
    await flushBackground();
    currentTime += 30_000;
    await emit(harness, "agent_settled");
    await flushBackground();
    assert.equal(fetches, 1);

    await harness.commands.get("context-bar")!.handler("refresh", harness.context);
    assert.equal(fetches, 2);
    assert.equal(harness.statuses.at(-1)?.text, "Codex · 5h 20% · week 30%");

    currentTime += 60_000;
    await emit(harness, "agent_settled");
    await flushBackground();
    assert.equal(fetches, 3);
  });

  it("invalidates cached usage when the OAuth account changes within the throttle window", async () => {
    let currentAuth = { auth: { apiKey: codexToken("account-a") }, source: "OAuth" };
    let fetches = 0;
    const harness = createHarness([], {
      model: { provider: "openai-codex", id: "gpt-5.4", contextWindow: 100 },
      providerAuth: { source: "OAuth" },
      getProviderAuth: async () => currentAuth,
      fetch: async (_input, init) => {
        fetches++;
        const accountId = new Headers(init?.headers).get("chatgpt-account-id");
        return accountId === "account-a" ? codexUsageResponse(12, 34) : codexUsageResponse(56, 78);
      },
    });

    await emit(harness, "session_start", { reason: "startup" });
    await flushBackground();
    assert.equal(harness.statuses.at(-1)?.text, "Codex · 5h 12% · week 34%");

    currentAuth = { auth: { apiKey: codexToken("account-b") }, source: "OAuth" };
    await emit(harness, "agent_settled");
    await flushBackground();

    assert.equal(fetches, 2);
    assert.equal(harness.statuses.at(-1)?.text, "Codex · 5h 56% · week 78%");
  });

  it("discards an in-flight response when the OAuth account changes", async () => {
    let currentAuth = { auth: { apiKey: codexToken("account-a") }, source: "OAuth" };
    let resolveFirst!: (response: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    let fetches = 0;
    const harness = createHarness([], {
      model: { provider: "openai-codex", id: "gpt-5.4", contextWindow: 100 },
      providerAuth: { source: "OAuth" },
      getProviderAuth: async () => currentAuth,
      fetch: async () => ++fetches === 1 ? firstResponse : codexUsageResponse(56, 78),
    });

    await emit(harness, "session_start", { reason: "startup" });
    await flushBackground();
    currentAuth = { auth: { apiKey: codexToken("account-b") }, source: "OAuth" };
    resolveFirst(codexUsageResponse(12, 34));
    await flushBackground();

    assert.equal(fetches, 2);
    assert.equal(harness.statuses.at(-1)?.text, "Codex · 5h 56% · week 78%");
    assert.equal(harness.statuses.some(({ text }) => text === "Codex · 5h 12% · week 34%"), false);
  });

  it("does not restore stale usage when an in-flight refresh fails after an account change", async () => {
    let currentAuth = { auth: { apiKey: codexToken("account-a") }, source: "OAuth" };
    let rejectSecond!: (error: Error) => void;
    const secondResponse = new Promise<Response>((_resolve, reject) => { rejectSecond = reject; });
    let fetches = 0;
    const harness = createHarness([], {
      model: { provider: "openai-codex", id: "gpt-5.4", contextWindow: 100 },
      providerAuth: { source: "OAuth" },
      getProviderAuth: async () => currentAuth,
      fetch: async () => {
        fetches++;
        if (fetches === 1) return codexUsageResponse(12, 34);
        if (fetches === 2) return secondResponse;
        return codexUsageResponse(56, 78);
      },
    });

    await emit(harness, "session_start", { reason: "startup" });
    await flushBackground();
    const statusCount = harness.statuses.length;
    const refresh = harness.commands.get("context-bar")!.handler("refresh", harness.context);
    await flushBackground();
    currentAuth = { auth: { apiKey: codexToken("account-b") }, source: "OAuth" };
    rejectSecond(new Error("temporary failure"));
    await refresh;

    assert.equal(fetches, 3);
    assert.equal(harness.statuses.at(-1)?.text, "Codex · 5h 56% · week 78%");
    assert.equal(
      harness.statuses.slice(statusCount).some(({ text }) => text === "Codex · 5h 12% · week 34% · stale"),
      false,
    );
  });

  it("does not retain stale usage when a refresh times out after an account change", async () => {
    let currentAuth = { auth: { apiKey: codexToken("account-a") }, source: "OAuth" };
    let fetches = 0;
    const harness = createHarness([], {
      model: { provider: "openai-codex", id: "gpt-5.4", contextWindow: 100 },
      providerAuth: { source: "OAuth" },
      getProviderAuth: async () => currentAuth,
      fetch: async () => ++fetches === 1 ? codexUsageResponse(12, 34) : new Promise<Response>(() => {}),
      codexUsageTimeoutMs: 5,
    });

    await emit(harness, "session_start", { reason: "startup" });
    await flushBackground();
    const statusCount = harness.statuses.length;
    const refresh = harness.commands.get("context-bar")!.handler("refresh", harness.context);
    await new Promise((resolve) => setImmediate(resolve));
    currentAuth = { auth: { apiKey: codexToken("account-b") }, source: "OAuth" };
    await refresh;

    assert.equal(fetches, 2);
    assert.equal(harness.statuses.at(-1)?.text, "Codex · usage unavailable");
    assert.equal(
      harness.statuses.slice(statusCount).some(({ text }) => text?.includes("5h 12%") ?? false),
      false,
    );
  });

  it("does not automatically retry a timed-out endpoint before one minute", async () => {
    let currentTime = 1_000_000;
    let fetches = 0;
    const harness = createHarness([], {
      model: { provider: "openai-codex", id: "gpt-5.4", contextWindow: 100 },
      providerAuth: { auth: { apiKey: codexToken() }, source: "OAuth" },
      fetch: async () => ++fetches === 1 ? new Promise<Response>(() => {}) : codexUsageResponse(),
      now: () => currentTime,
      codexUsageTimeoutMs: 5,
    });

    await emit(harness, "session_start", { reason: "startup" });
    await waitFor(() => harness.statuses.at(-1)?.text === "Codex · usage unavailable");
    assert.equal(fetches, 1);

    currentTime += 30_000;
    await emit(harness, "agent_settled");
    await flushBackground();
    assert.equal(fetches, 1);

    currentTime += 31_000;
    await emit(harness, "agent_settled");
    await waitFor(() => fetches === 2);
    assert.equal(harness.statuses.at(-1)?.text, "Codex · 5h 68% · week 74%");
    await emit(harness, "session_shutdown");
  });

  it("clears cached usage when OAuth authentication disappears", async () => {
    let currentAuth: any = { auth: { apiKey: codexToken() }, source: "OAuth" };
    const harness = createHarness([], {
      model: { provider: "openai-codex", id: "gpt-5.4", contextWindow: 100 },
      providerAuth: { source: "OAuth" },
      getProviderAuth: async () => currentAuth,
      fetch: async () => codexUsageResponse(),
    });

    await emit(harness, "session_start", { reason: "startup" });
    await flushBackground();
    assert.equal(harness.statuses.at(-1)?.text, "Codex · 5h 68% · week 74%");

    currentAuth = undefined;
    await emit(harness, "agent_settled");
    await flushBackground();

    assert.deepEqual(harness.statuses.at(-1), { key: "context-bar-codex-usage", text: undefined });
  });

  it("clears cached usage when account identity cannot be revalidated", async () => {
    let rejectAuth = false;
    const harness = createHarness([], {
      model: { provider: "openai-codex", id: "gpt-5.4", contextWindow: 100 },
      providerAuth: { source: "OAuth" },
      getProviderAuth: async () => {
        if (rejectAuth) throw new Error("credential storage unavailable");
        return { auth: { apiKey: codexToken("account-a") }, source: "OAuth" };
      },
      fetch: async () => codexUsageResponse(12, 34),
    });

    await emit(harness, "session_start", { reason: "startup" });
    await flushBackground();
    rejectAuth = true;
    await emit(harness, "agent_settled");
    await flushBackground();

    assert.equal(harness.statuses.at(-1)?.text, "Codex · usage unavailable");
    assert.notEqual(harness.statuses.at(-1)?.text, "Codex · 5h 12% · week 34% · stale");
  });

  it("does not erase endpoint throttling when an auth check transiently fails", async () => {
    let currentTime = 1_000_000;
    let rejectAuth = false;
    let fetches = 0;
    const harness = createHarness([], {
      model: { provider: "openai-codex", id: "gpt-5.4", contextWindow: 100 },
      providerAuth: { source: "OAuth" },
      getProviderAuth: async () => {
        if (rejectAuth) throw new Error("credential storage unavailable");
        return { auth: { apiKey: codexToken() }, source: "OAuth" };
      },
      fetch: async () => {
        fetches++;
        return codexUsageResponse();
      },
      now: () => currentTime,
    });

    await emit(harness, "session_start", { reason: "startup" });
    await flushBackground();
    assert.equal(fetches, 1);

    currentTime += 30_000;
    rejectAuth = true;
    await emit(harness, "agent_settled");
    await flushBackground();
    rejectAuth = false;

    currentTime += 15_000;
    await emit(harness, "agent_settled");
    await flushBackground();
    assert.equal(fetches, 1);

    currentTime += 16_000;
    await emit(harness, "agent_settled");
    await flushBackground();
    assert.equal(fetches, 2);
  });

  it("preserves a forced refresh while joining an automatic auth check", async () => {
    let currentTime = 1_000_000;
    let authGate: Promise<any> | undefined;
    let resolveAuth!: (auth: any) => void;
    let fetches = 0;
    const auth = { auth: { apiKey: codexToken() }, source: "OAuth" };
    const harness = createHarness([], {
      model: { provider: "openai-codex", id: "gpt-5.4", contextWindow: 100 },
      providerAuth: { source: "OAuth" },
      getProviderAuth: async () => authGate ?? auth,
      fetch: async () => {
        fetches++;
        return codexUsageResponse();
      },
      now: () => currentTime,
    });

    await emit(harness, "session_start", { reason: "startup" });
    await flushBackground();
    assert.equal(fetches, 1);

    currentTime += 30_000;
    authGate = new Promise((resolve) => { resolveAuth = resolve; });
    await emit(harness, "agent_settled");
    await new Promise((resolve) => setImmediate(resolve));
    const forced = harness.commands.get("context-bar")!.handler("refresh", harness.context);
    resolveAuth(auth);
    await forced;

    assert.equal(fetches, 2);
    assert.equal(harness.notifications.at(-1)?.message, "Codex usage refreshed");
  });

  it("clears cached usage when commands observe that OAuth was removed", async () => {
    let usingOAuth = true;
    const harness = createHarness([], {
      model: { provider: "openai-codex", id: "gpt-5.4", contextWindow: 100 },
      providerAuth: { auth: { apiKey: codexToken() }, source: "OAuth" },
      isUsingOAuth: () => usingOAuth,
      fetch: async () => codexUsageResponse(),
    });

    await emit(harness, "session_start", { reason: "startup" });
    await flushBackground();
    usingOAuth = false;
    await harness.commands.get("context-bar")!.handler("refresh", harness.context);
    assert.deepEqual(harness.statuses.at(-1), { key: "context-bar-codex-usage", text: undefined });

    await harness.commands.get("context-bar")!.handler("status", harness.context);
    assert.doesNotMatch(harness.notifications.at(-1)?.message ?? "", /Codex usage ·|5h 68%/);
  });

  it("does not let pending account revalidation restore usage after OAuth is removed", async () => {
    for (const action of ["refresh", "status"]) {
      let usingOAuth = true;
      let authCalls = 0;
      let releaseFinalAuth!: (auth: any) => void;
      const finalAuth = new Promise<any>((resolve) => { releaseFinalAuth = resolve; });
      const auth = { auth: { apiKey: codexToken() }, source: "OAuth" };
      const harness = createHarness([], {
        model: { provider: "openai-codex", id: "gpt-5.4", contextWindow: 100 },
        providerAuth: auth,
        isUsingOAuth: () => usingOAuth,
        getProviderAuth: async () => ++authCalls === 2 ? finalAuth : auth,
        fetch: async () => codexUsageResponse(),
      });

      await emit(harness, "session_start", { reason: "startup" });
      await flushBackground();
      assert.equal(authCalls, 2);
      usingOAuth = false;
      await harness.commands.get("context-bar")!.handler(action, harness.context);
      releaseFinalAuth(auth);
      await flushBackground();

      assert.deepEqual(
        harness.statuses.at(-1),
        { key: "context-bar-codex-usage", text: undefined },
        `${action} should keep obsolete work cleared`,
      );
    }
  });

  it("clears cached usage when commands observe offline mode", async () => {
    const options: HarnessOptions = {
      model: { provider: "openai-codex", id: "gpt-5.4", contextWindow: 100 },
      providerAuth: { auth: { apiKey: codexToken() }, source: "OAuth" },
      fetch: async () => codexUsageResponse(),
      offline: false,
    };
    const harness = createHarness([], options);

    await emit(harness, "session_start", { reason: "startup" });
    await flushBackground();
    options.offline = true;
    await harness.commands.get("context-bar")!.handler("refresh", harness.context);
    assert.deepEqual(harness.statuses.at(-1), { key: "context-bar-codex-usage", text: undefined });

    await harness.commands.get("context-bar")!.handler("status", harness.context);
    assert.doesNotMatch(harness.notifications.at(-1)?.message ?? "", /Codex usage ·|5h 68%/);
  });

  it("observes logout and account login changes without a Context Bar command", async () => {
    let usingOAuth = true;
    let currentAuth = { auth: { apiKey: codexToken("account-a") }, source: "OAuth" };
    const harness = createHarness([], {
      model: { provider: "openai-codex", id: "gpt-5.4", contextWindow: 100 },
      providerAuth: { source: "OAuth" },
      isUsingOAuth: () => usingOAuth,
      getProviderAuth: async () => currentAuth,
      fetch: async (_input, init) => {
        const accountId = new Headers(init?.headers).get("chatgpt-account-id");
        return accountId === "account-a" ? codexUsageResponse(12, 34) : codexUsageResponse(56, 78);
      },
      codexUsageAuthPollMs: 5,
    });

    await emit(harness, "session_start", { reason: "startup" });
    await waitFor(() => harness.statuses.at(-1)?.text === "Codex · 5h 12% · week 34%");

    usingOAuth = false;
    await waitFor(() => harness.statuses.at(-1)?.text === undefined);

    currentAuth = { auth: { apiKey: codexToken("account-b") }, source: "OAuth" };
    usingOAuth = true;
    await waitFor(() => harness.statuses.at(-1)?.text === "Codex · 5h 56% · week 78%");
    await emit(harness, "session_shutdown");
  });

  it("deduplicates concurrent Codex usage refreshes", async () => {
    let fetches = 0;
    let resolveResponse!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => { resolveResponse = resolve; });
    const harness = createHarness([], {
      model: { provider: "openai-codex", id: "gpt-5.4", contextWindow: 100 },
      providerAuth: { auth: { apiKey: codexToken() }, source: "OAuth" },
      fetch: async () => {
        fetches++;
        return response;
      },
    });

    const startup = emit(harness, "session_start", { reason: "startup" });
    const settled = emit(harness, "agent_settled");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fetches, 1);

    resolveResponse(codexUsageResponse());
    await Promise.all([startup, settled]);
    await flushBackground();
    assert.equal(harness.statuses.at(-1)?.text, "Codex · 5h 68% · week 74%");
  });

  it("retains successful Codex usage as stale when a forced refresh fails", async () => {
    let shouldFail = false;
    const harness = createHarness([], {
      model: { provider: "openai-codex", id: "gpt-5.4", contextWindow: 100 },
      providerAuth: { auth: { apiKey: codexToken() }, source: "OAuth" },
      fetch: async () => shouldFail
        ? new Response("upstream secret", { status: 503 })
        : codexUsageResponse(),
      now: () => 1_900_000_000_000,
    });
    await emit(harness, "session_start", { reason: "startup" });
    await flushBackground();

    shouldFail = true;
    await harness.commands.get("context-bar")!.handler("refresh", harness.context);

    assert.equal(harness.statuses.at(-1)?.text, "Codex · 5h 68% · week 74% · stale");
    assert.equal(harness.notifications.at(-1)?.type, "warning");
    assert.match(harness.notifications.at(-1)?.message ?? "", /HTTP 503/);
    assert.doesNotMatch(harness.notifications.at(-1)?.message ?? "", /upstream secret/);

    await harness.commands.get("context-bar")!.handler("status", harness.context);
    assert.match(harness.notifications.at(-1)?.message ?? "", /Last refresh failed:.*HTTP 503/);
  });

  it("includes Codex plan, reset, and freshness details in context-bar status", async () => {
    const now = 1_900_000_000_000;
    const harness = createHarness([], {
      model: { provider: "openai-codex", id: "gpt-5.4", contextWindow: 100 },
      providerAuth: { auth: { apiKey: codexToken() }, source: "OAuth" },
      fetch: async () => new Response(JSON.stringify({
        plan_type: "pro",
        rate_limit: {
          primary_window: { used_percent: 12, reset_at: now / 1000 + 3_600 },
          secondary_window: { used_percent: 34, reset_at: now / 1000 + 172_800 },
        },
      })),
      now: () => now,
    });
    await emit(harness, "session_start", { reason: "startup" });
    await flushBackground();

    await harness.commands.get("context-bar")!.handler("status", harness.context);

    const status = harness.notifications.at(-1)?.message ?? "";
    assert.match(status, /Approximate composition:/);
    assert.match(status, /Codex usage · Pro plan/);
    assert.equal(harness.statuses.at(-1)?.text, "Codex · 5h 12% (resets in 1h) · week 34% (resets in 2d)");
    assert.match(status, /5h: 12% used · resets in 1h/);
    assert.match(status, /week: 34% used · resets in 2d/);
    assert.match(status, /Updated 0m ago/);
  });

  it("starts a replacement refresh when switching away from and back to Codex", async () => {
    let resolveFirst!: (response: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    let fetches = 0;
    const harness = createHarness([], {
      model: { provider: "openai-codex", id: "gpt-5.4", contextWindow: 100 },
      providerAuth: { auth: { apiKey: codexToken() }, source: "OAuth" },
      fetch: async () => ++fetches === 1 ? firstResponse : codexUsageResponse(21, 43),
    });

    await emit(harness, "session_start", { reason: "startup" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fetches, 1);

    harness.runtime.model = { provider: "openai", id: "gpt-test", contextWindow: 100 };
    await emit(harness, "model_select");
    harness.runtime.model = { provider: "openai-codex", id: "gpt-5.4", contextWindow: 100 };
    await emit(harness, "model_select");
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(fetches, 2);
    assert.equal(harness.statuses.at(-1)?.text, "Codex · 5h 21% · week 43%");
    resolveFirst(codexUsageResponse());
  });

  it("ignores an in-flight Codex result after switching providers", async () => {
    let resolveResponse!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => { resolveResponse = resolve; });
    const harness = createHarness([], {
      model: { provider: "openai-codex", id: "gpt-5.4", contextWindow: 100 },
      providerAuth: { auth: { apiKey: codexToken() }, source: "OAuth" },
      fetch: async () => response,
    });

    const startup = emit(harness, "session_start", { reason: "startup" });
    await new Promise((resolve) => setImmediate(resolve));
    harness.runtime.model = { provider: "openai", id: "gpt-test", contextWindow: 100 };
    await emit(harness, "model_select");
    resolveResponse(codexUsageResponse());
    await startup;

    assert.deepEqual(harness.statuses.at(-1), { key: "context-bar-codex-usage", text: undefined });
  });

  it("replaces pending OAuth resolution after disable and re-enable", async () => {
    let authCalls = 0;
    const harness = createHarness([], {
      model: { provider: "openai-codex", id: "gpt-5.4", contextWindow: 100 },
      providerAuth: { source: "OAuth" },
      getProviderAuth: async () => {
        authCalls++;
        if (authCalls === 1) return new Promise(() => {});
        return { auth: { apiKey: codexToken() }, source: "OAuth" };
      },
      fetch: async () => codexUsageResponse(),
    });

    await emit(harness, "session_start", { reason: "startup" });
    await flushBackground();
    await harness.commands.get("context-bar")!.handler("off", harness.context);
    await harness.commands.get("context-bar")!.handler("on", harness.context);

    assert.ok(authCalls >= 2);
    assert.equal(harness.statuses.at(-1)?.text, "Codex · 5h 68% · week 74%");
  });

  it("ignores late OAuth resolution after shutdown", async () => {
    let resolveAuth!: (auth: any) => void;
    const auth = new Promise<any>((resolve) => { resolveAuth = resolve; });
    const harness = createHarness([], {
      model: { provider: "openai-codex", id: "gpt-5.4", contextWindow: 100 },
      providerAuth: { source: "OAuth" },
      getProviderAuth: async () => auth,
      fetch: async () => codexUsageResponse(),
    });

    await emit(harness, "session_start", { reason: "startup" });
    await flushBackground();
    await emit(harness, "session_shutdown");
    resolveAuth({ auth: { apiKey: codexToken() }, source: "OAuth" });
    await flushBackground();

    assert.deepEqual(harness.statuses.at(-1), { key: "context-bar-codex-usage", text: undefined });
  });

  it("clears Codex usage when switching providers, disabling, or shutting down", async () => {
    let fetches = 0;
    const harness = createHarness([], {
      model: { provider: "openai-codex", id: "gpt-5.4", contextWindow: 100 },
      providerAuth: { auth: { apiKey: codexToken() }, source: "OAuth" },
      fetch: async () => {
        fetches++;
        return codexUsageResponse();
      },
    });
    await emit(harness, "session_start", { reason: "startup" });
    await flushBackground();

    harness.runtime.model = { provider: "openai", id: "gpt-test", contextWindow: 100 };
    await emit(harness, "model_select");
    assert.deepEqual(harness.statuses.at(-1), { key: "context-bar-codex-usage", text: undefined });

    harness.runtime.model = { provider: "openai-codex", id: "gpt-5.4", contextWindow: 100 };
    await harness.commands.get("context-bar")!.handler("off", harness.context);
    await emit(harness, "agent_settled");
    assert.equal(fetches, 1);
    assert.equal(harness.statuses.at(-1)?.text, undefined);

    await emit(harness, "session_shutdown", { reason: "quit" });
    assert.equal(harness.statuses.at(-1)?.text, undefined);
  });

  it("does not query Codex usage in offline mode", async () => {
    let fetches = 0;
    const harness = createHarness([], {
      model: { provider: "openai-codex", id: "gpt-5.4", contextWindow: 100 },
      providerAuth: { auth: { apiKey: codexToken() }, source: "OAuth" },
      fetch: async () => {
        fetches++;
        return codexUsageResponse();
      },
      offline: true,
    });

    await emit(harness, "session_start", { reason: "startup" });

    assert.equal(fetches, 0);
    assert.equal(harness.statuses.at(-1)?.text, undefined);
  });

  it("restores the latest enabled state from the active session branch", async () => {
    const harness = createHarness([
      { type: "custom", customType: "context-bar-enabled", data: { enabled: true } },
      { type: "custom", customType: "context-bar-enabled", data: { enabled: false } },
    ]);

    await emit(harness, "session_start", { reason: "resume" });

    assert.equal(harness.widgets.at(-1)?.content, undefined);
  });

  it("observes prompt, context, model, compaction, message, and settled lifecycle boundaries", () => {
    const harness = createHarness();
    const expectedEvents = [
      "before_agent_start",
      "agent_start",
      "context",
      "message_end",
      "agent_settled",
      "model_select",
      "session_compact",
      "session_tree",
      "session_shutdown",
    ];

    for (const event of expectedEvents) {
      assert.ok(harness.handlers.has(event), `missing ${event} handler`);
    }
  });

  it("skips snapshot recomputation while disabled", async () => {
    const harness = createHarness();
    await emit(harness, "session_start", { reason: "startup" });
    await harness.commands.get("context-bar")!.handler("off", harness.context);
    const readsWhileDisabling = harness.runtime.usageReads;

    await emit(harness, "context", { messages: [{ role: "user", content: "large context" }] });
    await emit(harness, "agent_settled", {});

    assert.equal(harness.runtime.usageReads, readsWhileDisabling);
  });

  it("uses a local total when a changed effective request makes provider usage stale", async () => {
    const harness = createHarness();
    await emit(harness, "session_start", { reason: "startup" });
    harness.runtime.usage = { tokens: 90, contextWindow: 100, percent: 90 };
    await emit(harness, "message_end", {
      message: {
        role: "assistant",
        provider: "openai",
        model: "gpt-test",
        stopReason: "stop",
        usage: { totalTokens: 90 },
        content: [],
      },
    });
    const renderLatest = () => {
      const factory = harness.widgets.at(-1)?.content as (tui: unknown, theme: unknown) => {
        render(width: number): string[];
      };
      const component = factory(
        { requestRender: () => {} },
        { fg: (_color: string, text: string) => text },
      );
      return component.render(12)[0]!;
    };
    assert.ok(renderLatest().endsWith("90%"));

    const changedPrompt = "p".repeat(400);
    await emit(harness, "before_agent_start", {
      prompt: "next",
      systemPrompt: changedPrompt,
      systemPromptOptions: { cwd: "/repo" },
    });

    assert.ok(renderLatest().endsWith("100%"));
  });

  it("refreshes at lifecycle boundaries and clears the widget on shutdown", async () => {
    const harness = createHarness();
    await emit(harness, "session_start", { reason: "startup" });
    const initialWidgetCount = harness.widgets.length;

    await emit(harness, "before_agent_start", {
      prompt: "hello",
      systemPrompt: "system",
      systemPromptOptions: { cwd: "/repo" },
    });
    await emit(harness, "context", { messages: [{ role: "user", content: "hello" }] });
    await emit(harness, "model_select", {});
    await emit(harness, "session_compact", {});

    assert.equal(harness.widgets.length, initialWidgetCount);
    assert.equal(typeof harness.widgets.at(-1)?.content, "function");

    await emit(harness, "session_shutdown", { reason: "reload" });
    assert.equal(harness.widgets.length, initialWidgetCount + 1);
    assert.equal(harness.widgets.at(-1)?.content, undefined);
    assert.equal(harness.editorFactories.at(-1), undefined);
  });

  it("shows argument suggestions when Tab forces completion after the command", async () => {
    const harness = createHarness();
    await emit(harness, "session_start", { reason: "startup" });
    assert.equal(harness.autocompleteWrappers.length, 1);

    let delegated = 0;
    const base = {
      getSuggestions: async () => { delegated++; return null; },
      applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }),
      shouldTriggerFileCompletion: () => true,
    };
    const provider = harness.autocompleteWrappers[0]!(base);
    const suggestions = await provider.getSuggestions(
      ["/context-bar "],
      0,
      "/context-bar ".length,
      { force: true, signal: new AbortController().signal },
    );

    assert.deepEqual(suggestions?.items.map(({ value }: { value: string }) => value), [
      "on", "off", "status", "refresh", "codex-on", "codex-off", "--help",
    ]);
    assert.equal(suggestions?.prefix, "");
    assert.equal(delegated, 0);
    assert.equal(provider.shouldTriggerFileCompletion(["/context-bar "], 0, 13), true);

    const filtered = await provider.getSuggestions(
      ["/context-bar re"],
      0,
      "/context-bar re".length,
      { force: true, signal: new AbortController().signal },
    );
    assert.deepEqual(filtered?.items.map(({ value }: { value: string }) => value), ["refresh"]);

    const completed = await provider.getSuggestions(
      ["/context-bar status "],
      0,
      "/context-bar status ".length,
      { force: true, signal: new AbortController().signal },
    );
    assert.equal(completed, null);

    await provider.getSuggestions(["ordinary text"], 0, 13, {
      force: true,
      signal: new AbortController().signal,
    });
    assert.equal(delegated, 1);
    await emit(harness, "session_shutdown");
  });

  it("supports Pi's resolved command suffix when duplicate commands are loaded", async () => {
    const harness = createHarness([], {
      commandInvocationNames: ["context-bar:1"],
      foreignCommandInvocationNames: ["context-bar:2"],
    });
    await emit(harness, "session_start", { reason: "startup" });
    const base = {
      getSuggestions: async () => null,
      applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }),
      shouldTriggerFileCompletion: () => true,
    };
    const provider = harness.autocompleteWrappers[0]!(base);
    const command = "/context-bar:1 ";
    const suggestions = await provider.getSuggestions(
      [command],
      0,
      command.length,
      { force: true, signal: new AbortController().signal },
    );

    assert.deepEqual(suggestions?.items.map(({ value }: { value: string }) => value), [
      "on", "off", "status", "refresh", "codex-on", "codex-off", "--help",
    ]);

    let delegated = 0;
    const delegatingProvider = harness.autocompleteWrappers[0]!({
      ...base,
      getSuggestions: async () => { delegated++; return null; },
    });
    const foreignCommand = "/context-bar:2 ";
    await delegatingProvider.getSuggestions(
      [foreignCommand],
      0,
      foreignCommand.length,
      { force: true, signal: new AbortController().signal },
    );
    assert.equal(delegated, 1);
    await emit(harness, "session_shutdown");
  });

  it("suggests and describes every canonical command argument", () => {
    const command = createHarness().commands.get("context-bar")!;
    const completions = command.getArgumentCompletions!;

    assert.deepEqual(completions("")?.map(({ value }) => value), ["on", "off", "status", "refresh", "codex-on", "codex-off", "--help"]);
    assert.ok(completions("")?.every(({ description }) => typeof description === "string" && description.length > 0));
    assert.deepEqual(completions("o")?.map(({ value }) => value), ["on", "off"]);
    assert.deepEqual(completions("re")?.map(({ value }) => value), ["refresh"]);
    assert.equal(completions("missing"), null);
    assert.equal(completions("status "), null);
  });

  it("shows package-local help for --help and -h without toggling the bar", async () => {
    for (const alias of ["--help", "-h"]) {
      const harness = createHarness();
      const command = harness.commands.get("context-bar")!;

      await command.handler(alias, harness.context);

      assert.equal(harness.notifications.length, 1);
      assert.equal(harness.notifications[0]?.type, "info");
      assert.match(harness.notifications[0]?.message ?? "", /Usage: \/context-bar \[on\|off\|status\|refresh\|codex-on\|codex-off\]/);
      assert.match(harness.notifications[0]?.message ?? "", /--help, -h/);
      assert.equal(harness.entries.length, 0);
      assert.equal(harness.widgets.length, 0);
    }
  });

  it("never displays secret-bearing OAuth resolution errors", async () => {
    const secret = "access_token=oauth-secret-value";
    const harness = createHarness([], {
      model: { provider: "openai-codex", id: "gpt-5.4", contextWindow: 100 },
      providerAuth: { source: "OAuth" },
      getProviderAuth: async () => { throw new Error(`OAuth refresh failed: ${secret}`); },
    });

    await harness.commands.get("context-bar")!.handler("refresh", harness.context);
    assert.equal(harness.notifications.at(-1)?.type, "warning");
    assert.match(harness.notifications.at(-1)?.message ?? "", /refresh failed/i);
    assert.doesNotMatch(harness.notifications.at(-1)?.message ?? "", new RegExp(secret));

    await harness.commands.get("context-bar")!.handler("status", harness.context);
    assert.doesNotMatch(harness.notifications.at(-1)?.message ?? "", new RegExp(secret));
  });

  it("explains when a forced refresh cannot run", async () => {
    const harness = createHarness();

    await harness.commands.get("context-bar")!.handler("refresh", harness.context);

    assert.equal(harness.notifications.at(-1)?.type, "warning");
    assert.match(harness.notifications.at(-1)?.message ?? "", /active OAuth-authenticated Codex model/i);
  });

  it("reports command usage for unsupported arguments", async () => {
    const harness = createHarness();
    const command = harness.commands.get("context-bar")!;

    await command.handler("sometimes", harness.context);

    assert.equal(harness.notifications.at(-1)?.type, "warning");
    assert.match(harness.notifications.at(-1)?.message ?? "", /on\|off\|status/);
  });
});
