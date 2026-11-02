/**
 * Installed-runtime Guild shutdown pins with a terminal-I/O InteractiveMode smoke.
 * Plain ESM deliberately avoids tsx and the checkout's Pi 0.99 dependency graph.
 * Run only through tools/shutdown-runtime-probe.ts with an explicit Pi 1.4.0 CLI.
 */
import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

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
log({ phase: "runtime", version: sdk.VERSION, cli, sdk: sdkUrl.href, ai: aiUrl.href,
  node: process.version, pid: process.pid, aiVersion: ai.PI_AI_VERSION, tui: tuiUrl.href, tuiVersion: tuiManifest.version, scope: "actual-host core shutdown pins and InteractiveMode terminal-I/O smoke" });

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

// Pin list: veto; replacement drain/order; swallowed cleanup fault; terminal drain.
// The separate UI smoke below preserves these core pins. Gates are not OS children.
const fixture = fileURLToPath(new URL("./shutdown-runtime-probe-guild.ts", import.meta.url));
async function loadGuild() {
  const bus = sdk.createEventBus();
  const loaded = await sdk.discoverAndLoadExtensions([fixture], process.cwd(), process.env.PI_CODING_AGENT_DIR, bus);
  assert.deepEqual(loaded.errors, [], "Shutdown fixture must load through the selected public loader");
  assert.deepEqual(loaded.extensions.map(extension => extension.resolvedPath), [fixture]);
  let control;
  bus.emit("shutdown-probe:control", value => { control = value; });
  assert.ok(control);
  assert.equal(control.SessionManager, sdk.SessionManager);
  assert.equal(control.TuiMainScreen, tui.TuiMainScreen);
  assert.equal(control.createAssistantMessageEventStream, ai.createAssistantMessageEventStream);
  return { loaded, control };
}
async function createSession({ cwd, agentDir, sessionManager, sessionStartEvent }, loaded) {
  const credentials = new ai.InMemoryCredentialStore();
  const modelRuntime = await sdk.ModelRuntime.create({ credentials, modelsPath: null,
    modelsStore: new ai.InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
  const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false },
    retry: { enabled: false }, cacheWarming: "off", enableInstallTelemetry: false });
  const resourceLoader = {
    getExtensions: () => loaded,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "Provider-free shutdown probe.",
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources: () => { throw new Error("Unexpected resource discovery"); },
    reload: async () => { throw new Error("Unexpected resource reload"); },
  };
  const services = { cwd, agentDir, modelRuntime, settingsManager, resourceLoader, diagnostics: [] };
  const created = await sdk.createAgentSession({ ...services, sessionManager, sessionStartEvent,
    tools: [], noTools: "all", customTools: [] });
  assert.deepEqual(created.extensionsResult.errors, []);
  assert.deepEqual(await credentials.list(), []);
  return { ...created, services, diagnostics: [] };
}
const input = { role: "coder", profile: "general", task: "provider-free shutdown cleanup gate" };
const result = options => ({ role: options.role, profile: options.profile, task: options.task,
  status: "cancelled", output: "in-process gate released", exitCode: 0, stderr: "", activity: "Cancelled",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 } });
const settle = promise => promise.then(value => ({ value }), error => ({ error: String(error) }));
let passed = 0;
for (const name of ["before-switch-veto", "replacement-drain", "cleanup-fault-continuation", "terminal-drain"]) {
  const events = [];
  const registrations = [];
  const errors = [];
  const entered = deferred();
  const release = deferred();
  const aborted = deferred();
  let oldContext;
  let calls = 0;
  let updates = 0;
  let runOptions;
  let active;
  let queued;
  let operation;
  let runtime;
  let disposed = false;
  let failure;
  try {
    runtime = await sdk.createAgentSessionRuntime(async options => {
      if (oldContext) assert.throws(() => oldContext.cwd, /stale/, "old runner invalid before fresh factory");
      events.push("factory");
      const guild = await loadGuild();
      registrations.push(guild.control);
      guild.control.observe = event => events.push(event);
      // Metadata only, for fake trace/capture. Persistence/lifecycle remain real inMemory.
      options.sessionManager.getSessionDir = () => process.env.TMPDIR;
      return createSession(options, guild.loaded);
    }, { cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR,
      sessionManager: sdk.SessionManager.inMemory(process.cwd()) });
    const bind = session => session.bindExtensions({ mode: "json", onError: error => errors.push(error) });
    await bind(runtime.session);
    const original = runtime.session;
    const control = registrations[0];
    assert.equal(control.starts, 1);
    assert.equal(original.sessionManager.isPersisted(), false);
    assert.equal(original.sessionFile, undefined);
    runtime.setBeforeSessionInvalidate(() => {
      assert.equal(runtime.session, original);
      assert.equal(oldContext.cwd, process.cwd(), "before-invalidate observer still has live host context");
      events.push("before-invalidate");
    });
    runtime.setRebindSession(async session => {
      events.push("rebind");
      await bind(session);
    });
    oldContext = original.extensionRunner.createContext();
    if (name === "before-switch-veto") {
      control.veto = true;
      assert.deepEqual(await bounded(runtime.newSession(), "before switch veto"), { cancelled: true });
      assert.equal(runtime.session, original);
      assert.deepEqual(events, ["factory"]);
      assert.equal(control.shutdowns, 0);
    } else {
      control.failCleanup = name === "cleanup-fault-continuation";
      control.run = async options => {
        calls++;
        runOptions = options;
        options.signal.addEventListener("abort", () => {
          events.push("abort");
          aborted.resolve();
        }, { once: true });
        entered.resolve();
        await release.promise;
        events.push("runner-release");
        return result(options);
      };
      const tool = original.extensionRunner.getToolDefinition("guild_handover");
      assert.ok(tool);
      active = settle(tool.execute("active", input, undefined, () => updates++, oldContext));
      await bounded(entered.promise, "real registered Guild runner entry");
      queued = settle(tool.execute("queued", input, undefined, undefined, oldContext));
      let finished = false;
      operation = settle(name === "terminal-drain" ? runtime.dispose() : runtime.newSession())
        .then(value => { finished = true; return value; });
      await bounded(aborted.promise, "synchronous runner abort listener during shutdown");
      assert.equal(runOptions.signal.aborted, true);
      assert.equal((await bounded(queued, "queued cancellation")).value.details.status, "cancelled");
      await delay(25);
      assert.equal(finished, false, "held cleanup must block host shutdown completion");
      assert.equal(runtime.session, original);
      assert.deepEqual(events, ["factory", "abort"], "no invalidation/factory/rebind before drain");
      assert.equal(oldContext.cwd, process.cwd());
      assert.equal(calls, 1);
      assert.equal(control.traceBindings, 1);
      const beforeUpdates = updates;
      runOptions.onUpdate({ output: "stale held update", usage: { turns: 1 } });
      assert.equal(updates, beforeUpdates);
      assert.equal((await tool.execute("closed", input, undefined, undefined, oldContext)).details.status, "cancelled");
      assert.equal(calls, 1, "closed generation cannot admit work");
      release.resolve();
      const execution = await bounded(active, "active cleanup");
      if (control.failCleanup) assert.match(execution.error ?? "", /scripted-trace-cleanup-failure/);
      else assert.equal(execution.value.details.status, "cancelled");
      const completed = await bounded(operation, "host shutdown completion");
      assert.equal(completed.error, undefined);
      assert.equal(control.unbinds, 1);
      assert.equal(control.shutdowns, 1);
      assert.throws(() => oldContext.cwd, /stale/);
      runOptions.onUpdate({ output: "stale completed update", usage: { turns: 2 } });
      assert.equal(updates, beforeUpdates);
      assert.equal((await tool.execute("stale", input, undefined, undefined, oldContext)).details.status, "cancelled");
      assert.equal(calls, 1);
      if (name === "terminal-drain") {
        disposed = true;
        assert.equal(runtime.session, original, "Pi retains the disposed session reference");
        assert.deepEqual(events, ["factory", "abort", "runner-release", "unbind", "before-invalidate"]);
        assert.equal(registrations.length, 1);
      } else {
        assert.deepEqual(completed.value, { cancelled: false }, "shutdown exceptions do not veto replacement");
        assert.notEqual(runtime.session, original);
        assert.equal(registrations.length, 2);
        assert.notEqual(registrations[1], control);
        assert.equal(registrations[1].starts, 1);
        assert.deepEqual(events, ["factory", "abort", "runner-release", "unbind", "before-invalidate", "factory", "rebind"]);
        let freshCalls = 0;
        registrations[1].run = async options => { freshCalls++; return result(options); };
        const fresh = runtime.session.extensionRunner;
        await bounded(fresh.getToolDefinition("guild_handover").execute("fresh", input, undefined, undefined,
          fresh.createContext()), "fresh registered tool");
        assert.equal(freshCalls, 1);
      }
      if (control.failCleanup) {
        assert.equal(errors.length, 1);
        assert.equal(errors[0].event, "session_shutdown");
        assert.equal(errors[0].error, "Guild shutdown cleanup failed");
      } else assert.deepEqual(errors, []);
    }
  } catch (error) { failure = String(error); }
  finally {
    release.resolve();
    await Promise.all([active, queued, operation]);
    if (runtime && !disposed) {
      runtime.setBeforeSessionInvalidate(undefined);
      await bounded(runtime.dispose(), "final disposal");
    }
  }
  if (name !== "cleanup-fault-continuation" && errors.length) failure ??= "Unexpected extension error";
  if (!failure) passed++;
  log({ phase: "case", case: name, status: failure ? "failed" : "passed", events, calls,
    registrations: registrations.length, errors: errors.map(({ event, error }) => ({ event, error })), failure,
    seam: "in-process runner gate; getSessionDir metadata only; fake capture/trace" });
}
const coreComplete = passed === 4;
// UI pin list: actual bind/editor; native progress; held replacement; fresh draft;
// stale callbacks/publication; terminal and runtime cleanup. No raw keys/Escape.
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
const terminal = new ProbeTerminal();
const registrations = [];
const events = [];
const uiErrors = [];
const errorUnsubscribers = [];
const errorDisplay = value => stripVTControlCharacters(String(value ?? ""))
  .replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 2048);
const entered = deferred();
const aborted = deferred();
const release = deferred();
let runtime, mode, command, replacement, runOptions, uiFailure;
try {
  runtime = await sdk.createAgentSessionRuntime(async options => {
    events.push("factory");
    const guild = await loadGuild();
    registrations.push(guild.control);
    guild.control.observe = event => events.push(event);
    options.sessionManager.getSessionDir = () => process.env.TMPDIR;
    const created = await createSession(options, guild.loaded);
    const registrationIndex = registrations.length - 1;
    // Observe before mode binding without replacing its renderer/error listener.
    // Keep every session's observer through replacement and final shutdown.
    errorUnsubscribers.push(created.session.extensionRunner.onError(({ event, error }) => {
      uiErrors.push({ registrationIndex, event: errorDisplay(event), error: errorDisplay(error) });
    }));
    return created;
  }, { cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR,
    sessionManager: sdk.SessionManager.inMemory(process.cwd()) });
  mode = new sdk.InteractiveMode(runtime, { terminal, tuiMode: "regular" });
  await bounded(mode.init(), "public InteractiveMode init");
  assert.equal(terminal.starts, 1);
  assert.equal(registrations[0].starts, 1);
  assert.equal(typeof terminal.input, "function");
  const control = registrations[0];
  assert.ok(control.context, "session_start observer captures actual bound UI context");
  const oldContext = control.context;
  assert.equal(oldContext.mode, "tui");
  // Observe the actual renderer through the public widget factory, without replacing
  // any command/dialog/lifecycle method or changing focus.
  let observedTui;
  oldContext.ui.setWidget("shutdown-probe-observer", activeTui => {
    observedTui = activeTui;
    return { render: () => [], invalidate() {} };
  });
  assert.ok(observedTui instanceof tui.TuiMainScreen);
  const editor = observedTui.getFocusedComponent();
  assert.equal(typeof editor.getText, "function");
  oldContext.ui.setWidget("shutdown-probe-observer", undefined);
  oldContext.ui.setEditorText("old-draft");
  assert.equal(oldContext.ui.getEditorText(), "old-draft");
  control.run = async options => {
    runOptions = options;
    options.signal.addEventListener("abort", () => { events.push("abort"); aborted.resolve(); }, { once: true });
    entered.resolve();
    await release.promise;
    events.push("runner-release");
    return result(options);
  };
  const original = runtime.session;
  command = settle(original.prompt("/guild-handover coder/general provider-free UI cleanup gate"));
  await bounded(entered.promise, "direct command runner entry");
  await delay(50);
  assert.match(terminal.output, /coder\/general/, "native progress must render the target");
  assert.match(terminal.output, /Guild Relay/);
  assert.match(terminal.output, /F6 \/ Enter inspect/, "actual custom progress, not just dashboard");
  assert.notEqual(observedTui.getFocusedComponent(), editor, "native custom progress owns focus");
  const oldEntries = structuredClone(original.sessionManager.getEntries());
  const lifecycle = oldEntries.filter(entry => entry.type === "custom_message");
  assert.equal(lifecycle.length, 1);
  assert.equal(lifecycle[0].details.status, "started", "real lifecycle message persisted in memory");
  let finished = false;
  replacement = settle(runtime.newSession()).then(value => { finished = true; return value; });
  await bounded(aborted.promise, "UI shutdown abort");
  await delay(25);
  assert.equal(finished, false, "UI replacement must wait for owned runner cleanup");
  assert.equal(runtime.session, original);
  assert.equal(registrations.length, 1);
  assert.equal(oldContext.cwd, process.cwd());
  assert.equal(observedTui.getFocusedComponent(), editor, "owned dialog closed before host reset");
  assert.equal(oldContext.ui.getEditorText(), "old-draft");
  release.resolve();
  assert.deepEqual(await bounded(replacement, "UI replacement"), { value: { cancelled: false } });
  const fresh = registrations[1].context;
  assert.ok(fresh);
  assert.notEqual(fresh, oldContext);
  assert.equal(registrations[1].starts, 1);
  assert.throws(() => oldContext.cwd, /stale/);
  fresh.ui.setEditorText("new-draft");
  assert.equal(fresh.ui.getEditorText(), "new-draft");
  const before = structuredClone(runtime.session.sessionManager.getEntries());
  runOptions.onUpdate({ output: "stale UI update", usage: { turns: 2 } });
  runOptions.onEvent({ type: "agent_end", messages: [] });
  assert.equal((await bounded(command, "old direct command tail")).error, undefined);
  await delay(25);
  assert.equal(fresh.ui.getEditorText(), "new-draft");
  assert.deepEqual(runtime.session.sessionManager.getEntries(), before, "no old publication into replacement");
  assert.deepEqual(original.sessionManager.getEntries(), oldEntries, "no old terminal lifecycle publication");
  assert.deepEqual(events, ["factory", "abort", "runner-release", "unbind", "factory"]);
} catch (error) { uiFailure = error.stack ?? String(error); }
finally {
  release.resolve();
  try {
    await Promise.all([command, replacement]);
    if (runtime) await bounded(runtime.dispose(), "UI final disposal");
  } catch (error) { uiFailure ??= error.stack ?? String(error); }
  finally {
    try { mode?.stop(); }
    catch (error) { uiFailure ??= error.stack ?? String(error); }
    finally { for (const unsubscribe of errorUnsubscribers) unsubscribe(); }
  }
}
try {
  assert.equal(uiErrors.length, 0, "Unexpected UI extension errors");
  assert.equal(terminal.stops, terminal.starts);
} catch (error) { uiFailure ??= error.stack ?? String(error); }
if (!uiFailure) passed++;
log({ phase: "case", case: "interactive-smoke", status: uiFailure ? "failed" : "passed",
  failure: uiFailure, events, starts: terminal.starts, stops: terminal.stops,
  terminalBytes: Buffer.byteLength(terminal.output), registrations: registrations.length,
  errorCount: uiErrors.length, errors: uiErrors });
log({ phase: "summary", passed, skipped: 0, coreComplete, complete: passed === 5 });
if (passed !== 5) process.exitCode = 1;
