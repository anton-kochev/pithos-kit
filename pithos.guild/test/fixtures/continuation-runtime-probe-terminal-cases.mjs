import assert from "node:assert/strict";
import {createHarness, deferred, bounded, tick, result, log} from "./continuation-runtime-probe-harness.mjs";

// Qualification list: cleanup fences publication; native busy settlement coalesces;
// notices/status/nested waits never collect; top-level wait credits exactly once.
const history = h => h.session.sessionManager.getEntries();
const notices = h => history(h).filter(e => e.type === "custom_message" && e.customType === "pi-parent-continuation");
const collections = h => history(h).filter(e => e.type === "custom" && e.data?.kind === "collected");
const correlations = h => history(h).filter(e => e.type === "message" && e.message.role === "toolResult" && e.message.details?.guildBackground);
function noCredit(h) {
  assert.equal(collections(h).length, 0);
  assert.equal(correlations(h).length, 0);
  assert.equal(h.session.getSessionStats().tokens.total, 0);
  assert.equal(h.session.getSessionStats().cost, 0);
}
async function terminalCase(name, count, knownUsage) {
  const work = deferred(), cleanup = deferred(), entered = deferred(), release = deferred();
  const launched = [], completed = [], cleaned = [];
  const h = await createHarness(name, {runner: async options => {
    launched.push(options);
    await work.promise;
    const value = {...result(options), status: "completed", activity: "Completed",
      report: {protocol: "guild/2", version: 2, runId: options.runId, taskId: options.taskId,
        role: options.role, profile: options.profile, taskOutcome: "succeeded", compliance: [],
        summary: "Local deterministic report", blockers: [], limitations: ["In-process runner"],
        payload: {scope: ["Probe"], findings: [], verdict: "Approve"}}};
    if (knownUsage) {
      value.usageKnown = true;
      value.usage = {input: 11, output: 17, cacheRead: 23, cacheWrite: 29, cost: 0.8, contextTokens: 80, turns: 1};
      value.providerUsage = {input: 11, output: 17, cacheRead: 23, cacheWrite: 29, totalTokens: 80,
        cost: {input: 0.11, output: 0.17, cacheRead: 0.23, cacheWrite: 0.29, total: 0.8}};
    }
    completed.push(options.runId);
    await cleanup.promise;
    cleaned.push(options.runId);
    return value;
  }});
  let original;
  try {
    for (let i = 0; i < count; i++) assert.equal((await h.tool("guild_start", {role: "reviewer", profile: "general", task: `terminal-${i}`})).isError, false);
    assert.equal(launched.length, count);
    assert.equal(h.control.opens.length, 1, "fresh input opens one actual lease");
    assert.ok(h.control.opens[0].lease);
    work.resolve(); await tick();
    assert.equal(completed.length, count);
    assert.equal(cleaned.length, 0);
    assert.equal(h.control.accepted.length, 0);
    assert.equal(notices(h).length, 0);
    assert.equal(h.state.autoResponses, 0);
    assert.equal(h.state.ownedStarts, 0);
    const published = () => launched.every(o => h.control.runtime.status(h.control.owner, o.runId).status === "completed");
    const delivered = () => {
      assert.equal(cleaned.length, count);
      assert.ok(published(), "canonical terminal publication before delivery");
      assert.equal(history(h).filter(e => e.type === "custom" && e.data?.kind === "terminal").length, count);
    };
    let acceptedCallbacks = 0;
    h.control.onAccept = () => { delivered(); acceptedCallbacks++; };
    h.session.subscribe(event => { if (event.type === "message_start" && event.message.customType === "pi-parent-continuation") delivered(); });
    let preparations = 0;
    h.control.beforeAgent = async event => {
      if (event.messageType === "custom" && event.message.customType === "pi-parent-continuation") { delivered(); preparations++; }
      else { entered.resolve(); await release.promise; }
    };
    original = h.prompt("hold native busy until cleanup and publication");
    await bounded(entered.promise, "native busy");
    cleanup.resolve();
    await bounded((async () => {
      const deadline = performance.now() + 1200;
      while (!published()) {
        assert.ok(performance.now() < deadline, "canonical terminal publication deadline");
        await tick();
      }
    })(), "terminal publication");
    assert.equal(notices(h).length, 0);
    assert.equal(h.control.accepted.length, 0);
    assert.equal(h.state.autoResponses, 0);
    release.resolve(); await bounded(original, "ordinary response");
    await tick(); await bounded(h.session.waitForIdle(), "terminal wake");
    assert.equal(h.control.accepted.length, 1);
    assert.equal(acceptedCallbacks, 1, "actual acceptance observer invoked");
    assert.equal(notices(h).length, 1);
    assert.equal(h.control.accepted[0].content, notices(h)[0].content);
    assert.equal(preparations, 1);
    assert.equal(h.state.preparations, 1, "harness observes actual owned preparation");
    assert.equal(h.state.ownedStarts, 1);
    assert.equal(h.state.autoResponses, 1);
    assert.equal(h.state.observedMessages.filter(m => m.role === "custom" && m.customType === "pi-parent-continuation").length, 1);
    assert.equal(h.state.requests.length, h.state.streamCalls);
    assert.ok(h.state.requests.every(r => Array.isArray(r.context.messages)), "request contexts come from streamSimple");
    const batch = JSON.parse(notices(h)[0].content);
    assert.deepEqual(batch.items.map(x => x.runId).sort(), launched.map(o => o.runId).sort());
    assert.ok(batch.items.every(x => x.kind === "terminal"));
    noCredit(h);
    await tick(); await bounded(h.session.waitForIdle(), "duplicate idle");
    assert.equal(h.state.autoResponses, 1);
    assert.equal(notices(h).length, 1);
    assert.equal(h.control.accepted.length, 1);
    assert.equal(h.state.ownedStarts, 1);
    assert.equal(preparations, 1);
    noCredit(h);
    h.control.beforeAgent = async () => {};
    if (knownUsage) {
      const runId = launched[0].runId;
      assert.equal((await h.tool("guild_status", {runId})).isError, false); noCredit(h);
      const nested = await h.tool("semantic_nested_wait", {runId});
      assert.equal(nested.details.isError, true, "actual nested wait refused"); noCredit(h);
      const first = await h.tool("guild_wait", {runId, timeoutMs: 0});
      assert.equal(first.isError, false);
      assert.equal(h.session.getSessionStats().tokens.total, 80);
      assert.equal(h.session.getSessionStats().cost, 0.8);
      assert.equal(collections(h).length, 1);
      assert.equal(correlations(h).length, 1);
      assert.equal(first.details.guildBackground.runId, runId);
      assert.equal(first.details.guildBackground.taskId, launched[0].taskId);
      assert.equal((await h.tool("guild_wait", {runId, timeoutMs: 0})).isError, false);
      assert.equal(h.session.getSessionStats().tokens.total, 80);
      assert.equal(h.session.getSessionStats().cost, 0.8);
      assert.equal(collections(h).length, 1);
      assert.equal(correlations(h).length, 1);
    }
    log({phase: "observed", case: name, launches: launched.length, cleaned: cleaned.length, notices: notices(h).length, preparations, ownedStarts: h.state.ownedStarts, autoResponses: h.state.autoResponses, tokens: h.session.getSessionStats().tokens.total, cost: h.session.getSessionStats().cost});
  } finally {
    work.resolve(); cleanup.resolve(); release.resolve();
    try { if (original) await bounded(original, "release original"); }
    finally { await h.dispose(); }
  }
}
export const terminalsAfterCleanup = () => terminalCase("terminals-after-cleanup", 3, false);
export const noticeNotCollection = () => terminalCase("notice-not-collection", 1, true);
