import assert from "node:assert/strict";
import {createHarness, deferred, bounded, tick, result, log} from "./continuation-runtime-probe-harness.mjs";

// Test list: passive extras; text/custom preemption and same-lease retry;
// genuine streaming custom queues; streaming tree veto; accepted-before-dispatch
// tree transition with held cleanup, outgoing attribution and legacy recovery.
const owned = e => e.messageType === "custom" && e.message.customType === "pi-parent-continuation";
const foreign = token => ({customType: "foreign-probe", content: token, display: false});
const entries = h => h.session.sessionManager.getEntries();
async function fixture(name) {
  const question = deferred(), cleanup = deferred(), preparing = deferred(), release = deferred();
  const launches = [], cleaned = [];
  const h = await createHarness(name, {runner: async options => {
    launches.push(options); await question.promise;
    try { await options.onQuestion("foreign/tree question", options.signal); }
    finally { await cleanup.promise; cleaned.push(options.runId); }
    return result(options);
  }});
  h.control.beforeAgent = async event => {
    if (owned(event)) { preparing.resolve(); await release.promise; }
  };
  return {h, question, cleanup, preparing, release, launches, cleaned};
}
async function finish(f, operation, failure) {
  f.question.resolve(); f.release.resolve(); f.cleanup.resolve();
  try {
    try {
      if (operation) await bounded(operation, "foreign/tree operation cleanup");
    } finally {
      await f.h.dispose();
    }
  } catch (error) {
    f.h.mode.stop();
    log({phase: "foreign-tree-cleanup", error: String(error)});
    if (!failure) throw error;
  }
}
function noOwned(h) {
  assert.equal(h.state.notices.length, 0);
  assert.equal(h.state.ownedStarts, 0);
  assert.equal(h.state.ownedRequests, 0);
  assert.equal(h.state.autoResponses, 0);
}
function expectedRequests(h, kinds) {
  assert.deepEqual(h.state.requests.map(r => r.kind), kinds);
  assert.deepEqual(h.state.ledger.filter(e => e.type === "native_settlement").map(e => e.reason),
    kinds.map(kind => kind === "tool" ? "toolUse" : "stop"));
}
function logLedger(h, scenario) {
  log({phase: "native-ledger", scenario, ledger: h.state.ledger.map(e => ({type: e.type,
    ...(e.request ? {request: h.state.requests.indexOf(e.request), kind: e.request.kind, reason: e.reason} : {}),
    ...(e.record ? {sequence: e.record.sequence, settled: e.settled} : {}),
    ...(e.event?.message ? {role: e.event.message.role, customType: e.event.message.customType} : {})}))});
}
async function foreignStage(preempt) {
  const f = await fixture("foreign-delivery"), {h} = f;
  let operation, failure;
  try {
    await h.tool("guild_start", {role: "reviewer", profile: "general", task: "foreign child"});
    const lease = h.control.opens[0].lease;
    let closed = false;
    lease.closed.then(() => { closed = true; });
    await h.session.sendCustomMessage(foreign("prior-next"), {deliverAs: "nextTurn"});
    await h.session.sendCustomMessage(foreign("prior-passive"), {triggerTurn: false});
    assert.equal(h.control.accepted.length, 0, "passive context is not runnable input");
    f.question.resolve(); await bounded(f.preparing.promise, "foreign owned preparation");
    await h.session.sendCustomMessage(foreign("hook-next"), {deliverAs: "nextTurn"});
    await h.session.sendCustomMessage(foreign("hook-passive"), {triggerTurn: false});
    const receipt = h.control.accepted[0].receipt;
    if (preempt) {
      h.state.beforeStream = async ({kind}) => { if (kind === "ordinary") noOwned(h); };
      if (preempt === "text") operation = h.prompt("native priority input");
      else {
        h.planOrdinary({label: preempt + " preemption", count: 1,
          matches: context => JSON.stringify(context.messages).includes("native custom " + preempt)});
        operation = h.session.sendCustomMessage(foreign("native custom " + preempt), {deliverAs: preempt, triggerTurn: true});
      }
      operation.catch(() => {});
      await tick();
    }
    f.release.resolve();
    if (operation) await bounded(operation, "native priority completion");
    const settled = await bounded(receipt.finished, "foreign receipt");
    await bounded(h.session.waitForIdle(), "foreign idle");
    if (preempt) {
      assert.equal(settled.commitState, "none"); assert.equal(settled.started, false);
      assert.equal(settled.outcome, "revoked");
      assert.equal(closed, false, "native input preserves lease");
      const accepted = h.control.accepted;
      assert.equal(accepted.length, 2, "new idle edge retries the released batch once");
      assert.notEqual(accepted[0].sequence, accepted[1].sequence);
      assert.notEqual(accepted[0].receipt, accepted[1].receipt);
      assert.equal(accepted[0].lease, lease);
      assert.equal(accepted[1].lease, lease);
      assert.deepEqual(await bounded(accepted[1].receipt.finished, "retry receipt"),
        {outcome: "completed", commitState: "committed", started: true});
      assert.equal(h.state.notices.length, 1); assert.equal(h.state.ownedStarts, 1);
      assert.equal(h.state.ownedRequests, 1); assert.equal(h.state.autoResponses, 1);
      const ledger = h.state.ledger;
      const native = h.state.requests.find(r => r.kind === "ordinary");
      assert.ok(native);
      const settlement = ledger.findIndex(e => e.type === "native_settlement" && e.request === native);
      const retry = ledger.findIndex(e => e.type === "accepted" && e.record === accepted[1]);
      assert.ok(settlement >= 0 && settlement < retry, "native settlement precedes retry acceptance");
      assert.ok(ledger.slice(settlement + 1, retry).some(e => e.type === "agent_end"),
        "actual native agent end precedes retry acceptance");
      await tick(); await bounded(h.session.waitForIdle(), "repeat idle");
      assert.equal(accepted.length, 2); assert.equal(h.state.autoResponses, 1);
      assert.equal(h.control.opens.length, 1);
      h.assertOrdinaryPlansConsumed();
    } else {
      assert.equal(settled.commitState, "committed"); assert.equal(settled.started, true);
      assert.equal(h.state.notices.length, 1); assert.equal(h.state.ownedRequests, 1);
    }
    const tokens = ["prior-next", "prior-passive", "hook-next", "hook-passive"];
    if (preempt && preempt !== "text") tokens.push("native custom " + preempt);
    for (const token of tokens) {
      assert.equal(entries(h).filter(e => e.type === "custom_message" && e.content === token).length, 1, `${token} persisted once`);
      assert.equal(h.state.observedMessages.filter(m => m.customType === "foreign-probe" && m.content === token).length, 1, `${token} emitted once`);
      const last = h.state.requests.find(r => r.kind === (preempt ? "ordinary" : "owned")).context.messages;
      assert.equal(JSON.stringify(last).split(token).length - 1, 1, `${token} in actual intended request once`);
    }
    expectedRequests(h, preempt ? ["tool", "final", "ordinary", "owned"] : ["tool", "final", "owned"]);
    logLedger(h, preempt || "passive");
    log({phase: "foreign-stage", preempt, settled, requests: h.state.streamCalls});
  } catch (error) {
    failure = error;
    log({phase: "foreign-diagnostic", preempt, error: String(error), stack: error.stack,
      notices: h.state.notices.length, starts: h.state.ownedStarts, requests: h.state.ownedRequests});
    throw error;
  }
  finally { await finish(f, operation, failure); }
}
// A separate fresh harness exercises genuine queues, not an owned preparation.
async function customStreaming(route) {
  const h = await createHarness("foreign-stream-" + route);
  const entered = deferred(), release = deferred();
  let operation;
  try {
    const seed = "stream seed " + route, token = "queued custom " + route;
    h.state.beforeStream = async ({kind, context}) => {
      assert.equal(kind, "ordinary");
      if (!JSON.stringify(context.messages).includes(token)) {
        entered.resolve(); await release.promise;
      }
    };
    operation = h.prompt(seed); operation.catch(() => {});
    await bounded(entered.promise, "real native stream held");
    assert.equal(h.session.isStreaming, true);
    h.planOrdinary({label: route, count: 1, matches: context => JSON.stringify(context.messages).includes(token)});
    await h.session.sendCustomMessage(foreign(token), {deliverAs: route, triggerTurn: true});
    release.resolve(); await bounded(operation, "stream queue completion");
    await bounded(h.session.waitForIdle(), "stream queue idle");
    h.assertOrdinaryPlansConsumed();
    assert.equal(h.state.requests.length, 2);
    assert.equal(JSON.stringify(h.state.requests[1].context.messages).split(token).length - 1, 1);
    assert.equal(entries(h).filter(e => e.type === "custom_message" && e.content === token).length, 1);
    assert.equal(h.state.observedMessages.filter(m => m.customType === "foreign-probe" && m.content === token).length, 1);
    assert.equal(h.control.accepted.length, 0); noOwned(h);
    expectedRequests(h, ["ordinary", "ordinary"]); logLedger(h, "stream-" + route);
  } finally {
    release.resolve();
    try { if (operation) await bounded(operation, "stream cleanup"); }
    finally { await h.dispose(); }
  }
}
function unknownCollection(h, collected, runId) {
  assert.equal(collected.usage, undefined);
  const admitted = entries(h).find(e => e.type === "custom" && e.data?.kind === "admitted" && e.data.runId === runId);
  const receipts = entries(h).filter(e => e.type === "custom" && e.data?.kind === "collected" && e.data.runId === runId);
  assert.equal(receipts.length, 1);
  const correlation = collected.details.guildBackground;
  assert.equal(typeof correlation.collectionId, "string"); assert.ok(correlation.collectionId.length > 0);
  assert.deepEqual(correlation, {version: 1, sessionId: h.session.sessionManager.getSessionId(), runId,
    taskId: admitted.data.taskId, collectionId: correlation.collectionId});
  assert.deepEqual(receipts[0].data, {...admitted.data, kind: "collected", originEntryId: admitted.id,
    collectionId: correlation.collectionId, toolCallId: collected.toolCallId, native: "unavailable"});
}
async function treeVeto() {
  const f = await fixture("tree-veto"), {h} = f;
  let failure;
  try {
    const manager = h.session.sessionManager;
    const target = manager.appendMessage({role: "user", content: "veto target", timestamp: Date.now()});
    await h.tool("guild_start", {role: "reviewer", profile: "general", task: "veto child"});
    const leaf = manager.getLeafId(), old = h.control, {context} = old.opens[0];
    let beforeTree = 0;
    old.onBeforeTree = () => { beforeTree++; };
    f.question.resolve(); await bounded(f.preparing.promise, "veto preparation");
    assert.equal(h.session.isStreaming, true);
    await assert.rejects(h.session.navigateTree(target, {summarize: false}), /Wait for the current response/);
    assert.equal(beforeTree, 0); assert.equal(manager.getLeafId(), leaf);
    assert.equal(f.launches[0].signal.aborted, false); assert.equal(f.cleaned.length, 0);
    assert.equal(context.parentContinuation.open({}), undefined);
    f.release.resolve();
    assert.deepEqual(await bounded(old.accepted[0].receipt.finished, "veto receipt"),
      {outcome: "revoked", commitState: "none", started: false});
    await bounded(h.session.waitForIdle(), "veto idle"); await tick();
    assert.equal(old.accepted.length, 1); noOwned(h);
    assert.equal(context.parentContinuation.open({}), undefined);
  } catch (error) { failure = error; throw error; }
  finally { await finish(f, undefined, failure); }
}
async function treeHeldWake() {
  const f = await fixture("tree-held-wake"), {h} = f;
  let operation, failure, receiptFinished = false, leaseClosed = false;
  try {
    const manager = h.session.sessionManager;
    const root = manager.appendMessage({role: "user", content: "root", timestamp: Date.now()});
    const siblingParent = manager.appendCustomEntry("sibling-anchor", {});
    const sibling = manager.appendMessage({role: "user", content: "sibling", timestamp: Date.now()});
    manager.branch(root);
    manager.appendMessage({role: "user", content: "origin", timestamp: Date.now()});
    const admitted = await h.tool("guild_start", {role: "reviewer", profile: "general", task: "tree child"});
    const runId = admitted.details.runId, leaf = manager.getLeafId();
    const old = h.control, {context, lease} = old.opens[0], activations = old.activations;
    const accepted = deferred(), beforeTree = deferred();
    let completed = false, receipt;
    old.onBeforeTree = (event, ctx) => {
      assert.equal(event.type, "session_before_tree");
      assert.equal(event.preparation.targetId, sibling);
      assert.ok(ctx);
      assert.equal(context.parentContinuation.open({}), undefined, "fenced before public before_tree");
      beforeTree.resolve();
    };
    old.onAccept = record => {
      receipt = record.receipt;
      assert.equal(h.session.isStreaming, false, "accepted before dispatch");
      receipt.finished.then(() => { receiptFinished = true; });
      lease.closed.then(() => { leaseClosed = true; });
      operation = h.session.navigateTree(sibling, {summarize: false}).then(value => {
        assert.ok(entries(h).some(e => e.type === "custom" && e.data?.kind === "terminal" && e.data.runId === runId), "publication precedes navigation completion");
        completed = true; return value;
      });
      operation.catch(() => {});
      assert.equal(context.parentContinuation.open({}), undefined, "transition fences old facade synchronously");
      accepted.resolve();
    };
    f.question.resolve(); await bounded(accepted.promise, "tree acceptance");
    await bounded(beforeTree.promise, "public before_tree observer");
    await tick(); assert.equal(f.launches[0].signal.aborted, true, "actual tree transition aborts child before cleanup release");
    assert.equal(completed, false); assert.equal(manager.getLeafId(), leaf); noOwned(h);
    assert.equal(f.cleaned.length, 0);
    f.release.resolve(); await tick(); assert.equal(completed, false, "child cleanup holds navigation");
    f.cleanup.resolve();
    assert.equal((await bounded(operation, "tree navigation completion")).cancelled, false);
    assert.equal(manager.getLeafId(), siblingParent, "user target selects its parent");
    const settled = await bounded(receipt.finished, "tree receipt");
    assert.equal(settled.commitState, "none"); assert.equal(settled.started, false);
    await bounded(lease.closed, "tree lease closed");
    await bounded(h.session.waitForIdle(), "tree idle"); noOwned(h);
    assert.equal(old.activations, activations); assert.equal(old.opens.length, 1);
    assert.equal(old.runtime.isCurrent(old.owner), false);
    const terminal = entries(h).find(e => e.type === "custom" && e.data?.kind === "terminal" && e.data.runId === runId);
    assert.equal(terminal.parentId, leaf, "outgoing journal attribution");
    f.launches[0].onUpdate?.({output: "stale-branch-update"}); await tick();
    assert.doesNotMatch(h.terminal.output, /stale-branch-update/);
    await h.prompt("fresh sibling intent");
    assert.equal(old.opens.length, 2); assert.equal(old.accepted.length, 1, "fresh adapter has no replay");
    assert.deepEqual((await h.tool("guild_status", {})).details.runs, []);
    assert.equal((await bounded(h.session.navigateTree(terminal.id, {summarize: false}), "origin return")).cancelled, false);
    await bounded(h.session.waitForIdle(), "origin idle"); assert.equal(old.opens.length, 2);
    await h.prompt("fresh origin intent");
    assert.equal((await h.tool("guild_status", {})).details.runs[0].runId, runId);
    const collected = await h.tool("guild_wait", {runId, timeoutMs: 0});
    assert.equal(collected.isError, false); unknownCollection(h, collected, runId);
    const repeat = await h.tool("guild_wait", {runId, timeoutMs: 0});
    assert.equal(repeat.usage, undefined); assert.equal(repeat.details.guildBackground, undefined);
    unknownCollection(h, collected, runId);
    assert.equal(context.parentContinuation.open({}), undefined); noOwned(h);
    assert.equal(old.accepted.length, 1);
    logLedger(h, "tree-accepted");
  } catch (error) {
    failure = error;
    log({phase: "tree-diagnostic", error: String(error), cleaned: f.cleaned.length, receiptFinished, leaseClosed,
      notices: h.state.notices.length, starts: h.state.ownedStarts, requests: h.state.ownedRequests});
    throw error;
  } finally { await finish(f, operation, failure); }
}
export async function runForeignTreeCase(name) {
  if (name === "tree-held-wake") { await treeVeto(); return treeHeldWake(); }
  assert.equal(name, "foreign-delivery");
  await customStreaming("steer");
  await customStreaming("followUp");
  await foreignStage(false);
  for (const route of ["text", "steer", "followUp"]) await foreignStage(route);
}
