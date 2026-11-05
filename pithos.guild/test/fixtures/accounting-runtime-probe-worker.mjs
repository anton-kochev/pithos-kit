/** Public installed SDK only; local deterministic transport, never a live provider. */
import assert from "node:assert/strict";
import { readFile, realpath, mkdir } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

assert.equal(process.env.PI_OFFLINE, "1");
assert.deepEqual(Object.keys(process.env).sort(), ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "TMPDIR", "TMP", "TEMP", "PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_SKIP_VERSION_CHECK", "PI_TELEMETRY"].sort());
const cli = await realpath(process.argv[2]);
const root = dirname(dirname(cli));
assert.equal(cli, await realpath(join(root, "dist/cli.js")));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
assert.equal(manifest.name, "@earendil-works/pi-coding-agent");
assert.equal(manifest.version, "1.4.0");
assert.equal(manifest.exports["."].import, "./dist/index.js");
const sdkUrl = pathToFileURL(join(root, "dist/index.js"));
const sdk = await import(sdkUrl.href);
async function selected(name) {
 const path = findPackageJSON(name, sdkUrl);
 const manifest = JSON.parse(await readFile(path, "utf8"));
 assert.equal(manifest.name, name); assert.equal(manifest.version, "1.4.0");
 return import(pathToFileURL(join(dirname(path), manifest.exports?.["."]?.import ?? manifest.main)).href);
}
const ai = await selected("@earendil-works/pi-ai");
const tui = await selected("@earendil-works/pi-tui");
const log = record => console.log(JSON.stringify(record));
log({phase: "runtime", version: sdk.VERSION, aiVersion: ai.PI_AI_VERSION, cli});
const mutation = process.argv[3] ?? "";
assert.ok(["", "repeat-usage", "early-ack"].includes(mutation));
const phase = process.argv[4] ?? "full";
assert.ok(["full", "claim-exit", "recover"].includes(phase));
const errors = [];
let control;
let streamCalls = 0;
let next;
const zero = () => ({input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}});
const provider = "accounting-local-script";
const model = {id: "scripted", name: "Local accounting script", provider, api: provider, baseUrl: "https://accounting.invalid", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 1024, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}};
const credentials = new ai.InMemoryCredentialStore();
const modelRuntime = await sdk.ModelRuntime.create({credentials, modelsPath: null, modelsStore: new ai.InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false});
modelRuntime.registerProvider(provider, {api: provider, baseUrl: model.baseUrl, apiKey: "local-script-not-a-credential", models: [model],
 streamSimple(requestModel) {
  assert.equal(requestModel.id, model.id);
  assert.ok(++streamCalls <= 20, "Unplanned scripted turns");
  const call = next; next = undefined;
  const stream = ai.createAssistantMessageEventStream();
  const message = {role: "assistant", api: model.api, provider, model: model.id, content: [], stopReason: "pending", timestamp: Date.now(), usage: zero()};
  queueMicrotask(() => {
   stream.push({type: "start", partial: message});
   if (call) {
    const block = {type: "toolCall", id: call.id, name: "guild_wait", arguments: {runId: call.runId, ...(call.lost ? {lost: true} : {})}};
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
const sessionsDir = join(process.cwd(), phase === "full" ? "sessions" : "loss-sessions");
await mkdir(sessionsDir, {recursive: true});
const manager = phase === "recover"
 ? sdk.SessionManager.open(process.argv[5], sessionsDir)
 : sdk.SessionManager.create(process.cwd(), sessionsDir);
const factory = async ({cwd, sessionManager, sessionStartEvent}) => {
 const bus = sdk.createEventBus();
 const extensions = await sdk.discoverAndLoadExtensions([fileURLToPath(new URL("./accounting-runtime-probe-guild.ts", import.meta.url))], cwd, process.env.PI_CODING_AGENT_DIR, bus);
 assert.deepEqual(extensions.errors, []);
 bus.emit("accounting-probe:control", value => { control = value; });
 assert.equal(control.SessionManager, sdk.SessionManager);
 assert.equal(control.createAssistantMessageEventStream, ai.createAssistantMessageEventStream);
 assert.equal(control.Text, tui.Text);
 control.mutation = mutation;
 control.afterClaim = phase === "claim-exit" ? receipt => {
  assert.equal(receipt.native, "claimed");
  assert.equal(manager.getEntries().filter(e => e.type === "custom" && e.data?.kind === "collected" && e.data.runId === "exit").length, 1);
  // Deliberately bypass disposal: no external provider or child exists. This is not a power-loss/fsync test.
  process.stdout.write(JSON.stringify({phase: "claim-checkpoint", file: manager.getSessionFile(),
   sessionId: receipt.sessionId, runId: receipt.runId, taskId: receipt.taskId,
   collectionId: receipt.collectionId, toolCallId: receipt.toolCallId}) + "\n", () => process.exit(23));
  return new Promise(() => {}); // No tool return can race the exit callback.
 } : undefined;
 const resourceLoader = {
  getExtensions: () => extensions, getSkills: () => ({skills: [], diagnostics: []}), getPrompts: () => ({prompts: [], diagnostics: []}),
  getThemes: () => ({themes: [], diagnostics: []}), getAgentsFiles: () => ({agentsFiles: []}),
  getSystemPrompt: () => "Provider-free accounting fixture", getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
  extendResources: () => { throw new Error("No discovery"); }, reload: async () => { throw new Error("No reload"); },
 };
 const settingsManager = sdk.SettingsManager.inMemory({compaction: {enabled: false}, retry: {enabled: false, provider: {maxRetries: 0}}, cacheWarming: "off", enableInstallTelemetry: false});
 const services = {cwd, agentDir: process.env.PI_CODING_AGENT_DIR, modelRuntime, settingsManager, resourceLoader, diagnostics: []};
 return {...await sdk.createAgentSessionFromServices({services, sessionManager, sessionStartEvent, model, thinkingLevel: "off", tools: ["guild_wait"], noTools: "builtin"}), services, diagnostics: []};
};
const runtime = await sdk.createAgentSessionRuntime(factory, {cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR, sessionManager: manager});
assert.ok(runtime instanceof sdk.AgentSessionRuntime);
const session = runtime.session;
assert.ok(session instanceof sdk.AgentSession);
assert.ok(session.extensionRunner instanceof sdk.ExtensionRunner);
const file = manager.getSessionFile();
let saved;
try {
 await session.bindExtensions({mode: "json", onError: error => errors.push(error)});
 session.setActiveToolsByName(["guild_wait"]);
 async function prompt(id, runId, lost = false) {
  const before = streamCalls;
  next = id ? {id, runId, lost} : undefined;
  await session.prompt("local scripted accounting turn");
  await session.waitForIdle();
  assert.equal(next, undefined);
  assert.equal(streamCalls - before, id ? 2 : 1);
 }
 if (phase === "recover") {
  control.reload();
  const receipts = () => manager.getEntries().filter(e => e.type === "custom" && e.data?.kind === "collected" && e.data.runId === "exit");
  assert.equal(receipts().length, 1, "Recovery must retain exactly one original receipt");
  assert.equal(control.reconcile("exit"), "claimed-ambiguous");
  assert.ok(control.inspect("exit")?.report, "Restore terminal observation, not child execution");
  await prompt("call-exit-retry", "exit");
  const retry = manager.getEntries().find(e => e.type === "message" && e.message.toolCallId === "call-exit-retry").message;
  assert.deepEqual(retry.content, [{type: "text", text: "informational"}]);
  assert.equal(session.getSessionStats().tokens.total, 0, "Recovery native totals must remain unattributed");
  assert.equal(session.getSessionStats().cost, 0);
  assert.equal(retry.usage, undefined, "Recovery retry must not reattribute native usage");
  assert.equal(retry.details?.guildBackground, undefined);
  assert.equal(receipts().length, 1, "Retry must not create another receipt");
  assert.equal(control.reconcile("exit"), "claimed-ambiguous");
  assert.equal(manager.getEntries().filter(e => e.type === "message" && e.message.role === "toolResult" && e.message.toolCallId === "call-exit").length, 0);
  saved = JSON.parse(JSON.stringify(manager.getEntries()));
  log({phase: "recovery", receipts: 1, matchingToolResults: 0, retryToolResults: 1, nativeTokens: 0, nativeCost: 0,
   reconciliation: "claimed-ambiguous", streamCalls});
 } else {
 // The SDK delays the initial file flush until an assistant response. Seed through the real loop.
 await prompt();
 if (phase === "claim-exit") {
  control.reserve("exit");
  await prompt("call-exit", "exit");
  assert.fail("Claim-exit worker must never return from its tool");
 }
 const rootLeaf = manager.getLeafId();
 control.reserve("first");
 const admitted = manager.getEntries().find(e => e.type === "custom" && e.data.kind === "admitted").id;
 control.reserve("sibling");
 control.reserve("lost");
 await prompt("call-first", "first");
 assert.deepEqual(control.hooks, [
  {hook: "tool_result", runId: "first", reconciliation: "claimed-ambiguous"},
  {hook: "message_end", runId: "first", reconciliation: "claimed-ambiguous"},
 ], "PREPERSIST hooks cannot acknowledge persistence");
 assert.equal(control.reconcile("first"), "persisted-matching");
 await prompt("call-repeat", "first");
 assert.equal(session.getSessionStats().tokens.total, 80, "Repeat must not reattribute native usage");
 await prompt("call-sibling", "sibling");
 assert.equal(control.reconcile("sibling"), "persisted-matching");
 await prompt("call-lost", "lost", true);
 // A thrown execute produces a native error result with no usage/correlation: this conflicts
 // with the claimed tool ID, rather than proving delivery. Reload before checking retry refusal.
 const lostState = control.reconcile("lost");
 assert.equal(lostState, "persisted-conflict");
 control.reload();
 await prompt("call-lost-repeat", "lost");
 assert.equal(session.getSessionStats().tokens.total, 160);
 assert.equal(session.getSessionStats().cost, 1.6);
 const results = manager.getEntries().filter(e => e.type === "message" && e.message.role === "toolResult").map(e => e.message);
 assert.equal(results.length, 5);
 for (const id of ["call-first", "call-sibling"]) {
  const result = results.find(m => m.toolCallId === id);
  assert.deepEqual(result.usage, control.usage);
  assert.deepEqual(result.details.guildBackground, {version: 1, sessionId: manager.getSessionId(), runId: id.slice(5), taskId: `t-${id.slice(5)}`, collectionId: `collection-${id}`});
 }
 for (const result of results.filter(m => !["call-first", "call-sibling"].includes(m.toolCallId))) assert.equal(result.usage, undefined);
 for (const id of ["call-repeat", "call-lost-repeat"]) {
  assert.deepEqual(results.find(m => m.toolCallId === id).content, [{type: "text", text: "informational"}]);
 }
 assert.equal(results.find(m => m.toolCallId === "call-lost").isError, true);
 const leaf = manager.getLeafId();
 control.transition(); manager.branch(rootLeaf); control.transition();
 assert.equal(control.inspect("first"), undefined);
 await prompt("call-no-origin", "first");
 const rejected = manager.getEntries().find(e => e.type === "message" && e.message.toolCallId === "call-no-origin").message;
 assert.deepEqual(rejected.content, [{type: "text", text: "rejected"}]);
 assert.equal(rejected.usage, undefined);
 control.transition(); manager.branch(admitted); control.transition();
 assert.ok(control.inspect("first")?.report);
 await prompt("call-offbranch-repeat", "first");
 const offbranch = manager.getEntries().find(e => e.type === "message" && e.message.toolCallId === "call-offbranch-repeat").message;
 assert.deepEqual(offbranch.content, [{type: "text", text: "informational"}]);
 assert.equal(offbranch.usage, undefined);
 assert.equal(session.getSessionStats().tokens.total, 160, "Global receipt survives off-branch native result");
 control.transition(); manager.branch(leaf); control.transition();
 control.reload();
 assert.ok(control.inspect("sibling")?.report, "New ledger restores terminal observations without children");
 assert.equal(control.reconcile("first"), "persisted-matching");
 assert.equal(session.getSessionStats().tokens.total, 160);
 saved = JSON.parse(JSON.stringify(manager.getEntries())); // JSON omits optional undefined fields.
 const oldJournal = control.journal;
 await runtime.newSession();
 await runtime.session.bindExtensions({mode: "json", onError: error => errors.push(error)});
 assert.throws(() => oldJournal.append({}), /^Error: Background journal unavailable$/);
 assert.deepEqual(await credentials.list(), []);
 log({phase: "accounting", hooks: "prepersist-ambiguous", tokens: 160, cost: 1.6, lostState, streamCalls, graphIdentity: true});
 }
} finally {
 await runtime.dispose();
}
assert.deepEqual(errors, [], "Extension errors including disposal must fail qualification");
const disk = (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
assert.equal(disk[0].type, "session");
assert.deepEqual(disk.slice(1), saved, "Actual SDK JSONL readback must match stored entries after disposal");
log({phase: "summary", passed: true, workerPhase: phase, file, mutation, limitations: ["No child execution or public tools", "No fsync/crash atomicity", "Nested collection unqualified: future public tool_call must refuse parentToolCallId", "Thrown execute persists conflict; controlled process exit retains ambiguity, not power-loss certification"]});
