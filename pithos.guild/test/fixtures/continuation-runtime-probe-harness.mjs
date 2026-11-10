import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
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
// Default remains the exact-source 1.4 harness. 1.5 requires pinned copied deployment proof.
let runtimeVersion = "1.4.0";
if (process.argv[3] === "--runtime-version") {
  assert.equal(process.argv[4], "1.5.0", "Explicit deployed version");
  runtimeVersion = process.argv[4];
  process.argv.splice(3, 2);
}
const cli = await realpath(process.argv[2]);
const packageRoot = dirname(dirname(cli));
assert.equal(cli, await realpath(join(packageRoot, "dist/cli.js")));
const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
assert.equal(manifest.name, "@earendil-works/pi-coding-agent");
assert.equal(manifest.version, runtimeVersion);
if (runtimeVersion === "1.5.0") {
  const bytes = await readFile(join(packageRoot, "deployed-manifest.json"));
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  assert.equal(hash(bytes), "c97a03d9dd5cd2faea87c30192fc1a19b5a6a0c9c33f374a09ae57c85d1a614a", "Deployment proof SHA-256");
  const proof = JSON.parse(bytes);
  for (const [file, expected] of Object.entries({"package.json": proof.expected["package.json"], ...proof.overlay})) {
    assert.equal(hash(await readFile(join(packageRoot, file))), expected, `Deployment proof output: ${file}`);
  }
}
assert.equal(manifest.exports["."].import, "./dist/index.js");
const sdkUrl = pathToFileURL(join(packageRoot, manifest.exports["."].import));
const sdk = await import(sdkUrl.href);
const { KeybindingsManager } = await import(pathToFileURL(join(packageRoot, "dist/core/keybindings.js")).href);
assert.equal(sdk.VERSION, runtimeVersion);
// Resolve Pi AI from the selected installation, never from this fixture's directory.
const aiManifestPath = findPackageJSON("@earendil-works/pi-ai", sdkUrl);
assert.ok(aiManifestPath, "Selected installation must supply Pi AI");
const aiManifest = JSON.parse(await readFile(aiManifestPath, "utf8"));
assert.equal(aiManifest.name, "@earendil-works/pi-ai");
assert.equal(aiManifest.version, runtimeVersion);
assert.equal(aiManifest.exports["."].import, "./dist/index.js");
const aiUrl = pathToFileURL(join(dirname(aiManifestPath), aiManifest.exports["."].import));
const ai = await import(aiUrl.href);
const tuiManifestPath = findPackageJSON("@earendil-works/pi-tui", sdkUrl);
const tuiManifest = JSON.parse(await readFile(tuiManifestPath, "utf8"));
assert.equal(tuiManifest.version, runtimeVersion);
const tuiUrl = pathToFileURL(join(dirname(tuiManifestPath), tuiManifest.main));
const tui = await import(tuiUrl.href);
assert.equal(ai.PI_AI_VERSION, runtimeVersion);
const log = (record) => console.log(JSON.stringify(record));
log({ phase: "runtime", legacyAtomicCapabilityMask: false, version: sdk.VERSION, cli, sdk: sdkUrl.href, ai: aiUrl.href,
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
const fixture = fileURLToPath(new URL("./continuation-runtime-probe-guild.ts", import.meta.url));
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
// Strict manifest below remains fail-closed while lifecycle cases are implemented.
const result = options => ({ role: options.role, profile: options.profile, task: options.task,
  runId: options.runId, taskId: options.taskId,
  status: "cancelled", output: "in-process gate released", exitCode: 0, stderr: "", activity: "Cancelled",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 } });
async function tick() { await delay(20); }

export async function createHarness(name, {runner, beforeReload, onReloadStart} = {}) {
 const ordinaryPlans = [];
 const state = {ledger: [], beforeStream: async () => {}, transportFailures: [], ownedRequests: 0, ownedPreparation: false, autoResponses: 0, pendingNotice: undefined, consumedNotices: new WeakSet(), finalResponse: false, ordinaryResponse: false, streamCalls: 0, next: undefined, requests: [], observedMessages: [], notices: [], preparations: 0, ownedStarts: 0};
const zero = () => ({input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}});
const provider = "accounting-local-script";
const model = {id: "scripted", name: "Local accounting script", provider, api: provider, baseUrl: "https://accounting.invalid", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 1024, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}};

async function createSession({ cwd, agentDir, sessionManager, sessionStartEvent, continuationRuntimeGate }, loaded, reload) {
  const credentials = new ai.InMemoryCredentialStore();
  const modelRuntime = await sdk.ModelRuntime.create({ credentials, modelsPath: null,
    modelsStore: new ai.InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
const registerTransport = () => modelRuntime.registerProvider(provider, {api: provider, baseUrl: model.baseUrl, apiKey: "local-script-not-a-credential", models: [model],
 streamSimple(requestModel, context, options) {
  assert.equal(requestModel.id, model.id);
  const request = {context, options};
  state.requests.push(request);
  // Each case owns its finite budget, plans and notice identities.
  assert.ok(++state.streamCalls <= 160, "Unplanned scripted turns");
  let call, kind, text = "done";
  if (state.ownedPreparation && state.pendingNotice && !state.consumedNotices.has(state.pendingNotice)) {
    kind = "owned";
    state.consumedNotices.add(state.pendingNotice);
    state.ownedPreparation = false;
    state.ownedRequests++;
    text = "AUTO";
  } else if (state.next) {
    kind = "tool"; call = state.next; state.next = undefined; state.finalResponse = true;
  } else if (state.finalResponse) { kind = "final"; state.finalResponse = false; }
  else if (state.ordinaryResponse) { kind = "ordinary"; state.ordinaryResponse = false; }
  else if (ordinaryPlans.length) {
    const plan = ordinaryPlans[0];
    assert.ok(plan.matches(context), `Ordinary request must match ${plan.label}`);
    kind = "ordinary";
    if (--plan.count === 0) ordinaryPlans.shift();
  } else assert.fail("Unexpected local transport request");
  request.kind = kind;
  state.ledger.push({type: "native_request", request});
  const gate = state.beforeStream;
  const stream = ai.createAssistantMessageEventStream();
  const message = {role: "assistant", api: model.api, provider, model: model.id, content: [], stopReason: "pending", timestamp: Date.now(), usage: zero()};
  queueMicrotask(async () => {
   try {
   await gate({kind, context, options, message});
   if (options.signal?.aborted) {
     message.stopReason = "aborted";
     message.errorMessage = "Local scripted request aborted";
     state.ledger.push({type: "native_settlement", request, reason: "aborted"});
     stream.push({type: "error", reason: "aborted", error: message}); stream.end(); return;
   }
   stream.push({type: "start", partial: message});
   if (call) {
    const block = {type: "toolCall", id: call.id, name: call.name, arguments: call.args};
    message.content.push(block);
    stream.push({type: "toolcall_start", contentIndex: 0, partial: message});
    stream.push({type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(block.arguments), partial: message});
    stream.push({type: "toolcall_end", contentIndex: 0, toolCall: block, partial: message});
   } else {
    message.content.push({type: "text", text});
    stream.push({type: "text_start", contentIndex: 0, partial: message});
    stream.push({type: "text_delta", contentIndex: 0, delta: text, partial: message});
    stream.push({type: "text_end", contentIndex: 0, content: text, partial: message});
   }
   if (kind === "owned") state.autoResponses++;
   message.stopReason = call ? "toolUse" : "stop";
   state.ledger.push({type: "native_settlement", request, reason: message.stopReason});
   stream.push({type: "done", reason: message.stopReason, message}); stream.end();
   } catch (error) {
     state.transportFailures.push(error);
     message.stopReason = "error"; message.errorMessage = String(error);
     stream.push({type: "error", reason: "error", error: message}); stream.end();
   }
  });
  return stream;
 },
});
registerTransport();

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
      registerTransport();
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
  const before = state.streamCalls;
  state.next = {id, name, args};
  control.allowAgent = true;
  try {
    await bounded(session.prompt("local scripted public tool turn"), name);
    await bounded(session.waitForIdle(), `${name} idle`);
  } finally { control.allowAgent = false; }
  assert.equal(state.next, undefined, "Scripted tool call consumed");
  assert.equal(state.streamCalls - before, 2, "One tool turn and one final response");
  const entry = session.sessionManager.getEntries().find(e => e.type === "message" && e.message.role === "toolResult" && e.message.toolCallId === id);
  assert.ok(entry, "Actual pipeline persisted the tool result");
  return entry.message;
}

 const terminal = new ProbeTerminal();
 let control;
 const controls = [];
 function configureControl(next) {
   control = next; controls.push(next);
   if (runner) next.background = runner;
   let onAccept = next.onAccept;
   Object.defineProperty(next, "onAccept", {
     get: () => record => {
       state.ledger.push({type: "accepted", record});
       record.receipt.finished.then(settled => state.ledger.push({type: "receipt_settlement", record, settled}));
       onAccept(record);
     },
     set: callback => { onAccept = callback; },
   });
   let before = next.beforeAgent;
   Object.defineProperty(next, "beforeAgent", {
     get: () => async event => {
       state.ownedPreparation = event.messageType === "custom" && event.message.customType === "pi-parent-continuation";
       if (state.ownedPreparation) state.preparations++;
       await before(event);
     },
     set: callback => { before = callback; },
   });
 }
 function observeSession(session) {
   session.subscribe(event => {
     if (["message_start", "message_end", "agent_start", "agent_end"].includes(event.type)) state.ledger.push({type: event.type, event});
     if (event.type === "message_start") state.observedMessages.push(event.message);
     if (event.type === "message_start" && event.message.role === "custom" && event.message.customType === "pi-parent-continuation") {
       state.pendingNotice = event.message; state.notices.push(event.message);
     }
     if (event.type === "agent_start" && state.ownedPreparation) state.ownedStarts++;
   });
 }
 const runtime = await sdk.createAgentSessionRuntime(async options => {
   options.sessionManager.getSessionDir = () => process.env.TMPDIR;
   const loaded = await loadGuild(name);
   configureControl(loaded.control);
   const created = await createSession(options, loaded.loaded, async () => {
     beforeReload?.();
     const replacement = await loadGuild(name);
     configureControl(replacement.control);
     if (onReloadStart) replacement.control.onStart = () => onReloadStart(replacement.control);
     return replacement.loaded;
   });
   observeSession(created.session);
   return created;
 }, {cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR, sessionManager: sdk.SessionManager.inMemory(process.cwd())});
 const mode = new sdk.InteractiveMode(runtime, {terminal, tuiMode: "regular"});
 await bounded(mode.init(), "init");
 return {runtime, mode, get control() { return control; }, controls, get session() { return runtime.session; }, terminal, state,
   command(text, route, completion) {
     if (route === "sdk") return runtime.session.prompt(text);
     assert.equal(route, "editor");
     const offset = terminal.output.length;
     const context = control.opens.at(-1)?.context ?? control.context;
     context.ui.setEditorText(text);
     terminal.input("\r");
     return bounded((async () => {
       const end = performance.now() + 1200;
       while (true) {
         const output = stripVTControlCharacters(terminal.output.slice(offset));
         const active = runtime.session.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === "plan-theme-state").at(-1)?.data.active ?? false;
         if (completion === "refused" ? (output.includes("Plan entry is busy or unavailable") || output.includes("Wait for the current agent turn to fini")) : active === (completion === "active")) return;
         assert.ok(performance.now() < end, `editor ${text}: public ${completion} completion; terminal=${output.slice(-3000)}`);
         await tick();
       }
     })(), `editor ${text}`);
   },
   planOrdinary({label, count, matches}) {
     assert.equal(typeof label, "string");
     assert.ok(Number.isInteger(count) && count > 0 && count <= 160);
     assert.equal(typeof matches, "function");
     ordinaryPlans.push({label, count, matches});
   },
   assertOrdinaryPlansConsumed() { assert.deepEqual(ordinaryPlans, [], "Unused ordinary response plans"); },
   tool: (name, args) => publicTool(runtime.session, control, name, args),
   prompt(text) {
     assert.equal(state.ordinaryResponse, false, "Only one ordinary plan at a time");
     const plan = {}, owner = control;
     state.ordinaryResponse = plan; owner.allowAgent = true;
     return runtime.session.prompt(text).finally(() => {
       owner.allowAgent = false;
       if (state.ordinaryResponse === plan) state.ordinaryResponse = false;
       assert.deepEqual(state.transportFailures, [], "Local transport failures");
     });
   },
   async dispose() { try {
     await bounded(runtime.dispose(), "dispose");
     assert.deepEqual(state.transportFailures, [], "Local transport failures");
   } finally { mode.stop(); } },
 };
}
export {sdk, ai, log, deferred, bounded, tick, result};
