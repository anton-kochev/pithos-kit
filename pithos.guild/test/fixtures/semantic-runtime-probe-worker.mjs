import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

assert.equal(process.env.PI_OFFLINE, "1");
assert.deepEqual(Object.keys(process.env).sort(), [
  "HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "TMPDIR", "TMP", "TEMP",
  "PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_SKIP_VERSION_CHECK", "PI_TELEMETRY",
].sort());
const cli = await realpath(process.argv[2]);
const packageRoot = dirname(dirname(cli));
assert.equal(cli, await realpath(join(packageRoot, "dist/cli.js")));
const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
assert.equal(manifest.name, "@earendil-works/pi-coding-agent");
assert.equal(manifest.version, "1.4.0");
assert.equal(manifest.exports["."].import, "./dist/index.js");
const sdkUrl = pathToFileURL(join(packageRoot, manifest.exports["."].import));
const sdk = await import(sdkUrl.href);
const { KeybindingsManager } = await import(pathToFileURL(join(packageRoot, "dist/core/keybindings.js")).href);
assert.equal(sdk.VERSION, "1.4.0");
// Resolve Pi AI from the selected installation, never from this fixture's directory.
const aiManifestPath = findPackageJSON("@earendil-works/pi-ai", sdkUrl);
assert.ok(aiManifestPath, "Selected installation must supply Pi AI");
const aiManifest = JSON.parse(await readFile(aiManifestPath, "utf8"));
assert.equal(aiManifest.name, "@earendil-works/pi-ai");
assert.equal(aiManifest.version, "1.4.0");
assert.equal(aiManifest.exports["."].import, "./dist/index.js");
const aiUrl = pathToFileURL(join(dirname(aiManifestPath), aiManifest.exports["."].import));
const ai = await import(aiUrl.href);
const tuiManifestPath = findPackageJSON("@earendil-works/pi-tui", sdkUrl);
const tuiManifest = JSON.parse(await readFile(tuiManifestPath, "utf8"));
assert.equal(tuiManifest.version, "1.4.0");
const tuiUrl = pathToFileURL(join(dirname(tuiManifestPath), tuiManifest.main));
const tui = await import(tuiUrl.href);
assert.equal(ai.PI_AI_VERSION, "1.4.0");
const log = (record) => console.log(JSON.stringify(record));
log({ phase: "runtime", legacyAtomicCapabilityMask: true, version: sdk.VERSION, cli, sdk: sdkUrl.href, ai: aiUrl.href,
  node: process.version, pid: process.pid, aiVersion: ai.PI_AI_VERSION, tui: tuiUrl.href, tuiVersion: tuiManifest.version, scope: "qualified public tools; local scripted transport and in-process runner, not external provider or child certification" });

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: exceeded 1500ms`)), 1500);
    })]);
  } finally { clearTimeout(timer); }
}

// Public SDK loader owns all SDK/AI/TUI aliases; no private callback replacement.
const fixture = fileURLToPath(new URL("./semantic-runtime-probe-guild.ts", import.meta.url));
const plan = fileURLToPath(new URL("../../../pithos.plan/extensions/plan-theme.ts", import.meta.url));
async function loadGuild(name) {
  const bus = sdk.createEventBus();
  const required = name.startsWith("required-plan-");
  if (required) bus.on("semantic-probe:policy", reply => reply("required"));
  const paths = required ? (name.endsWith("guild-first") ? [fixture, plan] : [plan, fixture]) : [fixture];
  const loaded = await sdk.discoverAndLoadExtensions(paths, process.cwd(), process.env.PI_CODING_AGENT_DIR, bus);
  assert.deepEqual(loaded.errors, [], "Semantic fixture must load through the selected public loader");
  assert.deepEqual(loaded.extensions.map(extension => extension.resolvedPath), paths);
  let control;
  bus.emit("semantic-probe:control", value => { control = value; });
  assert.ok(control);
  assert.equal(control.SessionManager, sdk.SessionManager);
  assert.equal(control.TuiMainScreen, tui.TuiMainScreen);
  assert.equal(control.createAssistantMessageEventStream, ai.createAssistantMessageEventStream);
  log({ phase: "guild-loader", sdkIdentity: true, aiIdentity: true, tuiIdentity: true });
  return { loaded, control };
}
let streamCalls = 0;
let next;
const zero = () => ({input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}});
const provider = "accounting-local-script";
const model = {id: "scripted", name: "Local accounting script", provider, api: provider, baseUrl: "https://accounting.invalid", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 1024, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}};

async function createSession({ cwd, agentDir, sessionManager, sessionStartEvent, continuationRuntimeGate }, loaded, reload) {
  const credentials = new ai.InMemoryCredentialStore();
  const modelRuntime = await sdk.ModelRuntime.create({ credentials, modelsPath: null,
    modelsStore: new ai.InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
modelRuntime.registerProvider(provider, {api: provider, baseUrl: model.baseUrl, apiKey: "local-script-not-a-credential", models: [model],
 streamSimple(requestModel) {
  assert.equal(requestModel.id, model.id);
  // Eight cases include two 13-tool capacity sequences; keep a finite shared turn budget.
  assert.ok(++streamCalls <= 160, "Unplanned scripted turns");
  const call = next; next = undefined;
  const stream = ai.createAssistantMessageEventStream();
  const message = {role: "assistant", api: model.api, provider, model: model.id, content: [], stopReason: "pending", timestamp: Date.now(), usage: zero()};
  queueMicrotask(() => {
   stream.push({type: "start", partial: message});
   if (call) {
    const block = {type: "toolCall", id: call.id, name: call.name, arguments: call.args};
    message.content.push(block);
    stream.push({type: "toolcall_start", contentIndex: 0, partial: message});
    stream.push({type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(block.arguments), partial: message});
    stream.push({type: "toolcall_end", contentIndex: 0, toolCall: block, partial: message});
   } else {
    message.content.push({type: "text", text: "done"});
    stream.push({type: "text_start", contentIndex: 0, partial: message});
    stream.push({type: "text_delta", contentIndex: 0, delta: "done", partial: message});
    stream.push({type: "text_end", contentIndex: 0, content: "done", partial: message});
   }
   message.stopReason = call ? "toolUse" : "stop";
   stream.push({type: "done", reason: message.stopReason, message}); stream.end();
  });
  return stream;
 },
});

  const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false },
    retry: { enabled: false }, cacheWarming: "off", enableInstallTelemetry: false });
  // Actual packaged Plan theme, discovered by the public loader.
  const themeLoader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true,
    additionalThemePaths: [fileURLToPath(new URL("../../../pithos.plan/themes/plan.json", import.meta.url))] });
  await themeLoader.reload();
  assert.deepEqual(themeLoader.getThemes().diagnostics, []);
  const resourceLoader = {
    getExtensions: () => loaded,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => themeLoader.getThemes(),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "Provider-free semantic probe.",
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources: () => { throw new Error("Unexpected resource discovery"); },
    reload: async () => {
      if (!reload) throw new Error("Unexpected resource reload");
      loaded = await reload();
    },
  };
  const services = { continuationRuntimeGate, cwd, agentDir, modelRuntime, settingsManager, resourceLoader, diagnostics: [] };
  const created = await sdk.createAgentSession({ ...services, sessionManager, sessionStartEvent,
    model, thinkingLevel: "off", tools: ["guild_start", "guild_status", "guild_send", "guild_wait", "guild_cancel", "semantic_nested_wait", "create_plan", "update_plan_draft"],
    noTools: "builtin", customTools: [] });
  assert.deepEqual(created.extensionsResult.errors, []);
  assert.deepEqual(await credentials.list(), []);
  return { ...created, services, diagnostics: [] };
}
let callSequence = 0;
async function publicTool(session, control, name, args) {
  const id = `public-${++callSequence}`;
  const before = streamCalls;
  next = {id, name, args};
  control.allowAgent = true;
  try {
    await bounded(session.prompt("local scripted public tool turn"), name);
    await bounded(session.waitForIdle(), `${name} idle`);
  } finally { control.allowAgent = false; }
  assert.equal(next, undefined, "Scripted tool call consumed");
  assert.equal(streamCalls - before, 2, "One tool turn and one final response");
  const entry = session.sessionManager.getEntries().find(e => e.type === "message" && e.message.role === "toolResult" && e.message.toolCallId === id);
  assert.ok(entry, "Actual pipeline persisted the tool result");
  return entry.message;
}
class ProbeTerminal {
  columns = 100;
  rows = 40;
  kittyProtocolActive = false;
  starts = 0;
  stops = 0;
  output = "";
  start(input, resize) { this.starts++; this.input = input; this.resize = resize; }
  stop() { this.stops++; this.input = undefined; this.resize = undefined; }
  write(data) {
    assert.ok(Buffer.byteLength(this.output) + Buffer.byteLength(data) < 1024 * 1024, "bounded terminal writes");
    this.output += data;
  }
  async drainInput() {}
  moveBy(lines) { if (lines) this.write(`\x1b[${Math.abs(lines)}${lines < 0 ? "A" : "B"}`); }
  hideCursor() { this.write("\x1b[?25l"); }
  showCursor() { this.write("\x1b[?25h"); }
  clearLine() { this.write("\x1b[K"); }
  clearFromCursor() { this.write("\x1b[J"); }
  clearScreen() { this.write("\x1b[2J\x1b[H"); }
  setTitle() {}
  setProgress() {}
  setProgramStatus() {}
}
// Test list: qualified preflight; modal consumption; native synchronous cancel;
// held cleanup/unbanked intent; public reset prefix; fresh same-session registration;
// Plan refusal preserves immediate loadout; retirement/activation preserve foreign
// selections; Plan exit cannot resurrect hidden Guild tools; native branch drain.
const result = options => ({ role: options.role, profile: options.profile, task: options.task,
  runId: options.runId, taskId: options.taskId,
  status: "cancelled", output: "in-process gate released", exitCode: 0, stderr: "", activity: "Cancelled",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 } });
const settle = promise => promise.then(value => ({ value }), error => ({ error: String(error) }));
async function tick() { await delay(20); }
function assertUnknownCollection(session, collected, runId) {
  assert.equal(collected.usage, undefined);
  const entries = session.sessionManager.getEntries();
  const admitted = entries.find(e => e.type === "custom" && e.data?.kind === "admitted" && e.data.runId === runId);
  const receipts = entries.filter(e => e.type === "custom" && e.data?.kind === "collected" && e.data.runId === runId);
  assert.equal(receipts.length, 1);
  const correlation = collected.details.guildBackground;
  assert.equal(typeof correlation.collectionId, "string");
  assert.ok(correlation.collectionId.length > 0);
  assert.deepEqual(correlation, {version: 1, sessionId: session.sessionManager.getSessionId(),
    runId, taskId: admitted.data.taskId, collectionId: correlation.collectionId});
  assert.deepEqual(receipts[0].data, {...admitted.data, kind: "collected", originEntryId: admitted.id,
    collectionId: correlation.collectionId, toolCallId: collected.toolCallId, native: "unavailable"});
}
let passed = 0;
for (const name of ["native-escape", "reset-hidden", "reset-direct", "public-accounting", "public-controls", "required-plan-guild-first", "required-plan-plan-first", "native-branch"]) {
  const terminal = new ProbeTerminal();
  const registrations = [], errors = [], unsubscribers = [], signals = [], events = [], runOptions = [];
  const release = deferred(), shutdown = deferred(), entered = deferred();
  let runtime, mode, operation, direct, failure, resetPrefix, launches = 0, parentStarts = 0;
  const load = async () => {
    const guild = await loadGuild(name);
    registrations.push(guild.control);
    guild.control.onStart = () => {
      unsubscribers.push(runtime.session.extensionRunner.onError(error => errors.push(String(error.error))));
    };
    guild.control.onShutdown = () => {
      events.push("pre-shutdown");
      // The native reset retires the binding BEFORE extension session_shutdown.
      if (signals.length && name !== "native-escape" && registrations.length === 1) {
        resetPrefix = { aborted: signals.every(signal => signal.aborted),
          current: guild.control.runtime.isCurrent(guild.control.owner) };
      }
      shutdown.resolve();
    };
    return guild.loaded;
  };
  try {
    runtime = await sdk.createAgentSessionRuntime(async options => {
      options.sessionManager.getSessionDir = () => process.env.TMPDIR;
      return createSession(options, await load(), load);
    }, { cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR,
      sessionManager: sdk.SessionManager.inMemory(process.cwd()) });
    mode = new sdk.InteractiveMode(runtime, { terminal, tuiMode: "regular" });
    await bounded(mode.init(), "mode init");
    const original = runtime.session, runner = original.extensionRunner, control = registrations[0];
    const ctx = control.context;
    const qualification = control.createSemanticInterruptBinding(ctx, {
      onInterrupt() {}, onRetire() {}, onError() { assert.fail("qualification cleanup fault"); },
    });
    log({ phase: "preflight", qualification: qualification.kind, reason: qualification.reason });
    assert.equal(qualification.kind, "bound", "PREFLIGHT: selected host lacks qualified semantic capability");
    qualification.binding.dispose();
    await bounded(qualification.cleanup, "preflight cleanup");
    assert.deepEqual(original.getActiveToolNames().filter(name =>
      ["guild_start", "guild_status", "guild_send", "guild_wait", "guild_cancel"].includes(name)).sort(),
    ["guild_cancel", "guild_send", "guild_start", "guild_status", "guild_wait"],
    "PUBLIC PREFLIGHT: qualified host must expose all five production background tools before admission");
    unsubscribers.push(original.subscribe(event => { if (event.type === "agent_start") parentStarts++; }));
    assert.equal(ctx.mode, "tui");
    const owner = control.owner;
    assert.equal(control.runtime.isCurrent(owner), true);
    let screen;
    ctx.ui.setWidget("semantic-observer", active => {
      screen = active;
      return { render: () => [], invalidate() {}, dispose() { events.push("widget-reset"); } };
    });
    assert.ok(screen instanceof tui.TuiMainScreen);
    const editor = screen.getFocusedComponent();
    const run = async options => {
      launches++; signals.push(options.signal); runOptions.push(options);
      options.signal.addEventListener("abort", () => events.push("abort"), { once: true });
      entered.resolve();
      if (options.task === "known") return {
        ...result(options), status: "completed", usageKnown: true,
        usage: {input: 11, output: 17, cacheRead: 23, cacheWrite: 29, cost: .8, contextTokens: 80, turns: 1},
        providerUsage: {input: 11, output: 17, cacheRead: 23, cacheWrite: 29, totalTokens: 80,
          cost: {input: .11, output: .17, cacheRead: .23, cacheWrite: .29, total: .8}},
        report: {protocol: "guild/2", version: 2, runId: options.runId, taskId: options.taskId,
          role: options.role, profile: options.profile, taskOutcome: "succeeded", compliance: [],
          summary: "Local deterministic report", blockers: [], limitations: ["No child process or external provider"],
          payload: {scope: ["Probe"], findings: [], verdict: "Approve"}},
      };
      try { if (options.task === "waiting") await options.onQuestion("Wait?", new AbortController().signal); }
      finally { await release.promise; }
      return result(options);
    };
    control.background = run;
    control.run = run;
    if (name.startsWith("required-plan-")) {
      const planEntries = () => original.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === "plan-theme-state");
      const active = () => planEntries().at(-1)?.data.active ?? false;
      const guildTools = ["guild_start", "guild_status", "guild_send", "guild_wait", "guild_cancel"];
      const planTools = ["create_plan", "update_plan_draft"];
      const toolStage = stage => {
        const tools = original.getActiveToolNames().sort();
        log({phase: "plan-tools", case: name, stage, tools, activations: control.activations,
          ownerCurrent: control.runtime.isCurrent(control.owner), planActive: active()});
        return tools;
      };
      const unrelated = tools => tools.filter(tool => !guildTools.includes(tool) && !planTools.includes(tool));
      const initialTools = toolStage("initial");
      const ids = [];
      for (let i = 0; i < 11; i++) {
        const admitted = await publicTool(original, control, "guild_start", {role: "reviewer", profile: "general", task: `held-${i}`});
        assert.equal(admitted.isError, false, JSON.stringify(admitted));
        ids.push(admitted.details.runId);
      }
      const admissions = () => original.sessionManager.getEntries().filter(e => e.type === "custom" && e.data?.kind === "admitted");
      assert.equal(admissions().length, 11);
      const overflow = await publicTool(original, control, "guild_start", {role: "reviewer", profile: "general", task: "overflow"});
      assert.equal(overflow.isError, true);
      assert.equal(admissions().length, 11, "capacity refusal before ledger reservation");
      const status = await publicTool(original, control, "guild_status", {});
      assert.deepEqual(status.details.runs.map(r => r.status).sort(), [...Array(8).fill("queued"), ...Array(3).fill("running")]);
      assert.equal(launches, 3);
      const before = structuredClone(planEntries());
      // Thirteen public agent turns precede this command. Refusal must preserve
      // the current selection, not a snapshot predating those input handlers.
      const tools = toolStage("before-busy-entry");
      assert.deepEqual(unrelated(tools), unrelated(initialTools));
      await bounded(original.prompt("/plan"), "busy Plan entry");
      assert.equal(active(), false);
      assert.deepEqual(planEntries(), before);
      assert.deepEqual(toolStage("after-busy-entry"), tools);
      assert.ok(signals.every(signal => !signal.aborted), "Plan refusal must not cancel children");
      terminal.input("\x1b");
      assert.ok(signals.every(signal => signal.aborted));
      assert.equal(control.runtime.isCurrent(owner), false);
      const count = control.activations;
      const cleanupTools = toolStage("before-cleanup-entry");
      await bounded(original.prompt("/plan"), "cleanup-held Plan entry");
      assert.equal(active(), false);
      assert.deepEqual(planEntries(), before);
      assert.deepEqual(toolStage("after-cleanup-entry"), cleanupTools);
      assert.deepEqual(cleanupTools.filter(tool => guildTools.includes(tool)), []);
      await bounded(original.prompt("busy intent"), "busy intent");
      assert.equal(control.activations, count);
      release.resolve();
      await tick();
      assert.equal(launches, 3);
      assert.equal(control.activations, count);
      assert.equal(original.sessionManager.getEntries().filter(e => e.type === "custom" && e.data?.kind === "terminal").length, 11);
      toolStage("drained-no-intent");
      await bounded(original.prompt("fresh safe intent"), "fresh intent");
      assert.equal(control.activations, count + 1);
      const prePlanTools = toolStage("fresh-before-plan");
      assert.deepEqual(unrelated(prePlanTools), unrelated(tools));
      assert.deepEqual(prePlanTools.filter(tool => guildTools.includes(tool)), [...guildTools].sort());
      await bounded(original.prompt("/plan"), "drained Plan entry");
      assert.equal(active(), true);
      assert.deepEqual(toolStage("active-plan"), planTools);
      terminal.input("\x1b");
      const retiredCount = control.activations;
      const interruptedTools = toolStage("interrupted-active-plan");
      for (const tool of guildTools) assert.equal(original.getToolDefinition(tool).exposure, "hidden");
      assert.equal(control.runtime.isCurrent(control.owner), false);
      await bounded(original.prompt("Plan-active intent"), "active intent");
      assert.equal(control.activations, retiredCount);
      toolStage("active-plan-intent");
      operation = original.prompt("/plan exit");
      const deadline = performance.now() + 1500;
      while (!terminal.output.includes("Exit without publishing")) {
        assert.ok(performance.now() < deadline, "Plan exit selector");
        await tick();
      }
      terminal.input("\r");
      await bounded(operation, "Plan exit");
      assert.equal(active(), false);
      // Plan strips its internal tools; Pi ignores hidden Guild definitions in
      // the saved loadout. Exit is a command, not fresh input that can rearm.
      const exitedTools = toolStage("exited-retired");
      assert.deepEqual(exitedTools, unrelated(prePlanTools));
      assert.equal(control.activations, retiredCount);
      await bounded(original.prompt("fresh after Plan"), "fresh after Plan");
      assert.equal(control.activations, retiredCount + 1);
      assert.equal(control.runtime.isCurrent(control.owner), true);
      // Check both transitions after exercising exit: neither hiding nor showing
      // Guild owns permission to reactivate unrelated tools filtered by Plan.
      assert.deepEqual({interrupted: interruptedTools, fresh: toolStage("fresh-after-exit")},
        {interrupted: planTools, fresh: [...exitedTools, ...guildTools].sort()},
        "Guild withdrawal/activation must preserve the current non-Guild loadout");
    } else if (name === "native-branch") {
      const manager = original.sessionManager;
      const root = manager.appendMessage({role: "user", content: "root", timestamp: Date.now()});
      const sibling = manager.appendMessage({role: "user", content: "sibling", timestamp: Date.now()});
      manager.branch(root);
      manager.appendMessage({role: "user", content: "origin", timestamp: Date.now()});
      const admitted = await publicTool(original, control, "guild_start", {role: "reviewer", profile: "general", task: "held"});
      assert.equal(admitted.isError, false);
      const runId = admitted.details.runId;
      const leaf = manager.getLeafId();
      const count = control.activations, starts = parentStarts;
      let finished = false;
      operation = original.navigateTree(sibling, {summarize: false}).then(value => { finished = true; return value; });
      await tick();
      assert.equal(signals[0].aborted, true);
      assert.equal(finished, false);
      assert.equal(manager.getLeafId(), leaf);
      release.resolve();
      assert.equal((await bounded(operation, "native branch drain")).cancelled, false);
      await bounded(original.waitForIdle(), "branch idle");
      assert.equal(control.runtime.isCurrent(owner), false);
      assert.equal(control.activations, count);
      assert.equal(parentStarts, starts);
      const terminalEntry = manager.getEntries().find(e => e.type === "custom" && e.data?.kind === "terminal" && e.data.runId === runId);
      assert.ok(terminalEntry);
      assert.equal(terminalEntry.parentId, leaf, "terminal persisted on outgoing branch before switch");
      for (const options of runOptions) options.onUpdate?.({output: "stale-branch-update"});
      await tick();
      assert.doesNotMatch(terminal.output, /stale-branch-update/);
      await bounded(original.prompt("fresh sibling intent"), "sibling rearm");
      assert.equal(control.activations, count + 1);
      const hidden = await publicTool(original, control, "guild_status", {});
      assert.deepEqual(hidden.details.runs, [], "unrelated sibling cannot see origin report");
      assert.equal((await bounded(original.navigateTree(terminalEntry.id, {summarize: false}), "origin return")).cancelled, false);
      await bounded(original.waitForIdle(), "origin idle");
      await bounded(original.prompt("fresh origin intent"), "origin rearm");
      const visible = await publicTool(original, control, "guild_status", {});
      assert.equal(visible.details.runs[0].runId, runId);
      const collected = await publicTool(original, control, "guild_wait", {runId, timeoutMs: 0});
      assert.equal(collected.isError, false);
      assertUnknownCollection(original, collected, runId);
      const repeat = await publicTool(original, control, "guild_wait", {runId, timeoutMs: 0});
      assert.equal(repeat.usage, undefined);
      assert.equal(repeat.details.guildBackground, undefined);
      assertUnknownCollection(original, collected, runId);
    } else if (name === "public-accounting") {
      const start = await publicTool(original, control, "guild_start", {role: "reviewer", profile: "general", task: "known"});
      assert.equal(start.isError, false);
      const runId = start.details.runId;
      await tick();
      const nested = await publicTool(original, control, "semantic_nested_wait", {runId});
      assert.equal(nested.isError, false, "Nested probe tool must execute through the agent pipeline");
      assert.equal(nested.details.isError, true);
      assert.match(JSON.stringify(nested.details.result.content), /Nested background collection unavailable/);
      assert.equal(original.sessionManager.getEntries().filter(e => e.type === "custom" && e.data?.kind === "collected").length, 0,
        "Nested wait is blocked before any durable claim");
      const first = await publicTool(original, control, "guild_wait", {runId, timeoutMs: 0});
      assert.equal(first.isError, false);
      assert.equal(first.usage?.totalTokens, 80, "First top-level wait attributes known runner usage");
      assert.equal(original.getSessionStats().tokens.total, 80);
      assert.equal(original.getSessionStats().cost, .8);
      assert.match(first.content[0].text, /Guild report — child-reported claims \(not host-verified\)/);
      const receipts = () => original.sessionManager.getEntries().filter(e => e.type === "custom" && e.data?.kind === "collected");
      assert.equal(receipts().length, 1);
      assert.equal(receipts()[0].data.toolCallId, first.toolCallId);
      const repeat = await publicTool(original, control, "guild_wait", {runId, timeoutMs: 0});
      assert.equal(repeat.usage, undefined);
      assert.equal(receipts().length, 1);
      assert.equal(original.getSessionStats().tokens.total, 80);
      assert.equal(original.getSessionStats().cost, .8);
    } else if (name === "public-controls") {
      const start = await publicTool(original, control, "guild_start", {role: "reviewer", profile: "general", task: "waiting"});
      assert.equal(start.isError, false);
      const runId = start.details.runId;
      const status = await publicTool(original, control, "guild_status", {runId});
      const waiting = status.details.runs[0];
      assert.equal(waiting.status, "waiting");
      assert.equal(typeof waiting.questionId, "string");
      const wrong = await publicTool(original, control, "guild_send", {runId, questionId: `${waiting.questionId}-wrong`, message: "wrong"});
      assert.equal(wrong.isError, true);
      const unchanged = await publicTool(original, control, "guild_status", {runId});
      assert.deepEqual(unchanged.details.runs[0], waiting);
      const reply = await publicTool(original, control, "guild_send", {runId, questionId: waiting.questionId, message: "continue"});
      assert.equal(reply.isError, false);
      assert.deepEqual(reply.details, {disposition: "accepted-not-delivered"});
      assert.equal(reply.usage, undefined);
      const timeout = await publicTool(original, control, "guild_wait", {runId, timeoutMs: 0});
      assert.equal(timeout.isError, false);
      assert.equal(timeout.details.reason, "timeout");
      assert.equal(timeout.details.guildBackground, undefined);
      assert.equal(timeout.usage, undefined);
      // Cancellation awaits child cleanup: observe abort before opening the runner gate.
      const aborted = deferred();
      signals[0].addEventListener("abort", aborted.resolve, {once: true});
      let finished = false;
      operation = publicTool(original, control, "guild_cancel", {runId}).then(value => { finished = true; return value; });
      await bounded(aborted.promise, "public cancel abort");
      await tick();
      assert.equal(finished, false);
      assert.equal(control.runtime.isCurrent(owner), true);
      release.resolve();
      const cancelled = await bounded(operation, "public cancel cleanup");
      assert.equal(cancelled.isError, false);
      assert.equal(cancelled.details.status, "cancelled");
      assert.equal(cancelled.usage, undefined);
      const collected = await publicTool(original, control, "guild_wait", {runId, timeoutMs: 0});
      assert.equal(collected.isError, false);
      assertUnknownCollection(original, collected, runId);
      const repeat = await publicTool(original, control, "guild_wait", {runId, timeoutMs: 0});
      assert.equal(repeat.usage, undefined);
      assert.equal(repeat.details.guildBackground, undefined);
      assertUnknownCollection(original, collected, runId);
      const starts = parentStarts, calls = streamCalls;
      await tick();
      assert.equal(parentStarts, starts, "no automatic parent wake after explicit cancellation");
      assert.equal(streamCalls, calls);
      assert.equal(original.getSessionStats().tokens.total, 0);
      assert.equal(original.getSessionStats().cost, 0);
      assert.equal(launches, 1);
    } else {
    let records;
    if (name === "reset-direct") {
      direct = settle(original.prompt("/guild-handover coder/general direct"));
      await bounded(entered.promise, "direct runner");
      const deadline = performance.now() + 1500;
      while (!terminal.output.includes("F6 / Enter inspect") && performance.now() < deadline) await delay(10);
      assert.match(terminal.output, /F6 \/ Enter inspect/);
      assert.notEqual(screen.getFocusedComponent(), editor);
    } else {
      records = [];
      for (const task of ["waiting", "running-1", "running-2", "queued"]) {
        const admitted = await publicTool(original, control, "guild_start", {role: "reviewer", profile: "general", task});
        assert.equal(admitted.isError, false, JSON.stringify(admitted));
        assert.ok(admitted.details.runId, "Public admission returns a run ID");
        records.push({id: admitted.details.runId});
      }
      await tick();
      assert.equal(launches, 3);
      const status = await publicTool(original, control, "guild_status", {});
      assert.equal(status.isError, false);
      assert.deepEqual(status.details.runs.map(run => run.status).sort(), ["queued", "running", "running", "waiting"]);
      assert.match(status.content[0].text, /Untrusted child question.*Wait\?/s);
      const sent = await publicTool(original, control, "guild_send", {runId: records[1].id, message: "local update"});
      assert.equal(sent.isError, false);
      assert.equal(sent.usage, undefined);
    }
    const entries = structuredClone(original.sessionManager.getEntries());
    let startsBeforeInterrupt = parentStarts;
    let cancellationEntries;
    if (name === "native-escape") {
      let keybindings;
      await bounded(ctx.ui.custom((_screen, _theme, keys, done) => {
        keybindings = keys;
        queueMicrotask(() => done(undefined));
        return { render: () => [], invalidate() {} };
      }), "capture public injected keybindings");
      assert.ok(keybindings instanceof KeybindingsManager);
      // A native selector consumes Escape. It must not retire unrelated hidden work.
      const choice = ctx.ui.select("Native consumption", ["one", "two"]);
      await tick();
      terminal.input("\x1b");
      assert.equal(await bounded(choice, "selector dismissal"), undefined);
      assert.equal(control.runtime.isCurrent(owner), true);
      assert.ok(signals.every(signal => !signal.aborted));
      assert.equal(screen.getFocusedComponent(), editor);
      terminal.input("\x1b");
      assert.equal(control.runtime.isCurrent(owner), false, "native Escape must synchronously retire Guild owner");
      assert.ok(signals.every(signal => signal.aborted), "all active signals aborted before terminal input returns");

      const count = control.activations;
      await bounded(original.prompt("busy fresh intent"), "busy intercepted input");
      assert.equal(control.activations, count, "held cleanup blocks rearm");
      release.resolve();
      await tick();
      assert.equal(launches, 3, "queued fourth must never launch");
      assert.equal(control.activations, count, "busy intent is not banked on release");
      assert.equal(control.runtime.isCurrent(owner), false);
      cancellationEntries = structuredClone(original.sessionManager.getEntries());
      await bounded(original.prompt("fresh idle intent"), "idle intercepted input");
      assert.equal(control.activations, count + 1);
      assert.equal(control.runtime.isCurrent(control.owner), true);
      const freshOwner = control.owner;
      for (const record of records) {
        const collected = await publicTool(original, control, "guild_wait", {runId: record.id, timeoutMs: 0});
        assert.equal(collected.isError, false);
        assert.equal(collected.details.runs[0].status, "cancelled");
        assertUnknownCollection(original, collected, record.id);
        startsBeforeInterrupt++;
      }
      ctx.ui.setEditorText("binding-probe-draft");
      keybindings.setUserBindings({ "app.interrupt": [] });
      terminal.input("\x1b"); terminal.input("\x1d");
      assert.equal(control.runtime.isCurrent(freshOwner), true, "disabled interrupt must not retire");
      keybindings.setUserBindings({ "app.interrupt": "ctrl+]" });
      terminal.input("\x1b");
      assert.equal(control.runtime.isCurrent(freshOwner), true, "remapped Escape must not retire");
      terminal.input("\x1d");
      assert.equal(control.runtime.isCurrent(freshOwner), false, "remapped terminal key retires synchronously");
      keybindings.setUserBindings({});
    } else {
      ctx.ui.setEditorText("preserved-draft");
      let finished = false;
      operation = settle(original.prompt("/semantic-probe-reload")).then(value => { finished = true; return value; });
      await bounded(shutdown.promise, "pre-shutdown prefix");
      assert.deepEqual(resetPrefix, { aborted: true, current: false }, "reset synchronously retires and aborts before pre-shutdown hook");
      assert.ok(events.indexOf("abort") < events.indexOf("pre-shutdown"));
      await tick();
      assert.equal(finished, false, "held cleanup prevents reload completion");
      assert.equal(registrations.length, 1);
      release.resolve();
      assert.equal((await bounded(operation, "reload completion")).error, undefined);
      if (direct) assert.equal((await bounded(direct, "direct local settlement")).error, undefined);
      assert.equal(runtime.session, original);
      assert.notEqual(original.extensionRunner, runner);
      assert.equal(registrations.length, 2);
      assert.equal(registrations[1].context.ui.getEditorText(), "preserved-draft");
      assert.equal(registrations[1].runtime.isCurrent(registrations[1].owner), true);
      for (const options of runOptions) {
        options.onUpdate?.({ output: "stale-semantic-update", usage: { turns: 2 } });
        options.onEvent?.({ type: "agent_end", messages: [] });
      }
      await tick();
      assert.equal(registrations[1].context.ui.getEditorText(), "preserved-draft");
      assert.doesNotMatch(terminal.output, /stale-semantic-update/);
      assert.equal(launches, name === "reset-direct" ? 1 : 3);
    }
    await tick();
    assert.equal(parentStarts, startsBeforeInterrupt, "no automatic parent restart after interruption");
    const after = cancellationEntries ?? original.sessionManager.getEntries();
    assert.deepEqual(after.slice(0, entries.length), entries, "Existing transcript is unchanged");
    const appended = after.slice(entries.length);
    assert.equal(appended.length, name === "reset-direct" ? 0 : 4);
    for (const entry of appended) {
      assert.equal(entry.type, "custom", "No stale report message or native usage publication");
      assert.equal(entry.customType, "pithos.guild.background.v1");
      assert.equal(entry.data.kind, "terminal");
      assert.equal(entry.data.report.status, "cancelled");
      assert.equal(entry.data.sessionId, original.sessionManager.getSessionId());
    }
    assert.equal(original.getSessionStats().tokens.total, 0);
    assert.equal(original.getSessionStats().cost, 0);
    }
  } catch (error) { failure = error.stack ?? String(error); }
  finally {
    release.resolve();
    try {
      await bounded(Promise.all([operation, direct]), "operation cleanup");
      if (runtime) await bounded(runtime.dispose(), "runtime disposal");
    } catch (error) { failure ??= error.stack ?? String(error); }
    finally {
      try { mode?.stop(); } catch (error) { failure ??= error.stack ?? String(error); }
      finally { for (const unsubscribe of unsubscribers) unsubscribe(); }
    }
  }
  try { assert.deepEqual(errors, []); assert.equal(terminal.stops, terminal.starts); }
  catch (error) { failure ??= error.stack ?? String(error); }
  log({ phase: "case", case: name, status: failure ? "failed" : "passed", failure,
    launches, parentStarts, events, errors, registrations: registrations.length });
  if (!failure) passed++;
  // Missing qualification is a preflight failure, never a passing stock control case.
  if (failure?.includes("PREFLIGHT:")) break;
}
log({ phase: "summary", passed, total: 8, failed: 8 - passed });
if (passed !== 8) process.exitCode = 1;
