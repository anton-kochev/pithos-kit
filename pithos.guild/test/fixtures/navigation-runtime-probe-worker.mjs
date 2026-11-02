/**
 * Installed-runtime Guild navigation acceptance probe; not Escape or full TUI proof.
 * Plain ESM deliberately avoids tsx and the checkout's Pi 0.99 dependency graph.
 * Run only through tools/navigation-runtime-probe.ts with an explicit Pi 1.4.0 CLI.
 */
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
assert.equal(ai.PI_AI_VERSION, "1.4.0");
const log = (record) => console.log(JSON.stringify(record));
log({ phase: "runtime", version: sdk.VERSION, cli, sdk: sdkUrl.href, ai: aiUrl.href,
  node: process.version, pid: process.pid, aiVersion: ai.PI_AI_VERSION, scope: "real Guild native-navigation acceptance (all cases must pass)" });

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
// Fail closed before claiming integrated evidence if the public loader cannot load real Guild.
const guildFixture = fileURLToPath(new URL("./navigation-runtime-probe-guild.ts", import.meta.url));
async function loadGuild() {
const guildBus = sdk.createEventBus();
const loadedGuild = await sdk.discoverAndLoadExtensions(
  [guildFixture], process.cwd(), process.env.PI_CODING_AGENT_DIR, guildBus,
);
let guildControl;
guildBus.emit("navigation-probe:control", control => { guildControl = control; });
assert.ok(guildControl, "Fixture must expose real runtime activation observations");
assert.equal(guildControl.activations, 1);
assert.equal(guildControl.sdkVersion, "1.4.0");
assert.equal(guildControl.SessionManager, sdk.SessionManager, "Public loader must alias Guild SDK to selected installation");
assert.equal(guildControl.createAssistantMessageEventStream, ai.createAssistantMessageEventStream,
  "Public loader AI compat alias must share selected installed AI graph");
assert.deepEqual(loadedGuild.errors, [], "Real Guild public-loader integration must load without errors");
assert.deepEqual(loadedGuild.extensions.map(extension => extension.resolvedPath), [guildFixture]);
const guildExtension = loadedGuild.extensions[0];
await realpath(guildExtension.resolvedPath); // Loader metadata must be a usable filesystem path, including in spaced checkouts.
assert.ok(guildExtension.handlers.has("session_before_tree"));
assert.ok(guildExtension.handlers.has("input"));
assert.ok(guildExtension.tools.has("guild_handover"));

log({ phase: "guild-loader", sdkVersion: guildControl.sdkVersion, aiVersion: ai.PI_AI_VERSION,
  sdk: sdkUrl.href, ai: aiUrl.href, extensions: loadedGuild.extensions.map(extension => extension.resolvedPath),
  sdkIdentity: true, aiIdentity: true, handlers: ["session_before_tree", "input"], tools: [...guildExtension.tools.keys()] });
return { ...loadedGuild, control: guildControl };
}

const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const provider = "navigation-runtime-probe";
const model = { id: "scripted", name: "Scripted summary failure only", provider, api: provider,
  baseUrl: "https://navigation-runtime-probe.invalid", reasoning: false, input: ["text"],
  contextWindow: 32000, maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const assistant = (text) => ({ role: "assistant", api: model.api, provider, model: model.id,
  content: [{ type: "text", text }], stopReason: "stop", timestamp: Date.now(), usage: zeroUsage() });

const cases = ["no-op", "own-veto", "later-veto", "success", "deferred-before", "rejected-summary", "aborted-summary", "cleanup-failure", "foreign-hook-error"];
let passed = 0;
for (const name of cases) {
  const guild = await loadGuild();
  guild.control.failCleanup = name === "cleanup-failure";
  const before = [];
  const tree = [];
  const errors = [];
  const entered = deferred();
  const release = deferred();
  const runEntered = deferred();
  const runRelease = deferred();
  let runOptions;
  let runCalls = 0;
  let updates = 0;
  let active;
  let queued;
  const streamEntered = deferred();
  const streamRelease = deferred();
  let ctx;
  let session;
  let idleWait;
  let idleWaitResolved = false;
  let idleAtWaitResolution;
  let idleAfterNavigation;
  let operationFinished = false;
  let calls = 0;
  let streamAborted = false;
  let result;
  let rejection;
  let held;
  let failure;
  const manager = sdk.SessionManager.inMemory(process.cwd());
  if (name === "cleanup-failure") {
    // inMemory has no directory option. Only fake capture/trace observation needs
    // directory metadata; leave persistence and every lifecycle method untouched.
    manager.getSessionDir = () => process.env.TMPDIR;
    log({ phase: "trace-directory-seam", case: name, directory: manager.getSessionDir(),
      override: "isolated instance public getSessionDir", persistence: "real inMemory" });
  }
  assert.ok(manager instanceof sdk.SessionManager);
  const root = manager.appendMessage({ role: "user", content: "root", timestamp: Date.now() });
  const target = manager.appendMessage(assistant("target branch"));
  manager.branch(root);
  manager.appendMessage({ role: "user", content: "abandoned branch", timestamp: Date.now() });
  manager.appendMessage(assistant("abandoned work to summarize"));
  let oldLeaf;
  const watchIdle = () => {
    if (!idleWait) idleWait = session.waitForIdle().then(() => {
      idleWaitResolved = true;
      idleAtWaitResolution = ctx.isIdle();
    });
  };

  // External ordering observers bracket the public-loader result for real Guild.
  // Pi owns context creation and dispatch; no Guild lifecycle handler is copied here.
  const extensions = ["own", "later"].map((handler) => {
    const path = `<inline:navigation-probe-${handler}>`;
    return {
      path, resolvedPath: path,
      sourceInfo: sdk.createSyntheticSourceInfo(path, { source: "inline", scope: "temporary" }),
      tools: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map(), messageRenderers: new Map(),
      handlers: new Map([
        ["session_start", [(_event, context) => { if (handler === "own") ctx = context; }]],
        ["session_before_tree", [async (event, context) => {
          before.push({ handler, idle: context.isIdle(), leaf: context.sessionManager.getLeafId(),
            target: event.preparation.targetId, oldLeaf: event.preparation.oldLeafId,
            summarize: event.preparation.userWantsSummary,
            eventSignalPresent: event.signal instanceof AbortSignal });
          if (name === "foreign-hook-error" && handler === "own") throw new Error("scripted-foreign-before-error");
          // Observe, but never await idle inside a lifecycle handler: that would deadlock.
          watchIdle();
          if (name === "deferred-before" && handler === "own") {
            entered.resolve();
            await release.promise;
            before.push({ handler: "own-released", idle: context.isIdle(), leaf: context.sessionManager.getLeafId() });
          }
          if ((name === "own-veto" && handler === "own") || (name === "later-veto" && handler === "later")) {
            return { cancel: true };
          }
        }]],
        ["session_tree", [async (event, context) => {
          tree.push({ handler, idle: context.isIdle(), leaf: context.sessionManager.getLeafId(),
            oldLeaf: event.oldLeafId, newLeaf: event.newLeafId, operationFinished });
          if (name === "success" && handler === "own") {
            entered.resolve();
            await release.promise;
          }
        }]],
      ]),
    };
  });
  extensions.splice(1, 0, ...guild.extensions);
  extensions.at(-1).handlers.set("input", [() => ({ action: "handled" })]);
  const extensionResult = { extensions, errors: [], runtime: guild.runtime };
  const resourceLoader = {
    getExtensions: () => extensionResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "Provider-free navigation compatibility probe.",
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources: () => { throw new Error("Resource discovery is forbidden"); },
    reload: async () => { throw new Error("Resource reload is forbidden"); },
  };
  const credentials = new ai.InMemoryCredentialStore();
  const runtime = await sdk.ModelRuntime.create({ credentials, modelsPath: null,
    modelsStore: new ai.InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider(provider, {
    api: provider, baseUrl: model.baseUrl, apiKey: "not-a-credential", models: [model],
    streamSimple(requestModel, _context, options) {
      ++calls;
      const stream = ai.createAssistantMessageEventStream();
      // Only summary cases may reach this terminal-error transport. There is no network fallback.
      void (async () => {
        const message = { ...assistant(""), content: [] };
        try {
          assert.ok(["rejected-summary", "aborted-summary"].includes(name), "Unexpected provider request");
          assert.equal(calls, 1);
          assert.equal(requestModel.provider, provider);
          assert.equal(requestModel.id, model.id);
          assert.ok(options?.signal instanceof AbortSignal, "Summary stream requires its own cancellation signal");
          streamEntered.resolve();
          if (name === "aborted-summary") {
            if (!options.signal.aborted) await new Promise(resolve => {
              options.signal.addEventListener("abort", resolve, { once: true });
            });
            streamAborted = options.signal.aborted;
            message.stopReason = "aborted";
            message.errorMessage = "scripted-summary-aborted";
          } else {
            await streamRelease.promise;
            message.stopReason = "error";
            message.errorMessage = "scripted-summary-rejected";
          }
        } catch (error) {
          errors.push(String(error));
          message.stopReason = "error";
          message.errorMessage = String(error);
        }
        // Request setup failed, so no start/content/response events or real request exist.
        stream.push({ type: "error", reason: message.stopReason, error: message });
        stream.end();
      })();
      return stream;
    },
  });
  try {
    const created = await sdk.createAgentSession({ cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR,
      model, modelRuntime: runtime, thinkingLevel: "off", tools: [], noTools: "all", customTools: [],
      resourceLoader, sessionManager: manager,
      settingsManager: sdk.SettingsManager.inMemory({ compaction: { enabled: false },
        retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: "off", enableInstallTelemetry: false }),
    });
    session = created.session;
    assert.equal(session.sessionManager, manager, "real session must retain the memory-only manager");
    assert.ok(session.extensionRunner instanceof sdk.ExtensionRunner);
    assert.deepEqual(created.extensionsResult.errors, []);
    await session.bindExtensions({ mode: "json", onError: error => { errors.push(error); } });
    assert.ok(ctx, "session_start must supply a real ExtensionContext");
    assert.equal(ctx.isIdle(), true);
    assert.deepEqual(session.getActiveToolNames(), []);
    assert.equal(manager.getSessionFile(), undefined);
    // Factory/binding may append setup entries (e.g. thinking level). Snapshot the
    // actual starting leaf after setup, not the last message used to seed history.
    assert.deepEqual(session.extensionRunner.getAllRegisteredTools().map(tool => tool.definition.name).sort(),
      ["create_commit", "guild_handover"]);
    assert.equal(guild.extensions[0].handlers.has("app_interrupt"), false);
    assert.equal(typeof guild.control.run, "function", "Controllable runner seam is required");
    guild.control.run = async options => {
      runCalls++;
      runOptions = options;
      runEntered.resolve();
      await runRelease.promise;
      return { role: options.role, profile: options.profile, task: options.task,
        status: "cancelled", output: "fixture cleanup complete", exitCode: 0, stderr: "",
        activity: "Cancelled", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
          cost: 0, contextTokens: 0, turns: 0 } };
    };
    const tool = session.extensionRunner.getToolDefinition("guild_handover");
    const input = { role: "coder", profile: "general", task: "provider-free cleanup gate" };
    active = tool.execute("active", input, undefined, () => { updates++; },
      session.extensionRunner.createContext());
    const activeSettlement = active.then(value => ({ value }), error => ({ error: String(error) }));
    await bounded(runEntered.promise, "real Guild runner entry");
    queued = tool.execute("queued", input, undefined, undefined,
      session.extensionRunner.createContext());
    oldLeaf = manager.getLeafId();
    assert.ok(oldLeaf && oldLeaf !== target);
    const summarize = name.endsWith("summary");
    const navigation = session.navigateTree(name === "no-op" ? oldLeaf : target, { summarize }).then(
      value => { result = value; operationFinished = true; },
      error => { rejection = String(error); operationFinished = true; },
    );
    const retires = !["no-op", "own-veto"].includes(name);
    // The deferred external hook must release before Guild can receive the event.
    if (name === "deferred-before") {
      await bounded(entered.promise, "external before hook");
      assert.equal(runOptions.signal.aborted, false);
      await delay(25);
      held = { idle: ctx.isIdle(), idleWaitResolved, operationFinished, leaf: manager.getLeafId() };
      assert.deepEqual(held, { idle: false, idleWaitResolved: false, operationFinished: false, leaf: oldLeaf });
      log({ phase: "held", case: name, ...held });
      release.resolve();
    }
    if (retires) {
      for (let attempt = 0; attempt < 100 && !runOptions.signal.aborted; attempt++) await delay(5);
      assert.equal(runOptions.signal.aborted, true, "real Guild retirement aborts the running operation");
      assert.equal((await bounded(queued, "queued cancellation")).details.status, "cancelled");
      await delay(25);
      assert.equal(operationFinished, false, "cleanup gate must prevent native navigation completion");
      assert.equal(manager.getLeafId(), oldLeaf, "cleanup gate must prevent native target mutation");
      assert.equal(runCalls, 1, "queued operation must never launch");
      await session.prompt("busy fresh intent", { source: "rpc" });
      assert.equal(guild.control.activations, 1, "busy input cannot rearm");
      const previousUpdates = updates;
      runOptions.onUpdate({ output: "stale update", usage: { turns: 1 } });
      assert.equal(updates, previousUpdates, "retired callback cannot publish a tool update");
      runRelease.resolve();
      const settled = await bounded(activeSettlement, "active cleanup");
      if (name === "cleanup-failure") {
        assert.equal(guild.control.traceBindings, 1, "real Guild must bind the fake trace recorder");
        assert.equal(guild.control.cleanupFaults, 1, "trace unbind must actually throw");
        assert.match(settled.error ?? "", /scripted-trace-cleanup-failure/);
      }
      else assert.equal(settled.value.details.status, "cancelled");
    }
    if (name === "no-op") {
      assert.equal(ctx.isIdle(), true, "No-op must never become busy");
      watchIdle();
    }
    if (["success", "rejected-summary", "aborted-summary"].includes(name)) {
      await bounded(summarize ? streamEntered.promise : entered.promise, `${name} entry`);
      await delay(25);
      held = { idle: ctx.isIdle(), idleWaitResolved, operationFinished, leaf: manager.getLeafId() };
      log({ phase: "held", case: name, ...held });
      assert.equal(held.idle, false, "Held navigation must remain nonidle");
      assert.equal(held.idleWaitResolved, false, "waitForIdle must stay pending while navigation is held");
      assert.equal(held.operationFinished, false);
      assert.equal(held.leaf, ["success", "deferred-before"].includes(name) ? target : oldLeaf);
      if (name === "aborted-summary") session.abortBranchSummary();
      else if (summarize) streamRelease.resolve();
      else release.resolve();
    }
    await bounded(navigation, `${name} navigation`);
    idleAfterNavigation = ctx.isIdle();
    assert.equal(idleAfterNavigation, true, "Navigation finally must restore idle");
    assert.ok(idleWait, "Idle observer must have been registered");
    await bounded(idleWait, `${name} waitForIdle after navigation`);
    assert.equal(idleAtWaitResolution, true, "waitForIdle resolved while ctx.isIdle was false");
    const success = ["success", "deferred-before", "foreign-hook-error"].includes(name);
    assert.equal(manager.getLeafId(), success ? target : oldLeaf);
    const expectedBefore = name === "no-op" ? [] : name === "own-veto" ? ["own"] :
      name === "deferred-before" ? ["own", "own-released", "later"] : name === "cleanup-failure" ? ["own"] : ["own", "later"];
    assert.deepEqual(before.map(event => event.handler), expectedBefore, "Early veto must skip the later hook");
    for (const event of before) {
      assert.equal(event.idle, false, "Before hooks must see nonidle");
      assert.equal(event.leaf, oldLeaf);
      if (event.handler !== "own-released") {
        assert.equal(event.target, target);
        assert.equal(event.oldLeaf, oldLeaf);
        assert.equal(event.summarize, summarize);
      }
    }
    assert.deepEqual(tree.map(event => event.handler), success ? ["own", "later"] : []);
    for (const event of tree) {
      assert.equal(event.idle, false, "Tree hooks must remain nonidle until completion");
      assert.equal(event.operationFinished, false);
      assert.equal(event.oldLeaf, oldLeaf);
      assert.equal(event.newLeaf, target);
      assert.equal(event.leaf, target);
    }
    assert.equal(calls, summarize ? 1 : 0);
    if (name === "rejected-summary") {
      assert.match(rejection ?? "", /scripted-summary-rejected/);
      assert.equal(result, undefined);
    } else {
      assert.equal(rejection, undefined);
      assert.equal(result.cancelled, ["own-veto", "later-veto", "aborted-summary", "cleanup-failure"].includes(name));
      assert.equal(result.aborted, name === "aborted-summary" ? true : undefined);
    }
    assert.equal(streamAborted, name === "aborted-summary");
    assert.equal(manager.getEntries().some(entry => entry.type === "branch_summary"), false);
    assert.deepEqual(await credentials.list(), []);
    assert.equal(manager.getSessionFile(), undefined);
    assert.deepEqual(session.getActiveToolNames(), []);
    assert.equal(guild.control.activations, 1, "navigation never automatically activates Guild");
    if (retires) {
      await session.prompt("extension intent", { source: "extension" });
      assert.equal(guild.control.activations, 1);
      await session.prompt("fresh intent", { source: name === "success" ? "interactive" : "rpc" });
      assert.equal(guild.control.activations, name === "cleanup-failure" ? 1 : 2, "idle fresh input rearms only safely retired runtime");
    } else {
      assert.equal(runOptions.signal.aborted, false, "no-op/earlier veto must not retire Guild");
    }
    log({ phase: "guild", case: name, activations: guild.control.activations, runCalls,
      traceBindings: guild.control.traceBindings, cleanupFaults: guild.control.cleanupFaults,
      retired: retires, sink: "later handled-input sink prevents provider start" });
    if (name === "foreign-hook-error") {
      assert.equal(errors.length, 1);
      assert.match(JSON.stringify(errors), /scripted-foreign-before-error/);
    } else assert.deepEqual(errors, [], "Unexpected extension/stream errors fail the probe");
  } catch (error) {
    failure = String(error);
  } finally {
    // Release only fixture gates; never force or patch the runtime's idle state.
    release.resolve();
    runRelease.resolve();
    streamRelease.resolve();
    if (session) await session.extensionRunner.emit({ type: "session_shutdown" });
    await Promise.allSettled([active, queued]);
    session?.abortBranchSummary();
    session?.dispose();
  }
  if (errors.length && name !== "foreign-hook-error" && !failure) failure = "Extension/stream errors during disposal";
  if (!failure) ++passed;
  log({ phase: "case", case: name, status: failure ? "failed" : "passed", before, tree, held,
    oldLeaf, target, leaf: manager.getLeafId(), result, rejection, calls, streamAborted,
    idleAfterNavigation, idleWaitResolved, idleAtWaitResolution, errors, failure });
}
log({ phase: "summary", version: sdk.VERSION, total: cases.length, passed, failed: cases.length - passed,
  limitations: ["No real provider or network", "No Escape/key presses/native TUI", "Runner gates emulate cleanup, not OS children", "No Plan integration or Pi >=1.0 certification",
    "Cleanup-failure uses isolated public getSessionDir metadata override for fake trace binding"] });
if (passed !== cases.length) process.exitCode = 1;
