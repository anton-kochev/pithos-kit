import assert from "node:assert/strict";
import {createHarness, deferred, bounded, tick, result, log} from "./continuation-runtime-probe-harness.mjs";

// Boundaries under test: accepted, preparing, both committed events, and
// nonjoining native Escape callbacks. Gates are always released by the caller.
const owned = message => message?.customType === "pi-parent-continuation";
const history = h => h.session.sessionManager.getEntries();
const notices = h => history(h).filter(e => e.type === "custom_message" && owned(e));
async function oncePoll(predicate, label) {
  const deadline = performance.now() + 1200;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, `${label}: exceeded 1200ms`);
    await tick();
  }
}

async function interrupt(name, boundary, callbackEscape = false) {
  const questions = deferred(), cleanup = deferred(), preparation = deferred();
  const busy = deferred(), releaseBusy = deferred(), callbackReturned = deferred();
  const launched = [], aborted = [], cleaned = [];
  let returned = false, closedSettled = false, closedAtReturn, elapsed;
  const h = await createHarness(name, {runner: async options => {
    launched.push(options);
    options.signal.addEventListener("abort", () => aborted.push(options.runId), {once: true});
    await questions.promise;
    try { await options.onQuestion(`Interrupt ${options.task}?`, options.signal); }
    catch (error) { if (!options.signal.aborted) throw error; }
    await cleanup.promise;
    cleaned.push(options.runId);
    return result(options);
  }});
  let original, earlyInput;
  try {
    // Four admissions exercise three active children and one never-launched queue entry.
    for (let i = 0; i < 4; i++) {
      assert.equal((await h.tool("guild_start", {role: "reviewer", profile: "general", task: `interrupt-${i}`})).isError, false);
    }
    assert.equal(launched.length, 3);
    assert.equal(h.control.opens.length, 1);
    const lease = h.control.opens[0].lease;
    lease.closed.then(() => { closedSettled = true; });
    const escape = () => {
      const start = performance.now();
      // The terminal callback is the native bound route. Do not await its join
      // from an owned callback: preparation itself is part of that join.
      h.terminal.input("\x1b");
      elapsed = performance.now() - start;
      closedAtReturn = closedSettled;
      returned = true;
      callbackReturned.resolve();
    };
    h.control.onAccept = record => {
      assert.equal(record, h.control.accepted[0]);
      if (boundary === "accepted") escape();
    };
    h.control.beforeAgent = async event => {
      if (event.messageType === "custom" && owned(event.message)) {
        if (boundary === "preparing") {
          if (callbackEscape) escape();
          else busy.resolve();
          await preparation.promise;
        }
      } else {
        questions.resolve();
        await oncePoll(() => launched.every(o => h.control.runtime.status(h.control.owner, o.runId).status === "waiting"), "questions waiting");
        await releaseBusy.promise;
      }
    };
    h.session.subscribe(event => {
      if (event.type === boundary && owned(event.message)) escape();
    });
    const baselineRequests = h.state.requests.length;
    original = h.prompt("hold native busy while children ask questions");
    await oncePoll(() => launched.every(o => h.control.runtime.status(h.control.owner, o.runId).status === "waiting"), "question publication");
    assert.equal(h.control.accepted.length, 0);
    releaseBusy.resolve();
    await bounded(original, "ordinary native turn");
    if (boundary === "preparing" && !callbackEscape) {
      await bounded(busy.promise, "owned preparation entered");
      escape();
    }
    await bounded(callbackReturned.promise, "native callback return");
    assert.equal(returned, true);
    assert.ok(elapsed < 1500, "native Escape returns without joining owned cleanup");
    assert.equal(closedAtReturn, false, "closed observer is pending at callback return");
    assert.equal(aborted.length, 3, "native interrupt synchronously aborts every active child");
    assert.equal(cleaned.length, 0, "child cleanup remains externally held");
    assert.equal(h.control.accepted.length, 1);
    const receipt = h.control.accepted[0].receipt;
    if (boundary === "preparing") {
      await tick();
      assert.equal(closedSettled, false, "closed joins held preparation rather than force-cancelling the hook");
    }
    assert.equal(h.state.ownedStarts, 0, "no owned agent_start before fresh input");
    h.control.beforeAgent = async () => {};
    earlyInput = h.prompt("fresh input while interrupted child cleanup is held");
    await tick();
    assert.equal(h.control.opens.length, 1, "input during cleanup cannot rearm delivery");
    // Duplicate operations act on the actual captured resources, not synthetic receipts.
    receipt.revoke(); receipt.revoke(); lease.close(); lease.close();
    preparation.resolve(); cleanup.resolve();
    const finish = await bounded(receipt.finished, "actual receipt finished");
    await bounded(lease.closed, "actual lease closed");
    await bounded(earlyInput, "early ordinary input");
    await oncePoll(() => cleaned.length === 3, "child cleanup");
    await bounded(h.session.waitForIdle(), "native idle after interrupt");
    const committed = boundary.startsWith("message_") ? "committed" : "none";
    assert.deepEqual(finish, {outcome: "revoked", commitState: committed, started: false});
    assert.equal(await bounded(receipt.committed, "receipt committed"), committed);
    assert.equal(await bounded(receipt.started, "receipt started"), false);
    const expectedNotices = committed === "committed" ? 1 : 0;
    const check = (afterFreshInput = false) => {
      assert.equal(notices(h).length, expectedNotices, "committed historical notices are never rolled back");
      assert.equal(h.state.preparations, boundary === "accepted" ? 0 : 1);
      // The harness pending-notice heuristic also counts a later ordinary
      // agent_start after a cancelled committed notice. Receipt.started and
      // exact request counts distinguish that fresh turn from an owned run.
      if (!afterFreshInput && !expectedNotices) assert.equal(h.state.ownedStarts, 0, "no owned agent_start");
      assert.equal(h.state.autoResponses, 0, "no owned transport AUTO");
      assert.equal(h.control.accepted.length, 1);
      assert.equal(launched.length, 3, "queued child never launches");
      assert.equal(h.session.getSessionStats().tokens.total, 0);
      assert.equal(h.session.getSessionStats().cost, 0);
      assert.equal(history(h).filter(e => e.type === "custom" && e.data?.kind === "collected").length, 0);
    };
    check();
    assert.equal(h.state.requests.length - baselineRequests, 2, "only the two ordinary turns reached transport");
    await tick(); await bounded(h.session.waitForIdle(), "second idle");
    check();
    assert.equal(h.control.opens.length, 1, "idle cannot rearm delivery");
    if (expectedNotices) {
      h.control.beforeAgent = async () => {};
      await bounded(h.prompt("fresh safe input after drained interrupt"), "fresh input");
      await bounded(h.session.waitForIdle(), "fresh idle");
      assert.equal(h.control.opens.length, 2, "fresh input opens an empty replacement");
      check(true);
      assert.equal(await receipt.started, false);
      assert.equal(h.state.requests.length - baselineRequests, 3, "fresh input adds only its ordinary request");
    }
    log({phase: "observed", case: name, boundary, callbackEscape, callbackReturned: returned,
      closedAtReturn, elapsed, launches: launched.length, aborted: aborted.length, cleaned: cleaned.length,
      finish, notices: notices(h).length, preparations: h.state.preparations,
      ownedStarted: await receipt.started, harnessStartCount: h.state.ownedStarts, autoResponses: h.state.autoResponses});
  } finally {
    questions.resolve(); cleanup.resolve(); preparation.resolve(); releaseBusy.resolve();
    try {
      if (original) await bounded(original, "release original");
      if (earlyInput) await bounded(earlyInput, "release early input");
    }
    finally { await h.dispose(); }
  }
}

export async function runInterruptCase(name) {
  if (name === "accepted-escape") return interrupt(name, "accepted");
  if (name === "preparing-escape") return interrupt(name, "preparing");
  if (name === "committed-message-start") return interrupt(name, "message_start");
  if (name === "committed-message-end") return interrupt(name, "message_end");
  if (name === "nonjoining-close") {
    await interrupt(name, "preparing", true);
    await interrupt(name, "message_start", true);
    return;
  }
  throw new Error(`Unknown interrupt case: ${name}`);
}
