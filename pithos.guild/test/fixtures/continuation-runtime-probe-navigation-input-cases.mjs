import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import {createHarness, deferred, bounded, tick, result, log} from "./continuation-runtime-probe-harness.mjs";

// Test list: finite transport gates; shutdown/reload fence held preparation and
// child cleanup; reload replaces public controls without opening delivery;
// foreign delivery and real sibling navigation remain explicit pending cases.
async function shutdownHeldWake() {
  const questions = deferred(), cleanup = deferred(), preparing = deferred(), release = deferred();
  const launches = [];
  const h = await createHarness("shutdown-held-wake", {runner: async options => {
    launches.push(options); await questions.promise;
    try { await options.onQuestion("shutdown question", options.signal); }
    finally { await cleanup.promise; }
    return result(options);
  }});
  let disposing;
  try {
    assert.equal(typeof h.state.beforeStream, "function", "finite public transport gate exists");
    let gates = 0;
    h.state.beforeStream = async ({kind, context, options, message}) => {
      assert.ok(["tool", "final", "ordinary", "owned"].includes(kind));
      assert.ok(Array.isArray(context.messages)); assert.ok(options.signal);
      assert.equal(message.role, "assistant"); gates++;
    };
    assert.equal((await h.tool("guild_start", {role: "reviewer", profile: "general", task: "shutdown child"})).isError, false);
    assert.equal(gates, 2);
    const old = h.control, context = old.opens[0].context;
    old.beforeAgent = async event => {
      if (event.messageType === "custom" && event.message.customType === "pi-parent-continuation") {
        preparing.resolve(); await release.promise;
      }
    };
    questions.resolve(); await bounded(preparing.promise, "owned preparation");
    let callbacks = 0, finished = false;
    old.onShutdown = () => {
      callbacks++;
      assert.equal(context.parentContinuation.open({}), undefined, "old facade closed before shutdown callouts");
      assert.equal(launches[0].signal.aborted, true, "children aborted before shutdown callouts");
    };
    disposing = h.runtime.dispose().then(() => { finished = true; });
    await tick();
    assert.equal(callbacks, 1); assert.equal(finished, false, "cleanup joins actual disposal");
    assert.equal(h.state.notices.length, 0); assert.equal(h.state.ownedStarts, 0);
    release.resolve(); await tick(); assert.equal(finished, false, "child cleanup still held");
    cleanup.resolve(); await bounded(disposing, "shutdown join");
    assert.equal(context.parentContinuation.open({}), undefined);
    assert.equal(h.state.ownedRequests, 0); assert.equal(h.state.autoResponses, 0);
    assert.equal(h.state.notices.length, 0); assert.equal(launches.length, 1);
    await tick(); assert.equal(h.state.ownedStarts, 0);
    log({phase: "observed", case: "shutdown-held-wake", callbacks, launches: launches.length, preparations: h.state.preparations, ownedRequests: h.state.ownedRequests});
  } finally {
    questions.resolve(); release.resolve(); cleanup.resolve();
    try { if (disposing) await bounded(disposing, "dispose finally"); }
    finally { await h.dispose(); }
  }
}
// Native busy reload vetoes UI reset, but the runtime fences authority first.
// Accepted-before-dispatch reload instead retires semantic UI and joins cleanup.
async function reloadHeldWake() {
  for (const phase of ["preparing-veto", "accepted-before-dispatch"]) {
    const questions = deferred(), cleanup = deferred(), preparing = deferred(), release = deferred();
    const shutdown = deferred(), accepted = deferred(), cleanupEntered = deferred();
    const launches = [], cleaned = [], ordering = [];
    let operation, failure, finished = false, callbacks = 0, old, context, outgoing, leaf;
    const terminal = () => outgoing.getEntries().find(e => e.type === "custom" && e.data?.kind === "terminal" && e.data.runId === launches[0].runId);
    const h = await createHarness("reload-held-wake", {
      beforeReload: () => {
        assert.ok(terminal(), "canonical outgoing terminal published before replacement loader");
        assert.equal(cleaned.length, 1);
        ordering.push("terminal-before-loader");
      },
      onReloadStart: control => {
        assert.ok(terminal(), "outgoing terminal precedes actual replacement session_start");
        assert.equal(control.opens.length, 0);
        ordering.push("replacement-session-start");
      },
      runner: async options => {
        launches.push(options); await questions.promise;
        try { await options.onQuestion("reload question", options.signal); }
        finally { cleanupEntered.resolve(); await cleanup.promise; cleaned.push(options.runId); }
        return result(options);
      },
    });
    const noWake = () => {
      assert.equal(h.state.notices.length, 0); assert.equal(h.state.ownedStarts, 0);
      assert.equal(h.state.ownedRequests, 0); assert.equal(h.state.autoResponses, 0);
    };
    const startReload = () => {
      operation = h.session.prompt("/semantic-probe-reload");
      operation.then(() => { finished = true; }, () => {});
    };
    try {
      assert.equal((await h.tool("guild_start", {role: "reviewer", profile: "general", task: "reload child"})).isError, false);
      old = h.control; context = old.opens[0].context;
      const session = h.session;
      outgoing = session.sessionManager; leaf = outgoing.getLeafId();
      const branch = outgoing.getBranch(), sessionId = outgoing.getSessionId();
      old.onShutdown = () => {
        callbacks++;
        assert.equal(context.parentContinuation.open({}), undefined, "old facade stale before Guild shutdown");
        assert.equal(launches[0].signal.aborted, true, "semantic reset cancels child before Guild shutdown");
        assert.equal(h.state.preparations, 0); noWake();
        shutdown.resolve();
      };
      if (phase === "preparing-veto") {
        old.beforeAgent = async event => {
          if (event.messageType === "custom" && event.message.customType === "pi-parent-continuation") {
            preparing.resolve(); await release.promise;
          }
        };
        questions.resolve(); await bounded(preparing.promise, "reload preparation");
        const offset = h.terminal.output.length;
        startReload();
        await bounded(operation, "veto command return");
        await bounded((async () => {
          const deadline = performance.now() + 1200;
          while (!stripVTControlCharacters(h.terminal.output.slice(offset)).includes("Wait for the current response to finish before reloading.")) {
            assert.ok(performance.now() < deadline, "fresh native reload warning deadline");
            await tick();
          }
        })(), "fresh native reload warning");
        assert.equal(callbacks, 0); assert.equal(old.shutdowns, 0);
        assert.equal(launches[0].signal.aborted, false, "veto must not reset semantic UI");
        assert.equal(h.session, session); assert.equal(h.control, old); assert.equal(h.controls.length, 1);
        assert.equal(outgoing.getSessionId(), sessionId); assert.equal(outgoing.getLeafId(), leaf);
        assert.deepEqual(outgoing.getBranch(), branch);
        assert.equal(context.parentContinuation.open({}), undefined, "veto still fences old authority");
        release.resolve();
      } else {
        old.onAccept = record => {
          assert.equal(record, old.accepted[0]);
          assert.equal(h.session.isStreaming, false); assert.equal(h.session.isCompacting, false);
          assert.equal(h.state.preparations, 0, "accepted-before-dispatch reload must precede owned preparation");
          startReload(); // No extra microtask: enter Mode before dispatch can begin.
          accepted.resolve(record);
        };
        questions.resolve(); await bounded(accepted.promise, "actual acceptance");
        await bounded(shutdown.promise, "accepted reload shutdown");
        await bounded(cleanupEntered.promise, "child cleanup entered");
        assert.equal(callbacks, 1); assert.equal(finished, false);
        assert.equal(h.control, old); assert.equal(h.controls.length, 1);
        assert.equal(outgoing.getLeafId(), leaf); assert.equal(terminal(), undefined);
        assert.equal(cleaned.length, 0); noWake();
      }
      const settled = await bounded(old.accepted[0].receipt.finished, "reload receipt finished");
      assert.deepEqual({outcome: settled.outcome, commitState: settled.commitState, started: settled.started},
        {outcome: "revoked", commitState: "none", started: false});
      await bounded(old.opens[0].lease.closed, "reload lease closed");
      if (phase === "preparing-veto") {
        await bounded(h.session.waitForIdle(), "veto idle"); await tick();
        assert.equal(launches[0].signal.aborted, false, "child remains alive until separate disposal");
        assert.equal(old.opens.length, 1); assert.equal(old.accepted.length, 1); noWake();
      } else {
        assert.equal(finished, false, "cleanup holds actual reload after receipt revocation");
        cleanup.resolve(); await bounded(operation, "accepted reload completion");
        assert.deepEqual(ordering, ["terminal-before-loader", "replacement-session-start"]);
        assert.equal(terminal().parentId, leaf, "terminal belongs to outgoing journal leaf");
        assert.notEqual(h.control, old); assert.equal(h.controls.length, 2);
        const replacement = h.control;
        assert.equal(replacement.starts, 1);
        assert.equal(context.parentContinuation.open({}), undefined);
        assert.equal(replacement.opens.length, 0, "startup grants no delivery"); noWake();
        await h.prompt("fresh input after actual reload");
        assert.equal(replacement.opens.length, 1); assert.equal(replacement.accepted.length, 0);
        const replacementContext = replacement.opens[0].context;
        replacement.onShutdown = () => {
          assert.equal(replacementContext.parentContinuation.open({}), undefined);
          assert.equal(context.parentContinuation.open({}), undefined);
        };
        startReload(); await bounded(operation, "repeat reload");
        assert.equal(h.controls.length, 3); assert.notEqual(h.control, replacement);
        assert.deepEqual(ordering, ["terminal-before-loader", "replacement-session-start", "terminal-before-loader", "replacement-session-start"]);
        assert.equal(outgoing.getEntries().filter(e => e.type === "custom" && e.data?.kind === "terminal" && e.data.runId === launches[0].runId).length, 1);
        assert.equal(h.control.starts, 1); assert.equal(h.control.opens.length, 0);
        assert.equal(context.parentContinuation.open({}), undefined);
        assert.equal(replacementContext.parentContinuation.open({}), undefined);
        await h.prompt("fresh input after second reload");
        assert.equal(h.control.opens.length, 1); assert.equal(h.control.accepted.length, 0);
        assert.equal(launches.length, 1); assert.equal(cleaned.length, 1);
        assert.equal(h.state.preparations, 0); noWake();
      }
      log({phase: "observed", case: "reload-held-wake", subcase: phase, settled, controls: h.controls.length, callbacks,
        childAborted: launches[0].signal.aborted, preparations: h.state.preparations, ordering, ownedRequests: h.state.ownedRequests});
    } catch (error) {
      failure = error; log({phase: "reload-diagnostic", subcase: phase, error: String(error)}); throw error;
    } finally {
      questions.resolve(); release.resolve(); cleanup.resolve();
      try {
        try { if (operation) await bounded(operation, "reload finally"); }
        finally { await h.dispose(); }
      } catch (error) {
        h.mode.stop(); log({phase: "reload-cleanup-diagnostic", error: String(error)});
        if (!failure) throw error;
      }
    }
  }
}
export async function runNavigationInputCase(name) {
  if (name === "reload-held-wake") return reloadHeldWake();
  if (name === "shutdown-held-wake") return shutdownHeldWake();
  const {runForeignTreeCase} = await import("./continuation-runtime-probe-foreign-tree-cases.mjs");
  return runForeignTreeCase(name);
}
