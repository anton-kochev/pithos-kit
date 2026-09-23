import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { describe, it } from "node:test";
import { RunQueue } from "../src/run-queue.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("RunQueue", () => {
  it("runs an operation and returns its result", async () => {
    const queue = new RunQueue();

    const result = await queue.enqueue(async (signal) => {
      assert.equal(signal.aborted, false);
      return "completed";
    });

    assert.equal(result, "completed");
  });

  it("reports queued and running phases", async () => {
    const queue = new RunQueue();
    const phases: string[] = [];

    await queue.enqueue(async () => undefined, {
      onPhase: (phase) => phases.push(phase),
    });

    assert.deepEqual(phases, ["queued", "running"]);
  });

  it("rejects an already-aborted request without starting it", async () => {
    const queue = new RunQueue();
    const controller = new AbortController();
    const reason = new Error("cancelled before admission");
    let started = false;
    controller.abort(reason);

    const run = queue.enqueue(async () => {
      started = true;
    }, { signal: controller.signal });

    await assert.rejects(run, (error) => error === reason);
    assert.equal(started, false);
  });

  it("removes and rejects an aborted queued request without affecting other work", async () => {
    const queue = new RunQueue();
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const queuedController = new AbortController();
    const reason = new Error("cancelled while queued");
    let firstSignal: AbortSignal | undefined;
    let queuedStarted = false;

    const first = queue.enqueue(async (signal) => {
      firstSignal = signal;
      firstStarted.resolve();
      await releaseFirst.promise;
      return "first";
    });
    await firstStarted.promise;

    const cancelled = queue.enqueue(async () => {
      queuedStarted = true;
      return "cancelled";
    }, { signal: queuedController.signal });
    const cancelledRejection = assert.rejects(cancelled, (error) => error === reason);
    const third = queue.enqueue(async (signal) => {
      assert.equal(signal.aborted, false);
      return "third";
    });

    queuedController.abort(reason);
    assert.equal(firstSignal?.aborted, false);
    releaseFirst.resolve();

    assert.equal(await first, "first");
    await cancelledRejection;
    assert.equal(await third, "third");
    assert.equal(queuedStarted, false);
  });

  it("aborts an active operation but waits for it to settle before starting the next", async () => {
    const queue = new RunQueue();
    const activeStarted = deferred<void>();
    const releaseActive = deferred<void>();
    const requestController = new AbortController();
    const reason = new Error("cancelled while running");
    let operationSignal: AbortSignal | undefined;
    let nextStarted = false;

    const active = queue.enqueue(async (signal) => {
      operationSignal = signal;
      activeStarted.resolve();
      await releaseActive.promise;
      return "active settled";
    }, { signal: requestController.signal });
    await activeStarted.promise;
    const next = queue.enqueue(async () => {
      nextStarted = true;
      return "next";
    });

    try {
      requestController.abort(reason);

      assert.equal(operationSignal?.aborted, true);
      assert.equal(operationSignal?.reason, reason);
      await Promise.resolve();
      assert.equal(nextStarted, false);
    } finally {
      releaseActive.resolve();
      await Promise.allSettled([active, next]);
    }

    assert.equal(await active, "active settled");
    assert.equal(await next, "next");
  });

  it("releases the next operation when active work fails", async () => {
    const queue = new RunQueue();
    const failure = new Error("operation failed");
    let nextStarted = false;

    const failed = queue.enqueue(async () => {
      throw failure;
    });
    const next = queue.enqueue(async () => {
      nextStarted = true;
      return "recovered";
    });

    await assert.rejects(failed, (error) => error === failure);
    await Promise.resolve();
    assert.equal(nextStarted, true);
    assert.equal(await next, "recovered");
  });

  it("closes admission on shutdown and shares one terminal promise", async () => {
    const queue = new RunQueue();

    const shutdown = queue.shutdown();
    assert.equal(queue.shutdown(), shutdown);
    await shutdown;

    let started = false;
    await assert.rejects(queue.enqueue(async () => {
      started = true;
    }), /shut down/i);
    assert.equal(started, false);
  });

  it("shutdown rejects queued work, aborts active work, and waits for active cleanup", async () => {
    const queue = new RunQueue();
    const activeStarted = deferred<void>();
    const releaseActive = deferred<void>();
    let activeSignal: AbortSignal | undefined;
    let activeCleanedUp = false;
    let queuedStarted = false;
    let shutdownResolved = false;

    const active = queue.enqueue(async (signal) => {
      activeSignal = signal;
      activeStarted.resolve();
      try {
        await releaseActive.promise;
        return "active complete";
      } finally {
        activeCleanedUp = true;
      }
    });
    await activeStarted.promise;
    const queued = queue.enqueue(async () => {
      queuedStarted = true;
      return "queued";
    });
    const queuedRejection = assert.rejects(queued, /shut down/i);

    const shutdown = queue.shutdown();
    void shutdown.then(() => { shutdownResolved = true; });

    try {
      assert.equal(activeSignal?.aborted, true);
      assert.match(String(activeSignal?.reason), /shut down/i);
      assert.equal(queuedStarted, false);
      await Promise.resolve();
      assert.equal(shutdownResolved, false);
    } finally {
      releaseActive.resolve();
      await Promise.allSettled([active, queuedRejection, shutdown]);
    }

    assert.equal(await active, "active complete");
    await queuedRejection;
    await shutdown;
    assert.equal(activeCleanedUp, true);
    assert.equal(queuedStarted, false);
    assert.equal(shutdownResolved, true);
  });

  it("removes cancellation listeners after terminal settlement", async () => {
    const queue = new RunQueue();
    const controller = new AbortController();
    const started = deferred<void>();
    const release = deferred<void>();
    let operationSignal: AbortSignal | undefined;

    const run = queue.enqueue(async (signal) => {
      operationSignal = signal;
      started.resolve();
      await release.promise;
      return "settled";
    }, { signal: controller.signal });

    await started.promise;
    assert.equal(getEventListeners(controller.signal, "abort").length, 1);
    release.resolve();
    assert.equal(await run, "settled");
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);

    controller.abort(new Error("too late"));
    assert.equal(operationSignal?.aborted, false);
  });

  it("runs at most one operation and starts queued operations in FIFO order", async () => {
    const queue = new RunQueue();
    const releases = [deferred<void>(), deferred<void>(), deferred<void>()];
    const starts = [deferred<void>(), deferred<void>(), deferred<void>()];
    const started: string[] = [];
    let active = 0;
    let maximumActive = 0;

    const runs = ["first", "second", "third"].map((name, index) =>
      queue.enqueue(async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        started.push(name);
        starts[index]?.resolve();
        await releases[index]?.promise;
        active -= 1;
        return name;
      }));

    await starts[0]?.promise;
    assert.deepEqual(started, ["first"]);

    releases[0]?.resolve();
    await starts[1]?.promise;
    assert.deepEqual(started, ["first", "second"]);

    releases[1]?.resolve();
    await starts[2]?.promise;
    assert.deepEqual(started, ["first", "second", "third"]);

    releases[2]?.resolve();
    assert.deepEqual(await Promise.all(runs), ["first", "second", "third"]);
    assert.equal(maximumActive, 1);
  });
});
