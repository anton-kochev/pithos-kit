export type ConcurrentRunQueueOperation<T> = (signal: AbortSignal) => T | PromiseLike<T>;

export interface ConcurrentRunQueueLimits {
	/** Positive safe integer; defaults to three active operations. */
	concurrency?: number;
	/** Nonnegative safe integer; defaults to eight waiting operations. */
	pendingCapacity?: number;
}

export interface ConcurrentRunQueueOptions {
	/** Wait for all active work, then hold the queue alone until settlement. */
	exclusive?: boolean;
	/** Queued abort rejects; active abort signals the operation and preserves its eventual result. */
	signal?: AbortSignal;
	/** Synchronous observation; exceptions are ignored, but abort/shutdown takes effect before launch. */
	onPhase?: (phase: "queued" | "running") => void;
}

interface QueueEntry {
	exclusive: boolean;
	start(): Promise<void>;
	cancel(reason: unknown): void;
}

function reportPhase(callback: ConcurrentRunQueueOptions["onPhase"], phase: "queued" | "running"): void {
	try {
		callback?.(phase);
	} catch {
		// Observers cannot take ownership of scheduling or settlement.
	}
}

/** Operations must settle only after all their owned asynchronous cleanup finishes. */
export class ConcurrentRunQueue {
	private readonly pending: QueueEntry[] = [];
	private readonly active = new Set<QueueEntry>();
	private pumping = false;
	private notifyingQueued = 0;
	private shutdownError: Error | undefined;
	private shutdownPromise: Promise<void> | undefined;
	private resolveShutdown: (() => void) | undefined;
	private readonly concurrency: number;
	private readonly pendingCapacity: number;

	constructor({ concurrency = 3, pendingCapacity = 8 }: ConcurrentRunQueueLimits = {}) {
		if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new RangeError("Invalid concurrency.");
		if (!Number.isSafeInteger(pendingCapacity) || pendingCapacity < 0) throw new RangeError("Invalid pendingCapacity.");
		this.concurrency = concurrency;
		this.pendingCapacity = pendingCapacity;
	}

	enqueue<T>(operation: ConcurrentRunQueueOperation<T>, options: ConcurrentRunQueueOptions = {}): Promise<T> {
		if (this.shutdownError) return Promise.reject(this.shutdownError);
		if (options.signal?.aborted) return Promise.reject(options.signal.reason);
		const canStart = this.pending.length === 0 && this.canStart(options.exclusive === true);
		if (!canStart && this.pending.length >= this.pendingCapacity) return Promise.reject(new Error("Run queue pending capacity exceeded."));
		return new Promise<T>((resolve, reject) => {
			let state: "queued" | "running" | "settled" = "queued";
			const controller = new AbortController();
			const removeListener = () => options.signal?.removeEventListener("abort", abortRequest);
			const entry: QueueEntry = {
				exclusive: options.exclusive === true,
				start: async () => {
					if (state !== "queued") return;
					state = "running";
					reportPhase(options.onPhase, "running");
					try {
						controller.signal.throwIfAborted();
						resolve(await operation(controller.signal));
					} catch (error) {
						reject(error);
					} finally {
						state = "settled";
						removeListener();
						this.finishEntry(entry);
					}
				},
				cancel: (reason) => {
					if (state === "settled") return;
					removeListener();
					if (state === "queued") {
						state = "settled";
						const index = this.pending.indexOf(entry);
						if (index >= 0) this.pending.splice(index, 1);
						reject(reason);
					} else {
						controller.abort(reason);
					}
				},
			};
			const abortRequest = () => {
				entry.cancel(options.signal?.reason);
				this.startNext();
			};
			this.pending.push(entry);
			options.signal?.addEventListener("abort", abortRequest, { once: true });
			// A reentrant enqueue must not launch this entry before its queued observer
			// has had the opportunity to cancel it or shut down the queue.
			this.notifyingQueued++;
			reportPhase(options.onPhase, "queued");
			this.notifyingQueued--;
			this.startNext();
		});
	}

	/** Close admission before signalling callbacks; join all active operation cleanup. */
	shutdown(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise;
		this.shutdownError = new Error("Run queue has shut down.");
		this.shutdownPromise = new Promise<void>((resolve) => { this.resolveShutdown = resolve; });
		for (const entry of this.pending.splice(0)) entry.cancel(this.shutdownError);
		for (const entry of this.active) entry.cancel(this.shutdownError);
		this.finishShutdown();
		return this.shutdownPromise;
	}

	private finishShutdown(): void {
		if (this.active.size !== 0) return;
		this.resolveShutdown?.();
		this.resolveShutdown = undefined;
	}

	private finishEntry(entry: QueueEntry): void {
		this.active.delete(entry);
		if (this.shutdownError) this.finishShutdown();
		else this.startNext();
	}

	private canStart(exclusive: boolean): boolean {
		if (exclusive) return this.active.size === 0;
		return this.active.size < this.concurrency && ![...this.active].some((entry) => entry.exclusive);
	}

	private startNext(): void {
		if (this.pumping || this.notifyingQueued > 0 || this.shutdownError) return;
		this.pumping = true;
		try {
			while (!this.shutdownError && this.pending.length && this.canStart(this.pending[0].exclusive)) {
				const entry = this.pending.shift()!;
				this.active.add(entry);
				void entry.start();
			}
		} finally {
			this.pumping = false;
		}
	}
}
