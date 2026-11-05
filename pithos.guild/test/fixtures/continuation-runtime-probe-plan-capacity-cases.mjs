import assert from "node:assert/strict";
import {createHarness, deferred, bounded, tick, result, log} from "./continuation-runtime-probe-harness.mjs";

// Qualification list: capacity and started cancellation; both Plan registration
// orders at child/receipt boundaries; only eligible fresh input opens delivery.
const guildTools = ["guild_start", "guild_status", "guild_send", "guild_wait", "guild_cancel"];
const entries = h => h.session.sessionManager.getEntries();
const journal = (h, kind) => entries(h).filter(e => e.type === "custom" && e.data?.kind === kind);
const active = h => h.session.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === "plan-theme-state").at(-1)?.data.active ?? false;
const tools = h => h.session.getActiveToolNames().sort();
const fresh = (h, text = "fresh safe handled intent", source = "interactive") => bounded(h.session.prompt(text, {source}), text);
async function until(predicate, label) {
  await bounded((async () => {
    const end = performance.now() + 1200;
    while (!predicate()) { assert.ok(performance.now() < end, label); await tick(); }
  })(), label);
}
async function refusePlan(h, signals = [], route = "sdk") {
  const selection = tools(h), closes = h.control.closes.length;
  const receipts = h.control.accepted.map(record => record.receipt);
  const leases = h.control.opens.map(record => record.lease);
  await bounded(h.command("/plan", route, "refused"), "busy Plan command");
  assert.equal(active(h), false, "busy Plan entry refused");
  assert.deepEqual(h.control.accepted.map(record => record.receipt), receipts, "refusal retains actual receipts");
  assert.deepEqual(h.control.opens.map(record => record.lease), leases, "refusal retains actual leases");
  assert.deepEqual(tools(h), selection, "refusal preserves immediate current selection");
  assert.equal(h.control.closes.length, closes, "refusal cannot close delivery");
  assert.ok(signals.every(signal => !signal.aborted), "refusal cannot cancel children");
}
async function planIdle(h, route = "sdk") {
  const opens = h.control.opens.length, closes = h.control.closes.length;
  const selection = tools(h);
  assert.ok(selection.includes("semantic_nested_wait"));
  const closeRecords = h.control.closes, push = closeRecords.push;
  let closeObserved = false;
  closeRecords.push = function (...records) {
    assert.equal(active(h), false, "lease closes synchronously before Plan becomes active");
    assert.deepEqual(tools(h), selection, "lease closes before Plan loadout callouts");
    closeObserved = true;
    return Reflect.apply(push, this, records);
  };
  try { await bounded(h.command("/plan", route, "active"), "idle Plan entry"); }
  finally { closeRecords.push = push; }
  assert.equal(closeObserved, true);
  assert.equal(active(h), true);
  assert.equal(h.control.closes.length, closes + 1, "first idle entry closes delivery");
  assert.deepEqual(tools(h), ["create_plan", "update_plan_draft"]);
  // Keep this interrupt distinct from the child-drain Escape, not a double-Escape tree shortcut.
  await new Promise(resolve => setTimeout(resolve, 600));
  h.terminal.input("\x1b");
  for (const tool of guildTools) assert.equal(h.session.getToolDefinition(tool).exposure, "hidden");
  await fresh(h, "Plan-active handled intent");
  assert.equal(h.control.opens.length, opens, "Plan-active input cannot reopen");
  const offset = h.terminal.output.length;
  const operation = h.command("/plan exit", route, "inactive");
  operation.catch(() => {});
  await until(() => h.terminal.output.slice(offset).includes("Exit without publishing"), "Plan exit selector").catch(error => {
    log({phase: "plan-selector-diagnostic", route, output: h.terminal.output.slice(offset).slice(-4000)}); throw error;
  });
  h.terminal.input("\r");
  await bounded(operation, "Plan exit");
  assert.equal(active(h), false);
  assert.equal(h.control.opens.length, opens, "Plan exit is not fresh input");
  assert.deepEqual(tools(h).filter(t => guildTools.includes(t)), [], "hidden Guild tools not restored");
  const exited = tools(h);
  await fresh(h);
  assert.equal(h.control.opens.length, opens + 1);
  assert.deepEqual(tools(h), [...exited, ...guildTools].sort());
  assert.equal(h.control.accepted.length, 0, "new adapter is empty");
}
async function freshOnly() {
  const h = await createHarness("fresh-input-only");
  try {
    assert.equal(h.control.starts, 1);
    assert.equal(h.control.opens.length, 0, "initialization/session_start cannot open");
    await fresh(h, "extension-origin intent", "extension");
    assert.equal(h.control.opens.length, 0);
    await fresh(h, "handled RPC intent", "rpc");
    assert.equal(h.control.opens.length, 1);
    await fresh(h);
    assert.equal(h.control.opens.length, 1, "healthy input does not rebind");
    h.terminal.input("\x1b");
    await bounded(h.session.waitForIdle(), "interrupt idle"); await tick();
    assert.equal(h.control.opens.length, 1, "interrupt and idle do not reopen");
    await fresh(h, "extension after interrupt", "extension");
    assert.equal(h.control.opens.length, 1);
    await fresh(h);
    assert.equal(h.control.opens.length, 2);
    assert.equal(h.control.accepted.length, 0);
    assert.equal(h.state.streamCalls, 0, "handled input needs no model response");
  } finally { await h.dispose(); }
  const p = await createHarness("required-plan-guild-first");
  try {
    assert.equal(p.control.opens.length, 0, "Plan startup cannot open");
    await fresh(p);
    await planIdle(p);
  } finally { await p.dispose(); }
  await freshDrain();
}
async function freshDrain() {
  const question = deferred(), cleanup = deferred(), preparation = deferred(), entered = deferred();
  const h = await createHarness("fresh-input-only", {runner: async options => {
    await question.promise;
    try { await options.onQuestion("Fresh-input drain?", options.signal); }
    catch (error) { if (!options.signal.aborted) throw error; }
    await cleanup.promise;
    return result(options);
  }});
  try {
    assert.equal(h.control.opens.length, 0);
    await h.tool("guild_start", {role: "reviewer", profile: "general", task: "held fresh-input drain"});
    h.control.beforeAgent = async event => {
      if (event.messageType === "custom" && event.message.customType === "pi-parent-continuation") {
        entered.resolve(); await preparation.promise;
      } else { question.resolve(); await tick(); }
    };
    await bounded(h.prompt("publish question behind native turn"), "fresh drain ordinary turn");
    await bounded(entered.promise, "fresh drain preparation");
    const receipt = h.control.accepted[0].receipt, lease = h.control.opens[0].lease;
    let finished = false;
    receipt.finished.then(() => { finished = true; });
    h.terminal.input("\x1b");
    await tick();
    assert.equal(finished, false, "actual receipt joins externally held preparation");
    preparation.resolve();
    assert.deepEqual(await bounded(receipt.finished, "fresh drain receipt finished"), {outcome: "revoked", commitState: "none", started: false});
    await bounded(lease.closed, "fresh drain lease closed");
    assert.equal(h.control.opens.length, 1, "receipt finished and lease closed cannot reopen");
    await fresh(h, "fresh RPC while child cleanup held", "rpc");
    await fresh(h, "fresh interactive while child cleanup held");
    assert.equal(h.control.opens.length, 1, "early input cannot bank rearm");
    cleanup.resolve();
    await until(() => journal(h, "terminal").length === 1, "fresh drain child terminal");
    await bounded(h.session.waitForIdle(), "fresh drain idle"); await tick();
    assert.equal(h.control.opens.length, 1, "drain and idle do not consume banked input");
    await fresh(h, "extension after drain", "extension");
    assert.equal(h.control.opens.length, 1);
    await fresh(h, "later fresh RPC", "rpc");
    assert.equal(h.control.opens.length, 2);
    await fresh(h);
    assert.equal(h.control.opens.length, 2, "healthy adapter is not rebound");
    assert.equal(h.control.accepted.length, 1, "replacement is empty: no historical replay");
    assert.equal(h.state.autoResponses, 0);
  } finally { question.resolve(); preparation.resolve(); cleanup.resolve(); await h.dispose(); }
}
async function capacity() {
  const questions = deferred(), cleanup = deferred(), entered = deferred(), streamRelease = deferred();
  const launched = [];
  const h = await createHarness("started-escape-capacity", {runner: async options => {
    launched.push(options);
    await questions.promise;
    try { await options.onQuestion("Capacity question?", options.signal); } catch (error) {
      if (!options.signal.aborted) throw error;
    } finally { await cleanup.promise; }
    return result(options);
  }});
  let original, later;
  try {
    assert.ok("beforeStream" in h.state, "Shared harness beforeStream API required");
    const ids = [];
    for (let i = 0; i < 11; i++) {
      const admission = await h.tool("guild_start", {role: "reviewer", profile: "general", task: `capacity-${i}`});
      assert.equal(admission.isError, false); ids.push(admission.details.runId);
    }
    assert.equal(launched.length, 3);
    assert.equal(journal(h, "admitted").length, 11);
    assert.equal((await h.tool("guild_start", {role: "reviewer", profile: "general", task: "overflow"})).isError, true);
    assert.equal(journal(h, "admitted").length, 11, "overflow refuses before ledger reservation");
    assert.deepEqual(ids.map(id => h.control.runtime.status(h.control.owner, id).status).sort(), [...Array(8).fill("queued"), ...Array(3).fill("running")]);
    h.state.beforeStream = async request => {
      if (request.kind === "owned") { entered.resolve(request); await bounded(streamRelease.promise, "owned stream release"); }
    };
    h.control.beforeAgent = async event => {
      if (event.messageType !== "custom") { questions.resolve(); await tick(); }
    };
    original = h.prompt("questions behind native busy turn");
    await bounded(original, "ordinary busy turn");
    const owned = await bounded(entered.promise, "actual owned local request");
    assert.equal(h.state.ownedStarts, 1);
    assert.equal(h.state.ownedRequests, 1);
    const receipt = h.control.accepted[0].receipt, lease = h.control.opens[0].lease;
    h.terminal.input("\x1b");
    assert.ok(owned.options.signal.aborted, "Escape aborts actual parent signal");
    assert.ok(launched.every(o => o.signal.aborted));
    assert.equal(launched.length, 3);
    const opens = h.control.opens.length;
    await fresh(h, "early cleanup intent");
    assert.equal(h.control.opens.length, opens);
    assert.equal(journal(h, "terminal").filter(e => launched.some(o => o.runId === e.data.runId)).length, 0, "active slots cannot publish terminal before cleanup");
    assert.equal(launched.length, 3, "cleanup cannot release a slot to queued children");
    cleanup.resolve(); streamRelease.resolve();
    assert.deepEqual(await bounded(receipt.finished, "cancelled actual receipt"), {outcome: "revoked", commitState: "committed", started: true});
    await bounded(lease.closed, "cancelled actual lease closed");
    await bounded(h.session.waitForIdle(), "cancelled owned idle");
    await until(() => journal(h, "terminal").length === 11, "eleven terminal publications");
    assert.equal(launched.length, 3, "queued work never launched");
    assert.ok(journal(h, "terminal").every(e => e.data.report.status === "cancelled"));
    assert.equal(h.state.autoResponses, 0, "aborted AUTO not completed");
    await tick();
    assert.equal(h.control.opens.length, opens, "drain and idle cannot rearm");
    await fresh(h);
    assert.equal(h.control.opens.length, opens + 1, "later fresh input opens after actual cleanup");
    assert.equal(h.control.accepted.length, 1, "replacement adapter has no replay");
    const ordinary = deferred(), ordinaryRelease = deferred();
    try {
      h.control.beforeAgent = async () => {};
      h.state.beforeStream = async request => { if (request.kind === "ordinary") { ordinary.resolve(request); await bounded(ordinaryRelease.promise, "later ordinary release"); } };
      later = h.prompt("later native turn");
      const request = await bounded(ordinary.promise, "later actual request");
      receipt.revoke(); lease.close();
      assert.equal(request.options.signal.aborted, false, "old resources cannot abort later native run");
    } finally { ordinaryRelease.resolve(); if (later) await bounded(later, "later settlement"); }
  } finally {
    questions.resolve(); cleanup.resolve(); streamRelease.resolve();
    try { if (original) await bounded(original, "original settlement"); }
    finally { await h.dispose(); }
  }
}
async function requiredPlan(name, route) {
  const cleanup = deferred(), launched = [];
  const h = await createHarness(name, {runner: async options => {
    launched.push(options); await cleanup.promise; return result(options);
  }});
  try {
    assert.equal(h.control.opens.length, 0, "Plan startup opens no lease");
    assert.equal((await h.tool("guild_start", {role: "reviewer", profile: "general", task: "Plan child busy"})).isError, false);
    await refusePlan(h, launched.map(o => o.signal), route);
    h.terminal.input("\x1b");
    await refusePlan(h, [], route);
    const opens = h.control.opens.length;
    cleanup.resolve();
    await until(() => journal(h, "terminal").length === 1, "Plan child cleanup");
    await bounded(h.session.waitForIdle(), "Plan idle");
    assert.equal(h.control.opens.length, opens);
    await fresh(h);
    await planIdle(h, route);
    log({phase: "plan-idle", case: name, route, childBusyRefusals: 2, idleEntries: 1, exits: 1, freshOnly: true});
  } finally { cleanup.resolve(); await h.dispose(); }
  for (const phase of ["preparing", "accepted", "started", "cleanup-held"]) await terminalPlanPhase(name, phase, route);
}
async function terminalPlanPhase(name, phase, route) {
  const finish = deferred(), entered = deferred(), release = deferred();
  const launched = [];
  const h = await createHarness(name, {runner: async options => {
    launched.push(options); await finish.promise; return result(options);
  }});
  let refusal, receiptResult, endsBeforeOwned;
  try {
    assert.ok("beforeStream" in h.state, "Shared harness beforeStream API required");
    assert.equal((await h.tool("guild_start", {role: "reviewer", profile: "general", task: `terminal Plan ${phase}`})).isError, false);
    h.control.onAccept = record => {
      assert.ok(record.receipt);
      record.receipt.finished.then(value => { receiptResult = value; });
      assert.equal(h.control.runtime.status(h.control.owner, launched[0].runId).status, "cancelled", "child terminal before receipt");
      if (phase === "accepted" && !refusal) {
        // Start synchronously before tryAccept returns; join only outside the callback.
        assert.equal(h.state.preparations, 0);
        assert.equal(h.state.ownedStarts, 0);
        refusal = refusePlan(h, [], route).then(() => undefined, error => error);
        entered.resolve();
      }
    };
    h.control.beforeAgent = async event => {
      if (event.messageType === "custom" && event.message.customType === "pi-parent-continuation") {
        endsBeforeOwned = h.state.ledger.filter(e => e.type === "agent_end").length;
        if (phase === "preparing" || phase === "accepted") { entered.resolve(); await release.promise; }
      } else { finish.resolve(); await tick(); }
    };
    h.control.onSettled = async () => {
      if (phase === "cleanup-held" && h.state.preparations === 1) {
        assert.equal(h.state.autoResponses, 1, "model completed before settlement hold");
        assert.equal(h.state.ledger.filter(e => e.type === "agent_end").length, endsBeforeOwned + 1, "owned agent_end before hold");
        entered.resolve(); await release.promise;
      }
    };
    h.state.beforeStream = async request => {
      if (request.kind === "owned" && phase === "started") { entered.resolve(); await bounded(release.promise, "Plan owned stream release"); }
    };
    await bounded(h.prompt("publish terminal behind native busy turn"), "Plan terminal busy turn");
    await bounded(entered.promise, `Plan ${phase} boundary`);
    assert.equal(receiptResult, undefined, `${phase}: receipt pending before refusal`);
    const refusalError = phase === "accepted"
      ? await bounded(refusal, "accepted Plan refusal")
      : await refusePlan(h, [], route).then(() => undefined, error => error);
    await tick();
    assert.equal(receiptResult, undefined, `${phase}: actual receipt.finished remains pending through held preparation/stream`);
    release.resolve();
    const finished = await bounded(h.control.accepted[0].receipt.finished, "terminal receipt finish");
    assert.deepEqual(finished, {outcome: "completed", commitState: "committed", started: true}, `${phase}: Plan refusal must not revoke the actual receipt`);
    if (refusalError) throw refusalError;
    assert.equal(h.control.accepted.length, 1);
    assert.equal(h.control.opens.length, 1);
    await bounded(h.session.waitForIdle(), "terminal Plan idle");
    assert.equal(h.state.autoResponses, 1);
    assert.equal(h.control.opens.length, 1, "receipt finish and idle cannot rebind");
    log({phase: "plan-boundary", case: name, route, boundary: phase, finished, autoResponses: h.state.autoResponses});
  } finally {
    finish.resolve(); release.resolve();
    try { if (refusal) await bounded(refusal, "Plan refusal settlement"); }
    finally { await h.dispose(); }
  }
}
export async function runPlanCapacityCase(name) {
  if (name === "started-escape-capacity") await capacity();
  else if (name === "fresh-input-only") await freshOnly();
  else if (["required-plan-guild-first", "required-plan-plan-first"].includes(name)) { for (const route of ["sdk", "editor"]) await requiredPlan(name, route); }
  else assert.fail(`Unknown Plan/capacity case: ${name}`);
  log({phase: "observed", case: name});
}
