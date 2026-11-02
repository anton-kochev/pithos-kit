/**
 * Installed-runtime combined Guild/Plan core, native-tree and interactive regression probe.
 * Plain ESM deliberately avoids tsx and the checkout's Pi 0.99 dependency graph.
 * Run only through tools/plan-runtime-probe.ts with an explicit Pi 1.4.0 CLI.
 */
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { readFile, realpath } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
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
  node: process.version, pid: process.pid, aiVersion: ai.PI_AI_VERSION, tui: tuiUrl.href, tuiVersion: tuiManifest.version, scope: "actual-host combined Guild/Plan JSON core and terminal-I/O interactive pin" });

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

async function createSession({ cwd, agentDir, sessionManager, sessionStartEvent }, loaded, interactive = false) {
  const credentials = new ai.InMemoryCredentialStore();
  const modelRuntime = await sdk.ModelRuntime.create({ credentials, modelsPath: null,
    modelsStore: new ai.InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
  const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false },
    retry: { enabled: false }, cacheWarming: "off", enableInstallTelemetry: false });
  let themes = [];
  if (interactive) {
    const packagedThemeFile = fileURLToPath(new URL("../../../pithos.plan/themes/plan.json", import.meta.url));
    const themeLoader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true,
      additionalThemePaths: [packagedThemeFile] });
    await themeLoader.reload();
    const discovered = themeLoader.getThemes();
    assert.deepEqual(discovered.diagnostics, []);
    themes = discovered.themes;
    assert.equal(themes.length, 1);
    assert.equal(themes[0].name, "plan");
    assert.equal(themes[0].sourcePath, packagedThemeFile);
  }
  const resourceLoader = {
    getExtensions: () => loaded,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes, diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "Provider-free Plan probe.",
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources: () => { throw new Error("Unexpected resource discovery"); },
    reload: async () => { throw new Error("Unexpected resource reload"); },
  };
  const services = { cwd, agentDir, modelRuntime, settingsManager, resourceLoader, diagnostics: [] };
  const created = await sdk.createAgentSession({ ...services, sessionManager, sessionStartEvent,
    tools: ["guild_handover", "update_plan_draft", "create_plan"], noTools: "all", customTools: [] });
  assert.deepEqual(created.extensionsResult.errors, []);
  assert.deepEqual(await credentials.list(), []);
  return { ...created, services, diagnostics: [] };
}

// Test list: held Guild refuses Plan entry; drained entry vetoes Guild, exit reopens it.
// Repeat each against both public-loader orders. No discovery helper/participant injection.
const fixture = fileURLToPath(new URL("./plan-runtime-probe-guild.ts", import.meta.url));
const plan = fileURLToPath(new URL("../../../pithos.plan/extensions/plan-theme.ts", import.meta.url));
const input = { role: "coder", profile: "general", task: "provider-free Plan coordination gate" };
const result = options => ({ role: options.role, profile: options.profile, task: options.task,
  status: "cancelled", output: "in-process gate released", exitCode: 0, stderr: "", activity: "Cancelled",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 } });
const settle = promise => promise.then(value => ({ value }), error => ({ error: String(error) }));
const counts = control => ({ calls: control.calls, captures: control.captures,
  bindings: control.bindings, unbinds: control.unbinds, agentStarts: control.agentStarts });
const planEntries = session => session.sessionManager.getBranch()
  .filter(entry => entry.type === "custom" && entry.customType === "plan-theme-state");
const persistedActive = session => planEntries(session).at(-1)?.data.active ?? false;
// Integration pins: retirement joins cleanup before leaf mutation; only fresh idle
// intent rearms; actual Plan state reconstructs across both native branch directions.
const assistant = text => ({ role: "assistant", api: "anthropic-messages", provider: "probe",
  model: "fixture-only", content: [{ type: "text", text }], stopReason: "stop", timestamp: Date.now(),
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
async function treeCase(order, name) {
  const errors = [], observations = [], checkpoints = [], gates = [], pending = [];
  const bus = sdk.createEventBus();
  const paths = order === "guild-first" ? [fixture, plan] : [plan, fixture];
  const loaded = await sdk.discoverAndLoadExtensions(paths, process.cwd(), process.env.PI_CODING_AGENT_DIR, bus);
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual(loaded.extensions.map(extension => extension.resolvedPath), paths);
  assert.equal(loaded.extensions.find(extension => extension.resolvedPath === plan).handlers.has("session_before_tree"), false);
  let control;
  bus.emit("plan-probe:control", value => { control = value; });
  assert.equal(control.SessionManager, sdk.SessionManager);
  assert.equal(control.createAssistantMessageEventStream, ai.createAssistantMessageEventStream);
  assert.equal(control.activations, 1);
  const inspect = () => {
    const replies = [];
    bus.emit("pithos.plan.coordination", { version: 1, reply: value => replies.push(value) });
    assert.equal(replies.length, 1);
    assert.equal(replies[0].version, 1);
    return replies[0].inspect();
  };
  const manager = sdk.SessionManager.inMemory(process.cwd());
  manager.getSessionDir = () => process.env.TMPDIR;
  const root = manager.appendMessage({ role: "user", content: "root", timestamp: Date.now() });
  const target = manager.appendMessage(assistant("inactive target"));
  manager.branch(root);
  manager.appendMessage(assistant("outgoing branch"));
  let runtime, session, ctx, failure, gateTree = false;
  const treeEntered = deferred(), treeRelease = deferred();
  gates.push(treeRelease);
  const identities = new Map();
  const identity = value => {
    if (!identities.has(value)) identities.set(value, identities.size + 1);
    return identities.get(value);
  };
  const snapshot = () => {
    const state = inspect();
    return { phase: state.phase, instance: identity(state.instance), generation: identity(state.generation),
      leaf: manager.getLeafId(), tools: session.getActiveToolNames(),
      entries: structuredClone(planEntries(session)), idle: ctx.isIdle(),
      activations: control.activations, ...counts(control) };
  };
  const observers = ["first", "last"].map(position => {
    const path = `<inline:plan-tree-${position}>`;
    return { path, resolvedPath: path,
      sourceInfo: sdk.createSyntheticSourceInfo(path, { source: "inline", scope: "temporary" }),
      tools: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map(), messageRenderers: new Map(),
      handlers: new Map(["session_before_tree", "session_tree"].map(type => [type, [async event => {
        observations.push({ position, event: type, ...snapshot(),
          oldLeaf: event.oldLeafId ?? event.preparation.oldLeafId,
          newLeaf: event.newLeafId ?? event.preparation.targetId });
        if (type === "session_tree" && position === "last" && gateTree) {
          gateTree = false;
          treeEntered.resolve();
          await treeRelease.promise;
        }
      }]])),
    };
  });
  observers[1].handlers.set("input", [() => ({ action: "handled" })]);
  loaded.extensions = [observers[0], ...loaded.extensions, observers[1]];
  let tool;
  const execute = id => {
    const operation = settle(tool.execute(id, input, undefined, undefined, ctx));
    pending.push(operation);
    return operation;
  };
  const prompt = (text, source = "interactive") => bounded(session.prompt(text, { source }), text);
  const navigate = id => {
    const operation = session.navigateTree(id, { summarize: false });
    pending.push(settle(operation));
    return operation;
  };
  const assertSelected = id => assert.ok(manager.getBranch().some(entry => entry.id === id), "target remains in selected ancestry after Plan persistence");
  const assertVeto = async (retired = false) => {
    const before = counts(control);
    const response = await bounded(execute("plan-veto"), "active Plan veto");
    // A retired registration cancels before admission; an active owner reaches
    // Plan's admission refusal. Both must leave capture/bind/run untouched.
    if (retired) {
      assert.equal(response.error, undefined);
      assert.equal(response.value.details.status, "cancelled");
      assert.equal(response.value.details.error, "Guild owner has shut down.");
    } else assert.match(response.error ?? "", /Plan mode is active/);
    assert.deepEqual(counts(control), before, "Plan veto precedes capture/bind/run");
  };
  const holdRunner = () => {
    const entered = deferred(), release = deferred(), aborted = deferred();
    gates.push(release);
    let options;
    control.run = async value => {
      options = value;
      value.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      entered.resolve();
      await release.promise;
      return result(value);
    };
    return { entered, release, aborted, get options() { return options; } };
  };
  try {
    runtime = await sdk.createAgentSessionRuntime(options => createSession(options, loaded),
      { cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR, sessionManager: manager });
    session = runtime.session;
    await session.bindExtensions({ mode: "json", onError: error => errors.push(error) });
    ctx = session.extensionRunner.createContext();
    tool = session.extensionRunner.getToolDefinition("guild_handover");
    assert.equal(session.sessionManager, manager);
    assert.equal(manager.isPersisted(), false);
    assert.equal(session.sessionFile, undefined);
    assert.equal(ctx.isIdle(), true);
    assert.equal(inspect().phase, "inactive");
    const initial = snapshot();
    assert.deepEqual(initial.tools, ["guild_handover"]);
    if (name === "held-navigation-and-fresh-owner") {
      const hold = holdRunner();
      const active = execute("held-navigation");
      await bounded(hold.entered.promise, "held runner entry");
      const queued = execute("queued-navigation");
      const oldLeaf = manager.getLeafId();
      let settled = false;
      const navigation = navigate(target).then(value => { settled = true; return value; });
      await bounded(hold.aborted.promise, "native retirement abort");
      assert.equal(manager.getLeafId(), oldLeaf);
      assert.equal(settled, false);
      assert.equal(ctx.isIdle(), false);
      assert.equal(observations.some(record => record.event === "session_tree"), false);
      assert.equal(control.unbinds, 0);
      assert.equal((await bounded(queued, "queued cancellation")).value.details.status, "cancelled");
      assert.equal(control.calls, 1);
      await prompt("busy intent", "rpc");
      assert.equal(control.activations, 1);
      const held = snapshot();
      await prompt("/plan");
      assert.deepEqual(snapshot(), held, "generic busy refusal preserves Plan and Guild state");
      checkpoints.push({ point: "cleanup-held-generic-busy", ...snapshot() });
      hold.release.resolve();
      assert.equal((await bounded(active, "active drain")).error, undefined);
      assert.equal((await bounded(navigation, "held navigation")).cancelled, false);
      await bounded(session.waitForIdle(), "navigation idle");
      assertSelected(target);
      assert.equal(ctx.isIdle(), true);
      assert.equal(control.bindings, control.unbinds);
      assert.equal(control.activations, 1, "navigation must not autoactivate");
      await prompt("/plan");
      assert.equal(inspect().phase, "active");
      assert.equal(persistedActive(session), true);
      await prompt("active Plan fresh intent", "rpc");
      assert.equal(control.activations, 1);
      await assertVeto(true);
      assert.equal(planEntries(session).at(-1).data.checkpointRevision, undefined);
      assert.equal(planEntries(session).at(-1).data.publishedPath, undefined);
      checkpoints.push({ point: "active-Plan-retired-Guild", ...snapshot() });
      await prompt("/plan exit");
      assert.equal(persistedActive(session), false);
      assert.equal(inspect().phase, "inactive");
      assert.deepEqual(session.getActiveToolNames(), initial.tools);
      await prompt("extension intent", "extension");
      assert.equal(control.activations, 1, "extension input must not activate a fresh owner");
      await prompt("fresh owner", order === "guild-first" ? "interactive" : "rpc");
      await prompt("same owner", "rpc");
      assert.equal(control.activations, 2, "fresh idle intent activates exactly once");
      const next = holdRunner();
      const nextRun = execute("fresh-held");
      await bounded(next.entered.promise, "fresh owner runner entry");
      assert.equal(ctx.isIdle(), true, "coordinator refusal must not be generic host busy");
      const heldAgain = snapshot();
      await prompt("/plan");
      assert.deepEqual(snapshot(), heldAgain, "stable participant protects the new owner");
      assert.equal(next.options.signal.aborted, false);
      checkpoints.push({ point: "fresh-owner-coordinator-busy", ...snapshot(), aborted: next.options.signal.aborted });
      next.release.resolve();
      assert.equal((await bounded(nextRun, "fresh owner drain")).error, undefined);
    } else {
      control.run = async options => result(options);
      assert.equal((await bounded(execute("attach-stable-participant"), "short Guild")).error, undefined);
      await prompt("/plan");
      assert.equal(inspect().phase, "active");
      assert.equal(persistedActive(session), true);
      const planId = planEntries(session).at(-1).data.planId;
      assert.ok(planId);
      const planTools = session.getActiveToolNames();
      assert.deepEqual([...planTools].sort(), ["create_plan", "update_plan_draft"]);
      // A genuine message marker, never fabricated Plan state; leaf changes after
      // binding otherwise belong exclusively to native navigateTree and real Plan.
      const activeLeaf = manager.appendMessage(assistant("genuine active Plan marker"));
      await assertVeto();
      gateTree = true;
      const navigation = navigate(target);
      await bounded(treeEntered.promise, "post-reconciliation observer");
      const first = observations.find(record => record.event === "session_tree" && record.position === "first");
      const last = observations.at(-1);
      assert.equal(first.leaf, target, "first tree observer sees native target before Plan persistence");
      assert.equal(first.phase, "active", "Plan has no before-tree handler");
      assert.equal(last.phase, "inactive");
      assert.equal(last.entries.at(-1).data.planId, planId);
      assert.equal(last.entries.at(-1).data.active, false);
      assert.deepEqual(last.tools, initial.tools);
      assertSelected(target);
      assert.equal(ctx.isIdle(), false, "post-reconciliation gate is still host busy");
      await prompt("post-reconciliation busy intent", "rpc");
      assert.equal(control.activations, 1);
      treeRelease.resolve();
      assert.equal((await bounded(navigation, "inactive navigation")).cancelled, false);
      await bounded(session.waitForIdle(), "inactive idle");
      assert.equal(ctx.isIdle(), true);
      assert.equal((await bounded(navigate(activeLeaf), "active roundtrip")).cancelled, false);
      await bounded(session.waitForIdle(), "active idle");
      assertSelected(activeLeaf);
      assert.equal(inspect().phase, "active");
      assert.equal(persistedActive(session), true);
      assert.equal(planEntries(session).at(-1).data.planId, planId);
      assert.deepEqual(session.getActiveToolNames(), planTools);
      await prompt("active restored intent", "interactive");
      assert.equal(control.activations, 1);
      assert.equal((await bounded(navigate(target), "second inactive navigation")).cancelled, false);
      await bounded(session.waitForIdle(), "second inactive idle");
      assertSelected(target);
      assert.equal(inspect().phase, "inactive");
      assert.equal(persistedActive(session), false);
      assert.equal(planEntries(session).at(-1).data.planId, planId);
      assert.deepEqual(session.getActiveToolNames(), initial.tools);
      assert.equal(control.activations, 1);
      await prompt("fresh roundtrip intent", order === "guild-first" ? "rpc" : "interactive");
      assert.equal(control.activations, 2);
      assert.equal((await bounded(execute("roundtrip-reopened"), "roundtrip Guild")).error, undefined);
      assert.equal(control.calls, 2);
      assert.equal(observations[0].phase, "active");
      assert.equal(observations[0].leaf, activeLeaf);
      assert.ok(observations[0].entries.at(-1).data.active);
    }
    assert.equal(control.bindings, control.unbinds);
    assert.equal(observations.length, name === "held-navigation-and-fresh-owner" ? 4 : 12);
    for (let index = 0; index < observations.length; index += 4) {
      const [beforeFirst, beforeLast, treeFirst, treeLast] = observations.slice(index, index + 4);
      assert.deepEqual([beforeFirst, beforeLast, treeFirst, treeLast].map(record => [record.event, record.position]),
        [["session_before_tree", "first"], ["session_before_tree", "last"], ["session_tree", "first"], ["session_tree", "last"]]);
      assert.equal(beforeFirst.leaf, beforeFirst.oldLeaf);
      assert.equal(beforeLast.leaf, beforeFirst.oldLeaf);
      assert.equal(treeFirst.leaf, treeFirst.newLeaf);
      assert.equal(treeFirst.oldLeaf, beforeFirst.oldLeaf);
      assert.equal(treeLast.newLeaf, treeFirst.newLeaf);
      assert.notEqual(treeLast.generation, treeFirst.generation, "actual Plan reconstruction advances generation");
      assert.equal(treeLast.bindings, treeLast.unbinds);
    }
    for (const record of observations) {
      assert.equal(record.idle, false);
      assert.equal(record.instance, initial.instance, "provider instance survives native navigation");
    }
    assert.equal(control.agentStarts, 0);
    assert.deepEqual(errors, []);
  } catch (error) { failure = String(error); }
  finally {
    for (const gate of gates) gate.resolve();
    try { await bounded(Promise.all(pending), "final tree operations drain"); }
    finally {
      if (runtime) {
        await bounded(runtime.dispose(), "actual tree runtime disposal");
        assert.equal(control.shutdowns, 1);
        assert.equal(control.agentStarts, 0);
        assert.deepEqual(errors, []);
      }
    }
  }
  log({ phase: "case", order, case: name, status: failure ? "failed" : "passed", paths,
    target, observations, checkpoints, ...counts(control), activations: control.activations, errors, failure });
  if (failure) throw new Error(`${order}/${name}: ${failure}`);
  passed++;
}

// Interactive pin list: held direct admission; native progress/focus; real theme
// entry; active veto; native no-publication selector; exact restoration/reopen.
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

async function interactiveCase(order) {
  const name = "interactive-plan-and-direct-guild";
  const errors = [], pending = [];
  const terminal = new ProbeTerminal();
  const release = deferred(), entered = deferred();
  const bus = sdk.createEventBus();
  const paths = order === "guild-first" ? [fixture, plan] : [plan, fixture];
  const loaded = await sdk.discoverAndLoadExtensions(paths, process.cwd(), process.env.PI_CODING_AGENT_DIR, bus);
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual(loaded.extensions.map(extension => extension.resolvedPath), paths);
  let control;
  bus.emit("plan-probe:control", value => { control = value; });
  assert.equal(control.SessionManager, sdk.SessionManager);
  assert.equal(control.createAssistantMessageEventStream, ai.createAssistantMessageEventStream);
  const inspect = () => {
    const replies = [];
    bus.emit("pithos.plan.coordination", { version: 1, reply: value => replies.push(value) });
    assert.equal(replies.length, 1);
    return replies[0].inspect();
  };
  // Compare compacted rendered text, not raw ANSI bytes: wrapping/diff renders may
  // insert whitespace into a notification. Operation offsets exclude older notices.
  const rendered = (offset = 0) => stripVTControlCharacters(terminal.output.slice(offset)).replace(/\s+/gu, "");
  const expectNotice = async (offset, message) => {
    const deadline = performance.now() + 1500;
    while (!rendered(offset).includes(message.replace(/\s+/gu, ""))) {
      assert.ok(performance.now() < deadline, `expected operation notification: ${message}: exceeded 1500ms`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  let runtime, mode, unsubscribe, failure, originalTheme, restoredTheme, runOptions;
  let activePlan, inactivePlan, checkpointCounts;
  const assertUnpublished = state => {
    assert.equal(state.publicationState, "unpublished");
    for (const field of ["checkpointRevision", "checkpointDigest", "publishedPath",
      "publishedRevision", "publishedDigest", "approval", "completedPublication"]) {
      assert.equal(state[field], undefined, `no ${field} without checkpoint/publication`);
    }
  };
  try {
    runtime = await sdk.createAgentSessionRuntime(async options => {
      options.sessionManager.getSessionDir = () => process.env.TMPDIR;
      const created = await createSession(options, loaded, true);
      unsubscribe = created.session.extensionRunner.onError(error => errors.push(String(error.error)));
      return created;
    }, { cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR,
      sessionManager: sdk.SessionManager.inMemory(process.cwd()) });
    mode = new sdk.InteractiveMode(runtime, { terminal, tuiMode: "regular" });
    await bounded(mode.init(), "interactive init");
    const session = runtime.session, ctx = control.context;
    assert.equal(ctx.mode, "tui");
    assert.equal(control.starts, 1);
    assert.equal(session.sessionManager.isPersisted(), false);
    assert.equal(session.sessionFile, undefined);
    originalTheme = ctx.ui.theme.name;
    assert.ok(originalTheme);
    assert.notEqual(originalTheme, "plan");
    let screen;
    ctx.ui.setWidget("plan-probe-observer", active => {
      screen = active;
      return { render: () => [], invalidate() {} };
    });
    assert.ok(screen instanceof tui.TuiMainScreen);
    const editor = screen.getFocusedComponent();
    ctx.ui.setWidget("plan-probe-observer", undefined);
    const command = text => {
      const operation = settle(session.prompt(text));
      pending.push(operation);
      return operation;
    };
    const prompt = async text => assert.equal((await bounded(command(text), text)).error, undefined);
    const snapshot = () => ({ phase: inspect().phase, entries: structuredClone(planEntries(session)),
      tools: session.getActiveToolNames(), theme: ctx.ui.theme.name, ...counts(control) });
    const initial = snapshot();
    assert.equal(initial.phase, "inactive");
    assert.deepEqual(initial.tools, ["guild_handover"]);
    control.run = async options => { runOptions = options; entered.resolve(); await release.promise; return result(options); };
    const held = command("/guild-handover coder/general provider-free Plan UI gate");
    await bounded(entered.promise, "direct runner entry");
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.match(terminal.output, /Guild Relay/);
    assert.match(terminal.output, /coder\/general/);
    assert.match(terminal.output, /F6 \/ Enter inspect/);
    assert.notEqual(screen.getFocusedComponent(), editor);
    assert.equal(ctx.isIdle(), true, "coordinator busy, not generic agent busy");
    const busy = snapshot();
    const busyOutput = terminal.output.length;
    await prompt("/plan");
    await expectNotice(busyOutput, "Plan entry is busy or unavailable; retry after outstanding work has drained.");
    assert.deepEqual(snapshot(), busy);
    assert.equal(runOptions.signal.aborted, false);
    release.resolve();
    assert.equal((await bounded(held, "direct drain")).error, undefined);
    assert.equal(screen.getFocusedComponent(), editor);
    await prompt("/plan");
    assert.equal(inspect().phase, "active");
    assert.equal(persistedActive(session), true);
    assert.equal(ctx.ui.theme.name, "plan");
    assert.deepEqual([...session.getActiveToolNames()].sort(), ["create_plan", "update_plan_draft"]);
    activePlan = structuredClone(planEntries(session).at(-1).data);
    assert.equal(activePlan.active, true);
    assert.equal(typeof activePlan.planId, "string");
    assert.ok(activePlan.planId.length > 0);
    assertUnpublished(activePlan);
    // plan-state.ts reconstructs checkpoints from successful tool-result messages,
    // not a checkpoint custom type. Pin all draft results (even unsuccessful ones).
    const checkpointEntries = () => session.sessionManager.getEntries().filter(entry =>
      entry.type === "message" && entry.message.role === "toolResult" &&
      entry.message.toolName === "update_plan_draft");
    const beforeCheckpoints = structuredClone(checkpointEntries());
    assert.deepEqual(beforeCheckpoints, []);
    checkpointCounts = { before: beforeCheckpoints.length };
    const beforeVeto = counts(control);
    const lifecycle = () => session.sessionManager.getEntries().filter(entry => entry.type === "custom_message");
    const beforeMessages = structuredClone(lifecycle());
    const vetoOutput = terminal.output.length;
    await prompt("/guild-handover coder/general active Plan must veto");
    await expectNotice(vetoOutput, "Guild handover failed: Guild handover is unavailable because Plan mode is active.");
    assert.deepEqual(counts(control), beforeVeto);
    assert.deepEqual(lifecycle(), beforeMessages);
    const exit = command("/plan exit");
    const selectorDeadline = performance.now() + 1500;
    while (!terminal.output.includes("Exit without publishing")) {
      assert.ok(performance.now() < selectorDeadline, "native exit selector render: exceeded 1500ms");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.notEqual(screen.getFocusedComponent(), editor);
    // No-checkpoint selector defaults to its first option: Exit without publishing.
    terminal.input("\r");
    assert.equal((await bounded(exit, "native Plan exit")).error, undefined);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(inspect().phase, "inactive");
    assert.equal(persistedActive(session), false);
    inactivePlan = structuredClone(planEntries(session).at(-1).data);
    assert.equal(inactivePlan.active, false);
    assert.equal(inactivePlan.planId, activePlan.planId, "native exit preserves genuine Plan identity");
    assert.equal(inactivePlan.ownerSessionId, activePlan.ownerSessionId);
    assert.equal(inactivePlan.candidatePath, activePlan.candidatePath);
    assertUnpublished(inactivePlan);
    checkpointCounts.after = checkpointEntries().length;
    assert.deepEqual(checkpointEntries(), beforeCheckpoints);
    restoredTheme = ctx.ui.theme.name;
    assert.equal(restoredTheme, originalTheme, "Plan exit restores exact original theme");
    assert.deepEqual(session.getActiveToolNames(), initial.tools);
    assert.equal(screen.getFocusedComponent(), editor);
    assert.equal(planEntries(session).at(-1).data.publishedPath, undefined);
    control.run = async options => result(options);
    await prompt("/guild-handover coder/general reopened Plan UI gate");
    assert.equal(control.calls, beforeVeto.calls + 1);
    assert.equal(control.captures, beforeVeto.captures + 1);
    assert.equal(control.bindings, beforeVeto.bindings + 1);
    assert.equal(control.bindings, control.unbinds);
  } catch (error) { failure = error.stack ?? String(error); }
  finally {
    release.resolve();
    try {
      await bounded(Promise.all(pending), "interactive commands drain");
    } catch (error) { failure ??= String(error); }
    finally {
      try { if (runtime) await bounded(runtime.dispose(), "interactive dispose"); }
      catch (error) { failure ??= String(error); }
      finally {
        // Allow the native scheduled render to flush disposal notifications before stop.
        await new Promise(resolve => setTimeout(resolve, 50));
        try { mode?.stop(); } finally { unsubscribe?.(); }
      }
    }
  }
  try {
    // Specific caught-failure markers, not a generic notification parser. Keep this
    // after dispose/stop so late fallback/restoration diagnostics cannot escape.
    const output = rendered();
    for (const marker of ["The exit chooser failed", "Plan mode was not",
      "Plan session state is inconsistent", "Failed to switch to theme", "Theme not found:",
      "Plan reconciliation is blocked", "Plan finalization could not be dispatched"]) {
      assert.ok(!output.includes(marker.replace(/\s+/gu, "")), `unexpected terminal failure: ${marker}`);
    }
    const allowedVeto = "Guild handover failed: Guild handover is unavailable because Plan mode is active.".replace(/\s+/gu, "");
    assert.ok(!output.replaceAll(allowedVeto, "").includes("Guildhandoverfailed:"), "unexpected Guild failure notification");
    assert.deepEqual(errors, []);
    assert.equal(control.agentStarts, 0);
    assert.equal(control.shutdowns, 1);
    assert.equal(terminal.starts, 1);
    assert.equal(terminal.stops, 1);
  } catch (error) { failure ??= String(error); }
  log({ phase: "case", order, case: name, status: failure ? "failed" : "passed",
    originalTheme, restoredTheme, activePlanId: activePlan?.planId, inactivePlanId: inactivePlan?.planId,
    checkpointCounts, starts: terminal.starts, stops: terminal.stops,
    terminalBytes: Buffer.byteLength(terminal.output), ...counts(control), errors, failure });
  if (!failure) passed++;
}

let passed = 0;
for (const order of ["guild-first", "plan-first"]) {
  const errors = [];
  const bus = sdk.createEventBus();
  const paths = order === "guild-first" ? [fixture, plan] : [plan, fixture];
  const loaded = await sdk.discoverAndLoadExtensions(paths, process.cwd(), process.env.PI_CODING_AGENT_DIR, bus);
  assert.deepEqual(loaded.errors, [], "Both real registrations must load");
  assert.deepEqual(loaded.extensions.map(extension => extension.resolvedPath), paths);
  let control;
  bus.emit("plan-probe:control", value => { control = value; });
  assert.ok(control);
  assert.equal(control.SessionManager, sdk.SessionManager);
  assert.equal(control.createAssistantMessageEventStream, ai.createAssistantMessageEventStream);
  // Inspection only: attachment here would repair the missing production boundary and mask the bug.
  const inspect = () => {
    const replies = [];
    bus.emit("pithos.plan.coordination", { version: 1, reply: value => replies.push(value) });
    assert.equal(replies.length, 1);
    assert.equal(replies[0].version, 1);
    return replies[0].inspect();
  };
  const release = deferred();
  const entered = deferred();
  let runtime, active, runOptions;
  try {
    runtime = await sdk.createAgentSessionRuntime(async options => {
      // Metadata only: fake capture/trace need a directory; memory persistence is unchanged.
      options.sessionManager.getSessionDir = () => process.env.TMPDIR;
      return createSession(options, loaded);
    }, { cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR,
      sessionManager: sdk.SessionManager.inMemory(process.cwd()) });
    const session = runtime.session;
    await session.bindExtensions({ mode: "json", onError: error => errors.push(error) });
    assert.equal(control.starts, 1);
    assert.equal(session.sessionManager.isPersisted(), false);
    assert.equal(session.sessionFile, undefined);
    const ctx = session.extensionRunner.createContext();
    assert.equal(ctx.mode, "json");
    assert.equal(ctx.hasUI, false);
    const tool = session.extensionRunner.getToolDefinition("guild_handover");
    assert.ok(tool);
    assert.ok(session.extensionRunner.getCommand("plan"));
    const command = text => bounded(session.prompt(text), text);
    const snapshot = () => ({ phase: inspect().phase, persistedActive: persistedActive(session),
      planEntries: planEntries(session).length, tools: session.getActiveToolNames(),
      idle: ctx.isIdle(), ...counts(control), aborted: runOptions?.signal.aborted });
    const busyFailures = [];
    let before, held, after;
    try {
      before = snapshot();
      assert.equal(before.phase, "inactive", "actual session_start must finish Plan readiness");
      assert.equal(before.persistedActive, false);
      assert.equal(before.idle, true);
      assert.deepEqual(before.tools, ["guild_handover"], "nonempty loadout makes restoration observable");
      control.run = async options => { runOptions = options; entered.resolve(); await release.promise; return result(options); };
      active = settle(tool.execute("held", input, undefined, undefined, ctx));
      await bounded(Promise.race([entered.promise, active.then(() => { throw new Error("Guild settled before runner entry"); })]), "held registered runner entry");
      held = snapshot();
      assert.equal(held.idle, true, "not a generic busy-agent command refusal");
      assert.equal(held.calls, 1);
      assert.equal(held.captures, 1);
      assert.equal(held.bindings, 1);
      // Detach data before invocation: latest active=false alone misses appended
      // inactive entries or an active/inactive pair during a refused entry.
      const heldPlanData = structuredClone(planEntries(session).map(entry => entry.data));
      await command("/plan");
      after = snapshot();
      for (const check of [
        () => assert.equal(after.phase, "inactive", "busy Guild must refuse live Plan entry"),
        () => assert.equal(after.persistedActive, false, "busy refusal must leave persisted Plan inactive"),
        () => assert.deepEqual(planEntries(session).map(entry => entry.data), heldPlanData,
          "busy refusal must preserve Plan entry data"),
        () => assert.deepEqual(after.tools, before.tools, "busy refusal must preserve tool loadout"),
        () => assert.equal(after.aborted, false, "Plan entry must not cancel Guild"),
        () => assert.equal(after.calls, 1),
        () => assert.equal(after.agentStarts, 0),
        () => assert.deepEqual(errors, []),
      ]) { try { check(); } catch (error) { busyFailures.push(String(error)); } }
    } catch (error) { busyFailures.push(String(error)); }
    finally {
      release.resolve();
      if (active) assert.equal((await bounded(active, "held runner drain")).error, undefined);
      if (persistedActive(session)) await command("/plan exit");
    }
    if (!busyFailures.length) passed++;
    log({ phase: "case", order, case: "busy-entry", status: busyFailures.length ? "failed" : "passed",
      paths, before, held, after, drained: snapshot(), failures: busyFailures, errors });

    const positiveFailures = [];
    let drained, inPlan, veto, reopened;
    try {
      drained = snapshot();
      assert.equal(drained.phase, "inactive");
      assert.equal(drained.bindings, drained.unbinds);
      control.run = async options => result(options);
      await command("/plan");
      inPlan = snapshot();
      assert.equal(inPlan.phase, "active");
      assert.equal(inPlan.persistedActive, true);
      assert.deepEqual([...inPlan.tools].sort(), ["create_plan", "update_plan_draft"]);
      assert.equal(planEntries(session).at(-1).data.checkpointRevision, undefined);
      assert.equal(planEntries(session).at(-1).data.publishedPath, undefined);
      veto = await bounded(settle(tool.execute("active-plan", input, undefined, undefined, ctx)), "active Plan veto");
      assert.match(veto.error ?? "", /Plan mode is active/);
      assert.deepEqual(counts(control), { calls: drained.calls, captures: drained.captures,
        bindings: drained.bindings, unbinds: drained.unbinds, agentStarts: 0 }, "active Plan must veto before runner/capture/bind");
      await command("/plan exit");
      assert.equal(inspect().phase, "inactive");
      assert.equal(persistedActive(session), false);
      assert.deepEqual(session.getActiveToolNames(), before.tools);
      assert.equal((await bounded(settle(tool.execute("reopened", input, undefined, undefined, ctx)), "reopened Guild")).error, undefined);
      reopened = snapshot();
      assert.equal(reopened.calls, drained.calls + 1);
      assert.equal(reopened.captures, drained.captures + 1);
      assert.equal(reopened.bindings, drained.bindings + 1);
      assert.equal(reopened.unbinds, reopened.bindings);
      assert.equal(reopened.agentStarts, 0);
      assert.deepEqual(errors, []);
    } catch (error) { positiveFailures.push(String(error)); }
    finally { if (persistedActive(session)) await command("/plan exit"); }
    if (!positiveFailures.length) passed++;
    log({ phase: "case", order, case: "active-veto-and-reopen", status: positiveFailures.length ? "failed" : "passed",
      drained, inPlan, veto, reopened, failures: positiveFailures, errors });
  } finally {
    release.resolve();
    if (active) await bounded(active, "final runner drain");
    if (runtime) {
      if (persistedActive(runtime.session)) await bounded(runtime.session.prompt("/plan exit"), "final Plan exit");
      await bounded(runtime.dispose(), "actual host disposal");
      assert.equal(control.shutdowns, 1);
      assert.deepEqual(errors, []);
      assert.equal(control.agentStarts, 0);
      log({ phase: "disposed", order, shutdowns: control.shutdowns, ...counts(control), errors });
    }
  }
  for (const name of ["held-navigation-and-fresh-owner", "branch-roundtrip-reconciliation"]) await treeCase(order, name);
  await interactiveCase(order);
}
log({ phase: "summary", passed, failed: 10 - passed, complete: passed === 10 });
if (passed !== 10) process.exitCode = 1;
