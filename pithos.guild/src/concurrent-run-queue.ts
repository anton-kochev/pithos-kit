export type ConcurrentRunQueueOperation<T> = (signal: AbortSignal) => T | PromiseLike<T>;

export interface ConcurrentRunQueueLimits {
	/** Positive safe integer; defaults to three active operations. */
	concurrency?: number;
	/** Nonnegative safe integer; defaults to eight waiting operations. */
	pendingCapacity?: number;
	/** Preserve blocking FIFO backlogs; only nonexclusive waiters consume pending capacity. Default false. */
	unboundedExclusivePending?: boolean;
}

export interface ConcurrentRunQueueOptions {
	/** Cancelled before launch: retain the admission credit and drain ownership until cleanup settles. Never self-join shutdown. */
	onPendingCancel?: (reason: unknown) => void | PromiseLike<void>;
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
	// Active credits include queued launch reservations and their prelaunch cleanup.
	// Keeping the same owner prevents observer reentry from borrowing a reserved slot.
	private readonly active = new Set<QueueEntry>();
	private readonly pendingCleanup = new Set<QueueEntry>();
	private pumping = false;
	private notifyingQueued = 0;
	private shutdownError: Error | undefined;
	private shutdownPromise: Promise<void> | undefined;
	private resolveShutdown: (() => void) | undefined;
	private readonly concurrency: number;
	private readonly pendingCapacity: number;
	private readonly unboundedExclusivePending: boolean;

	constructor({ concurrency = 3, pendingCapacity = 8, unboundedExclusivePending = false }: ConcurrentRunQueueLimits = {}) {
		if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new RangeError("Invalid concurrency.");
		if (!Number.isSafeInteger(pendingCapacity) || pendingCapacity < 0) throw new RangeError("Invalid pendingCapacity.");
		this.concurrency = concurrency;
		this.pendingCapacity = pendingCapacity;
		this.unboundedExclusivePending = unboundedExclusivePending;
	}

	/** Synchronous preflight; enqueue rechecks after any intervening caller callbacks. */
	assertAdmission(exclusive = false): void {
		if (this.shutdownError) throw this.shutdownError;
		const canStart = this.canReserve(exclusive);
		if (!canStart && (!this.unboundedExclusivePending || !exclusive)) {
			const waiting = [...this.pending, ...this.pendingCleanup].filter(entry => !this.active.has(entry) && (!this.unboundedExclusivePending || !entry.exclusive)).length;
			if (waiting >= this.pendingCapacity) throw new Error("Run queue pending capacity exceeded.");
		}
	}

	enqueue<T>(operation: ConcurrentRunQueueOperation<T>, options: ConcurrentRunQueueOptions = {}): Promise<T> {
		if (this.shutdownError) return Promise.reject(this.shutdownError);
		if (options.signal?.aborted) return Promise.reject(options.signal.reason);
		try { this.assertAdmission(options.exclusive === true); }
		catch (error) { return Promise.reject(error); }
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
						// Own disposal before removal or callback reentry can admit another waiter.
						if (options.onPendingCancel) {
							if (!this.active.has(entry)) this.pendingCleanup.add(entry);
						} else this.active.delete(entry);
						const index = this.pending.indexOf(entry);
						if (index >= 0) this.pending.splice(index, 1);
						if (options.onPendingCancel) {
							void Promise.resolve().then(() => options.onPendingCancel!(reason)).then(
								() => reject(reason), reject,
							).finally(() => {
								this.pendingCleanup.delete(entry);
								this.finishEntry(entry);
							});
						} else reject(reason);
					} else {
						controller.abort(reason);
					}
				},
			};
			const abortRequest = () => {
				entry.cancel(options.signal?.reason);
				this.startNext();
			};
			if (this.canReserve(entry.exclusive)) this.active.add(entry);
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
		if (this.active.size !== 0 || this.pendingCleanup.size !== 0) return;
		this.resolveShutdown?.();
		this.resolveShutdown = undefined;
	}

	private finishEntry(entry: QueueEntry): void {
		this.active.delete(entry);
		if (this.shutdownError) this.finishShutdown();
		else this.startNext();
	}

	private canReserve(exclusive: boolean): boolean {
		// Reservations may follow other reservations, but never overtake a waiter.
		return this.pending.every(entry => this.active.has(entry)) && this.canStart(exclusive);
	}

	private canStart(exclusive: boolean): boolean {
		if (exclusive) return this.active.size === 0;
		return this.active.size < this.concurrency && ![...this.active].some((entry) => entry.exclusive);
	}

	private startNext(): void {
		if (this.pumping || this.notifyingQueued > 0 || this.shutdownError) return;
		this.pumping = true;
		try {
			while (!this.shutdownError && this.pending.length && (this.active.has(this.pending[0]) || this.canStart(this.pending[0].exclusive))) {
				const entry = this.pending.shift()!;
				this.active.add(entry);
				void entry.start();
			}
		} finally {
			this.pumping = false;
		}
	}
}
