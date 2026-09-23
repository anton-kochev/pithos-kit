export type RunQueueOperation<T> = (signal: AbortSignal) => T | PromiseLike<T>;
export type RunQueuePhase = "queued" | "running";

export interface RunQueueOptions {
	signal?: AbortSignal;
	onPhase?: (phase: RunQueuePhase) => void;
}

interface QueueEntry {
	start(): Promise<void>;
	cancel(reason: unknown): void;
}

function reportPhase(callback: RunQueueOptions["onPhase"], phase: RunQueuePhase): void {
	try {
		callback?.(phase);
	} catch {
		// Phase reporting is observational and must not disrupt queue ownership.
	}
}

export class RunQueue {
	private readonly pending: QueueEntry[] = [];
	private active: QueueEntry | undefined;
	private shutdownError: Error | undefined;
	private shutdownPromise: Promise<void> | undefined;
	private resolveShutdown: (() => void) | undefined;

	enqueue<T>(operation: RunQueueOperation<T>, options: RunQueueOptions = {}): Promise<T> {
		if (this.shutdownError) return Promise.reject(this.shutdownError);
		if (options.signal?.aborted) return Promise.reject(options.signal.reason);

		return new Promise<T>((resolve, reject) => {
			let entry: QueueEntry;
			let state: "queued" | "running" | "settled" = "queued";
			let controller: AbortController | undefined;
			const removeAbortListener = () => options.signal?.removeEventListener("abort", abortRequest);
			const cancel = (reason: unknown) => {
				if (state === "settled") return;
				if (state === "queued") {
					state = "settled";
					removeAbortListener();
					reject(reason);
					return;
				}

				removeAbortListener();
				controller?.abort(reason);
			};
			const abortRequest = () => {
				if (state === "queued") {
					const index = this.pending.indexOf(entry);
					if (index < 0) return;
					this.pending.splice(index, 1);
				}
				entry.cancel(options.signal?.reason);
				this.startNext();
			};

			entry = {
				async start(): Promise<void> {
					if (state !== "queued") return;
					state = "running";
					controller = new AbortController();
					reportPhase(options.onPhase, "running");
					try {
						resolve(await operation(controller.signal));
					} catch (error) {
						reject(error);
					} finally {
						state = "settled";
						removeAbortListener();
					}
				},
				cancel,
			};

			this.pending.push(entry);
			options.signal?.addEventListener("abort", abortRequest, { once: true });
			reportPhase(options.onPhase, "queued");
			if (state === "queued") this.startNext();
		});
	}

	shutdown(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise;

		this.shutdownError = new Error("Run queue has shut down.");
		this.shutdownPromise = new Promise<void>((resolve) => {
			this.resolveShutdown = resolve;
		});

		const queued = this.pending.splice(0);
		for (const entry of queued) entry.cancel(this.shutdownError);
		this.active?.cancel(this.shutdownError);
		if (!this.active) this.finishShutdown();

		return this.shutdownPromise;
	}

	private startNext(): void {
		if (this.active || this.shutdownError) return;
		const next = this.pending.shift();
		if (!next) return;

		this.active = next;
		void next.start().then(
			() => this.finishEntry(next),
			() => this.finishEntry(next),
		);
	}

	private finishEntry(entry: QueueEntry): void {
		if (this.active !== entry) return;
		this.active = undefined;
		if (this.shutdownError) this.finishShutdown();
		else this.startNext();
	}

	private finishShutdown(): void {
		const resolve = this.resolveShutdown;
		this.resolveShutdown = undefined;
		resolve?.();
	}
}
