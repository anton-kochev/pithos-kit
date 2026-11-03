import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { describe, it } from "node:test";
import { ConcurrentRunQueue } from "../src/concurrent-run-queue.ts";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("ConcurrentRunQueue", () => {
  it("opts exclusive backlog out of the bound while retaining eight background waiters and FIFO barriers", async (t) => {
    const queue = new ConcurrentRunQueue({ unboundedExclusivePending: true });
    const exclusiveGate = deferred();
    const backgroundGate = deferred();
    const started: string[] = [];
    const runs: Promise<unknown>[] = [];
    let active = 0;
    let exclusiveMaximum = 0;
    let backgroundMaximum = 0;
    t.after(async () => {
      exclusiveGate.resolve(); backgroundGate.resolve();
      await queue.shutdown();
      await Promise.allSettled(runs);
    });
    for (let i = 0; i < 12; i++) {
      runs.push(queue.enqueue(async () => {
        started.push(`exclusive-${i}`);
        exclusiveMaximum = Math.max(exclusiveMaximum, ++active);
        try { await exclusiveGate.promise; } finally { active--; }
      }, { exclusive: true }));
    }
    const exclusiveResults = Promise.allSettled(runs);
    const cancelled = new AbortController();
    const background = (name: string) => async () => {
      started.push(name);
      backgroundMaximum = Math.max(backgroundMaximum, ++active);
      try { await backgroundGate.promise; } finally { active--; }
    };
    let reentrantOverflow!: Promise<void>;
    for (let i = 0; i < 8; i++) {
      runs.push(queue.enqueue(background(`background-${i}`), {
        signal: i === 0 ? cancelled.signal : undefined,
        onPhase: phase => {
          if (i === 7 && phase === "queued") {
            reentrantOverflow = assert.rejects(queue.enqueue(() => assert.fail("reentrant overflow launched")), /capacity/i);
          }
        },
      }));
    }
    const backgroundResults = Promise.allSettled(runs.slice(12));
    // Rejection observers are attached before yielding, including during a red run.
    await assert.rejects(queue.enqueue(() => assert.fail("overflow launched")), /capacity/i);
    assert.ok(reentrantOverflow, "all eight background waiters were admitted");
    await reentrantOverflow;
    assert.deepEqual(started, ["exclusive-0"]);
    cancelled.abort(new Error("cancel pending background"));
    runs.push(queue.enqueue(background("replacement")));
    exclusiveGate.resolve();
    const outcomes = await exclusiveResults;
    assert.ok(outcomes.every(result => result.status === "fulfilled"), "exclusive backlog must not overflow");
    assert.deepEqual(started, [
      ...Array.from({ length: 12 }, (_, i) => `exclusive-${i}`),
      "background-1", "background-2", "background-3",
    ]);
    assert.equal(exclusiveMaximum, 1);
    backgroundGate.resolve();
    const results = await backgroundResults;
    assert.equal(results[0].status, "rejected");
    assert.ok(results.slice(1).every(result => result.status === "fulfilled"));
    await runs.at(-1);
    assert.deepEqual(started.slice(12), [...Array.from({ length: 7 }, (_, i) => `background-${i + 1}`), "replacement"]);
    assert.equal(backgroundMaximum, 3);
  });

  it("validates constructor limits and supports zero pending capacity", async () => {
    for (const concurrency of [0, -1, 1.5, Infinity, NaN]) {
      assert.throws(() => new ConcurrentRunQueue({ concurrency }), /concurrency/i);
    }
    for (const pendingCapacity of [-1, 0.5, Infinity, NaN]) {
      assert.throws(() => new ConcurrentRunQueue({ pendingCapacity }), /pendingCapacity/i);
    }
    const queue = new ConcurrentRunQueue({ concurrency: 1, pendingCapacity: 0 });
    const release = deferred();
    const first = queue.enqueue(() => release.promise);
    await assert.rejects(queue.enqueue(() => undefined), /capacity/i);
    release.resolve();
    await first;
  });
  it("isolates cancellation, never launches cancelled pending work, and holds slots through cleanup", async () => {
    const queue = new ConcurrentRunQueue({ concurrency: 2, pendingCapacity: 1 });
    const cancelled = new AbortController();
    const queued = new AbortController();
    const reason = new Error("cancel request");
    const releases = [deferred(), deferred()];
    const signals: AbortSignal[] = [];
    const phases: string[] = [];
    const first = queue.enqueue(async (signal) => {
      signals.push(signal);
      await releases[0].promise;
      return "cleaned";
    }, { signal: cancelled.signal, onPhase: (phase) => phases.push(phase) });
    assert.deepEqual(phases, ["queued", "running"]);
    const sibling = queue.enqueue(async (signal) => {
      signals.push(signal);
      await releases[1].promise;
    });
    const pending = queue.enqueue(() => assert.fail("cancelled job launched"), { signal: queued.signal });
    const rejected = assert.rejects(pending, (error) => error === reason);
    queued.abort(reason);
    await rejected;
    let nextStarted = false;
    const next = queue.enqueue(() => { nextStarted = true; });
    cancelled.abort(reason);
    assert.equal(signals[0].reason, reason);
    assert.equal(signals[1].aborted, false);
    await Promise.resolve();
    assert.equal(nextStarted, false);
    assert.deepEqual(phases, ["queued", "running"]);
    await assert.rejects(queue.enqueue(() => assert.fail("pre-aborted launched"), { signal: cancelled.signal }), (error) => error === reason);
    releases[0].resolve();
    assert.equal(await first, "cleaned");
    await next;
    assert.equal(getEventListeners(cancelled.signal, "abort").length, 0);
    assert.equal(getEventListeners(queued.signal, "abort").length, 0);
    releases[1].resolve();
    await sibling;
  });

  it("uses exclusive entries as FIFO barriers even with spare slots", async () => {
    const queue = new ConcurrentRunQueue();
    const releases = Array.from({ length: 4 }, () => deferred());
    const starts = Array.from({ length: 4 }, () => deferred());
    const started: number[] = [];
    const runs = releases.map((release, index) => queue.enqueue(async () => {
      started.push(index);
      starts[index].resolve();
      await release.promise;
    }, { exclusive: index === 1 || index === 2 }));
    assert.deepEqual(started, [0]);
    for (let index = 0; index < 3; index++) {
      releases[index].resolve();
      await starts[index + 1].promise;
      assert.deepEqual(started, Array.from({ length: index + 2 }, (_, i) => i));
    }
    releases[3].resolve();
    await Promise.all(runs);
  });

  it("shutdown atomically closes admission, aborts every active slot and joins cleanup once", async () => {
    const queue = new ConcurrentRunQueue();
    const releases = Array.from({ length: 3 }, () => deferred());
    const signals: AbortSignal[] = [];
    const reentrant: Promise<unknown>[] = [];
    const drains: Promise<void>[] = [];
    const runs = releases.map((release) => queue.enqueue(async (signal) => {
      signals.push(signal);
      signal.addEventListener("abort", () => {
        reentrant.push(assert.rejects(queue.enqueue(() => assert.fail("admitted during shutdown")), /shut down/i));
        drains.push(queue.shutdown());
      });
      await release.promise;
    }));
    const pending = assert.rejects(queue.enqueue(() => assert.fail("queued launch during shutdown")), /shut down/i);
    assert.equal(typeof queue.shutdown, "function");
    const shutdown = queue.shutdown();
    assert.equal(queue.shutdown(), shutdown);
    assert.equal(drains.length, 3);
    assert.ok(drains.every((drain) => drain === shutdown));
    let finished = false;
    void shutdown.then(() => { finished = true; });
    assert.ok(signals.every((signal) => signal.aborted));
    await pending;
    for (const release of releases.slice(0, 2)) release.resolve();
    await Promise.all(runs.slice(0, 2));
    assert.equal(finished, false);
    releases[2].resolve();
    await Promise.all([...runs, ...reentrant, shutdown]);
    assert.equal(finished, true);
    await assert.rejects(queue.enqueue(() => undefined), /shut down/i);
  });

  it("finishes queued notification before reentrant admissions can launch that operation", async () => {
    const queue = new ConcurrentRunQueue({ concurrency: 1 });
    const controller = new AbortController();
    const reason = new Error("cancel from queued observer");
    const starts: string[] = [];
    let nested!: Promise<string>;
    const outer = queue.enqueue(() => { starts.push("outer"); }, {
      signal: controller.signal,
      onPhase: (phase) => {
        if (phase !== "queued") return;
        nested = queue.enqueue(() => { starts.push("nested"); return "nested"; });
        controller.abort(reason);
      },
    });
    assert.deepEqual(starts, ["nested"]);
    await assert.rejects(outer, (error) => error === reason);
    assert.equal(await nested, "nested");
  });

  it("does not launch after synchronous phase abort or shutdown", async () => {
    for (const phaseToStop of ["queued", "running"]) {
      for (const stop of ["abort", "shutdown"]) {
        const queue = new ConcurrentRunQueue();
        const controller = new AbortController();
        const reason = new Error("observer cancellation");
        const phases: string[] = [];
        let drain: Promise<void> | undefined;
        let launched = false;
        const run = queue.enqueue(() => { launched = true; }, {
          signal: controller.signal,
          onPhase: (phase) => {
            phases.push(phase);
            if (phase !== phaseToStop) return;
            if (stop === "abort") controller.abort(reason);
            else drain = queue.shutdown();
          },
        });
        await assert.rejects(run, stop === "abort" ? (error: unknown) => error === reason : /shut down/i);
        assert.equal(launched, false);
        assert.deepEqual(phases, phaseToStop === "queued" ? ["queued"] : ["queued", "running"]);
        assert.equal(getEventListeners(controller.signal, "abort").length, 0);
        await drain;
      }
    }
  });

  it("contains observer exceptions and synchronous operation throws without leaking slots or listeners", async () => {
    const queue = new ConcurrentRunQueue({ concurrency: 1 });
    const controller = new AbortController();
    const failure = new Error("synchronous operation failure");
    const failed = queue.enqueue(() => { throw failure; }, {
      signal: controller.signal,
      onPhase: () => { throw new Error("observer failure"); },
    });
    const next = queue.enqueue(() => "next");
    await assert.rejects(failed, (error) => error === failure);
    assert.equal(await next, "next");
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    await queue.enqueue(() => undefined, { signal: controller.signal });
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    await queue.shutdown();
  });

  it("cancelling a pending exclusive barrier frees spare slots without overtaking older jobs", async () => {
    const queue = new ConcurrentRunQueue();
    const controller = new AbortController();
    const release = deferred();
    const first = queue.enqueue(() => release.promise);
    const barrier = queue.enqueue(() => assert.fail("cancelled barrier launched"), { exclusive: true, signal: controller.signal });
    const rejected = assert.rejects(barrier);
    const started: number[] = [];
    const second = queue.enqueue(() => { started.push(2); });
    const third = queue.enqueue(() => { started.push(3); });
    assert.deepEqual(started, []);
    controller.abort();
    assert.deepEqual(started, [2, 3]);
    release.resolve();
    await Promise.all([first, rejected, second, third]);
  });

  it("bounds reentrant admissions and preserves FIFO during running notifications", async () => {
    const queue = new ConcurrentRunQueue({ concurrency: 1, pendingCapacity: 1 });
    const release = deferred();
    const started: number[] = [];
    let nested!: Promise<void>;
    let overflow!: Promise<void>;
    const first = queue.enqueue(async () => { started.push(1); await release.promise; }, {
      onPhase: (phase) => {
        if (phase !== "running") return;
        nested = queue.enqueue(() => { started.push(2); });
        overflow = assert.rejects(queue.enqueue(() => assert.fail("overflow launched")), /capacity/i);
      },
    });
    assert.deepEqual(started, [1]);
    release.resolve();
    await Promise.all([first, nested, overflow]);
    assert.deepEqual(started, [1, 2]);
  });

  it("joins rejected asynchronous cleanup and shuts down an idle queue idempotently", async () => {
    const queue = new ConcurrentRunQueue();
    const release = deferred();
    const failure = new Error("cleanup failed");
    const run = queue.enqueue(async () => { await release.promise; throw failure; });
    const rejected = assert.rejects(run, (error) => error === failure);
    const drain = queue.shutdown();
    release.resolve();
    await Promise.all([rejected, drain]);
    const idle = new ConcurrentRunQueue();
    const idleDrain = idle.shutdown();
    assert.equal(idle.shutdown(), idleDrain);
    await idleDrain;
  });

  it("makes a settled slot available before callers observe completion", async () => {
    const queue = new ConcurrentRunQueue({ concurrency: 1, pendingCapacity: 0 });
    assert.equal(await queue.enqueue(() => "first"), "first");
    assert.equal(await queue.enqueue(() => "second"), "second");
    await assert.rejects(queue.enqueue(() => { throw new Error("failed"); }), /failed/);
    assert.equal(await queue.enqueue(() => "after failure"), "after failure");
  });

  it("admits three active operations and eight pending in FIFO order", async () => {
    const queue = new ConcurrentRunQueue();
    const releases = Array.from({ length: 11 }, () => deferred());
    const starts = Array.from({ length: 11 }, () => deferred());
    const started: number[] = [];
    const runs = releases.map((release, index) => queue.enqueue(async () => {
      started.push(index);
      starts[index].resolve();
      await release.promise;
      return index;
    }));
    assert.deepEqual(started, [0, 1, 2]);
    await assert.rejects(queue.enqueue(() => assert.fail("overflow launched")), /capacity/i);
    for (let index = 0; index < 8; index++) {
      releases[index].resolve();
      await starts[index + 3].promise;
      assert.deepEqual(started, Array.from({ length: index + 4 }, (_, i) => i));
    }
    releases.slice(8).forEach((release) => release.resolve());
    assert.deepEqual(await Promise.all(runs), Array.from({ length: 11 }, (_, i) => i));
  });
});

it("pending cleanup pin: owns disposal without occupying free active slots or losing drain", async () => {
  const queue = new ConcurrentRunQueue({ concurrency: 1, pendingCapacity: 1, unboundedExclusivePending: true });
  const active = deferred(), disposal = deferred(), next = deferred();
  const controller = new AbortController();
  let calls = 0, drained = false, cancelledLaunched = false;
  const running = queue.enqueue(() => active.promise);
  const cancelled = queue.enqueue(() => { cancelledLaunched = true; }, {
    signal: controller.signal,
    async onPendingCancel() { calls++; await disposal.promise; throw Error("disposal fault"); },
  });
  const rejected = assert.rejects(cancelled, /disposal fault/);
  controller.abort(); controller.abort();
  try {
    assert.throws(() => queue.assertAdmission(), /capacity/);
    active.resolve(); await running;
    let started = false;
    const available = queue.enqueue(async () => { started = true; await next.promise; });
    assert.equal(started, true, "disposal must not occupy an active slot");
    let exclusiveStarted = false;
    const exclusive = queue.enqueue(() => { exclusiveStarted = true; }, { exclusive: true });
    const exclusiveRejected = assert.rejects(exclusive, /shut down/);
    const shutdown = queue.shutdown().then(() => { drained = true; });
    next.resolve(); await available;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(drained, false);
    assert.equal(calls, 1);
    assert.equal(cancelledLaunched, false);
    assert.equal(exclusiveStarted, false);
    disposal.resolve(); await rejected; await exclusiveRejected; await shutdown;
  } finally { active.resolve(); next.resolve(); disposal.resolve(); await rejected; await queue.shutdown(); }
});

it("queued cleanup credits bound repeated observer aborts and join every disposal", { timeout: 5000 }, async () => {
  for (const [concurrency, pendingCapacity] of [[1, 1], [1, 0], [3, 8]]) {
    const queue = new ConcurrentRunQueue({ concurrency, pendingCapacity });
    const limit = concurrency + pendingCapacity;
    const gates = Array.from({ length: limit + 3 }, () => deferred());
    const runs: Promise<unknown>[] = [];
    let admitted = 0, launched = 0, drained = false;
    const disposalFailure = new Error("disposal rejected");
    try {
      for (const gate of gates) {
        const controller = new AbortController();
        const index = runs.length;
        runs.push(queue.enqueue(() => { launched++; }, {
          signal: controller.signal,
          onPhase(phase) {
            if (phase === "queued") { admitted++; controller.abort(new Error("queued abort")); }
          },
          async onPendingCancel() { await gate.promise; if (index === 0) throw disposalFailure; },
        }));
        // Own all rejections immediately, including unexpected admissions in the red run.
        void runs.at(-1)!.catch(() => {});
      }
      assert.equal(admitted, limit, "only active plus pending credits may own disposal");
      assert.equal(launched, 0);
      for (const run of runs.slice(limit)) await assert.rejects(run, /capacity/i);
      const drain = queue.shutdown().then(() => { drained = true; });
      for (let i = 0; i < limit; i++) {
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(drained, false, "each admitted disposal must remain joined");
        gates[i].resolve();
        await assert.rejects(runs[i], i === 0 ? error => error === disposalFailure : /queued abort/);
      }
      await drain;
      assert.equal(drained, true);
    } finally {
      gates.forEach(gate => gate.resolve());
      await Promise.allSettled(runs);
      await queue.shutdown();
    }
  }
});

it("queued reservations prevent nested waiters borrowing cleanup credits", { timeout: 5000 }, async () => {
  for (const stop of ["abort", "shutdown"] as const) {
    const queue = new ConcurrentRunQueue({ concurrency: 1, pendingCapacity: 1 });
    const controller = new AbortController();
    const disposal = deferred();
    const events: string[] = [];
    const runs: Promise<unknown>[] = [];
    let inside: string[] = [], drain: Promise<void> | undefined;
    try {
      const outer = queue.enqueue(() => { events.push("outer"); }, {
        signal: controller.signal,
        onPendingCancel: () => disposal.promise,
        onPhase(phase) {
          if (phase !== "queued") return;
          const nested = queue.enqueue(() => { events.push("nested"); });
          runs.push(nested); void nested.catch(() => {});
          if (stop === "abort") controller.abort(new Error("outer cancelled"));
          else drain = queue.shutdown();
          inside = [...events];
          events.push("observer returned");
        },
      });
      runs.push(outer); void outer.catch(() => {});
      assert.deepEqual(inside, []);
      assert.deepEqual(events, ["observer returned"], "waiter cannot borrow the cancelled reservation");
      disposal.resolve();
      await assert.rejects(outer, stop === "abort" ? /outer cancelled/ : /shut down/);
      if (stop === "abort") {
        await runs[0];
        assert.deepEqual(events, ["observer returned", "nested"]);
      } else {
        await assert.rejects(runs[0], /shut down/);
        await drain;
        assert.deepEqual(events, ["observer returned"]);
      }
    } finally {
      disposal.resolve();
      await queue.shutdown();
      await Promise.allSettled(runs);
    }
  }
});

it("queued exclusive reservations hold exclusion through disposal without bypassing FIFO", { timeout: 5000 }, async () => {
  const queue = new ConcurrentRunQueue({ concurrency: 3, pendingCapacity: 1, unboundedExclusivePending: true });
  const disposal = deferred(), running = deferred();
  const controller = new AbortController();
  const runs: Promise<unknown>[] = [];
  const starts: string[] = [];
  let inside: string[] = [];
  try {
    const reserved = queue.enqueue(() => { starts.push("cancelled exclusive"); }, {
      exclusive: true, signal: controller.signal, onPendingCancel: () => disposal.promise,
      onPhase(phase) {
        if (phase !== "queued") return;
        const background = queue.enqueue(async () => { starts.push("background"); await running.promise; });
        runs.push(background); void background.catch(() => {});
        for (let i = 0; i < 12; i++) {
          const barrier = queue.enqueue(() => { starts.push(`barrier-${i}`); }, { exclusive: true });
          runs.push(barrier); void barrier.catch(() => {});
        }
        controller.abort();
        inside = [...starts];
      },
    });
    runs.push(reserved); void reserved.catch(() => {});
    assert.deepEqual(inside, []);
    assert.deepEqual(starts, []);
    await assert.rejects(queue.enqueue(() => assert.fail("overflow launched")), /capacity/);
    disposal.resolve(); await assert.rejects(reserved);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(starts, ["background"], "exclusive waiters cannot overlap running background");
    running.resolve(); await Promise.all(runs.slice(0, -1));
    assert.deepEqual(starts, ["background", ...Array.from({ length: 12 }, (_, i) => `barrier-${i}`)]);
  } finally {
    disposal.resolve(); running.resolve();
    await queue.shutdown(); await Promise.allSettled(runs);
  }
});
