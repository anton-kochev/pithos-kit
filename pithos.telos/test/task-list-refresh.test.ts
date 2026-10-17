import assert from "node:assert/strict";
import { it } from "node:test";
import type { ArtifactLoad } from "../src/artifact";
import type { TelosConfig } from "../src/config";
import { startTaskListRefresh, type RefreshScheduler, type RefreshWarnings } from "../src/task-list-refresh";
import { filterTasks, type Task } from "../src/tasks";

// Test list: immediate reads/default cadence; config-independent cadence/reschedule;
// in-flight coalescing; independent warning recovery; missing/created/empty;
// semantic equality; stop pending reads/timers; timer unref.
const task = (title = "First", status: Task["status"] = "todo"): Task => ({
	id: `TSK-${title}`, title, status, priority: "medium", notes: "", dependencies: [],
	created: "2026-06-02T12:00:00.000Z", updated: "2026-06-02T12:00:00.000Z",
});
const load = (tasks: Task[] = [], existed = true): ArtifactLoad => ({ artifact: { telos_version: 1, tasks }, existed });
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
async function flush() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
}
class Clock {
	now = 0;
	unrefs = 0;
	jobs = new Map<object, { at: number; callback: () => void }>();
	scheduler: RefreshScheduler = {
		setTimeout: (callback, ms) => {
			const handle = { unref: () => { this.unrefs++; } };
			this.jobs.set(handle, { at: this.now + ms, callback });
			return handle;
		},
		clearTimeout: (handle) => { this.jobs.delete(handle as object); },
	};
	async advance(ms: number) {
		const end = this.now + ms;
		while (true) {
			const next = [...this.jobs].sort((a, b) => a[1].at - b[1].at)[0];
			if (!next || next[1].at > end) break;
			this.now = next[1].at;
			this.jobs.delete(next[0]);
			next[1].callback();
			await flush();
		}
		this.now = end;
		await flush();
	}
}

it("immediately rechecks both streams without remounting initial tasks; defaults while config is slow", async () => {
	const clock = new Clock();
	const config = deferred<TelosConfig>();
	let taskReads = 0;
	let configReads = 0;
	const tasks: Task[][] = [];
	const warnings: RefreshWarnings[] = [];
	const stop = startTaskListRefresh({
		initial: load([task()]), scheduler: clock.scheduler,
		loadTasks: async () => { taskReads++; return load([task()]); },
		loadConfig: () => { configReads++; return config.promise; },
		onTasks: (value) => tasks.push(value), onWarnings: (value) => warnings.push(value),
	});
	await flush();
	assert.equal(taskReads, 1);
	assert.equal(configReads, 1);
	assert.deepEqual(tasks, []);
	await clock.advance(3000);
	assert.equal(taskReads, 4);
	assert.equal(configReads, 1);
	assert.deepEqual(warnings, []);
	assert.ok(clock.unrefs > 0);
	stop(); stop();
	config.resolve({ refreshIntervalMs: 250 });
	await flush();
	assert.equal(clock.jobs.size, 0);
	await clock.advance(10000);
	assert.equal(taskReads, 4);
});

it("polls config independently of long task cadence and coalesces in-flight interval edits", async () => {
	const clock = new Clock();
	let interval = 10000;
	let reads = 0;
	let configReads = 0;
	let pending: ReturnType<typeof deferred<ArtifactLoad>> | undefined;
	const stop = startTaskListRefresh({
		initial: load(), scheduler: clock.scheduler,
		loadTasks: async () => { reads++; return pending ? pending.promise : load(); },
		loadConfig: async () => { configReads++; return { refreshIntervalMs: interval }; },
		onTasks: () => {}, onWarnings: () => {},
	});
	await flush();
	assert.equal(reads, 2, "changed config requests prompt task recheck");
	await clock.advance(3000);
	assert.equal(configReads, 4);
	assert.equal(reads, 2, "long task interval does not block config checks");
	interval = 250;
	pending = deferred<ArtifactLoad>();
	await clock.advance(1000);
	assert.equal(reads, 3, "interval edit cancels old timer and reads promptly");
	interval = 500;
	await clock.advance(1000);
	interval = 750;
	await clock.advance(1000);
	assert.equal(reads, 3, "no overlapping task read despite multiple config edits");
	const current = pending;
	pending = undefined;
	current.resolve(load());
	await flush();
	assert.equal(reads, 4, "only one coalesced follow-up read");
	await clock.advance(749);
	assert.equal(reads, 4);
	await clock.advance(1);
	assert.equal(reads, 5, "newest interval wins");
	interval = 1000; // deletion is represented by the config loader's default.
	await clock.advance(250);
	assert.equal(reads, 6);
	await clock.advance(999);
	assert.equal(reads, 6);
	await clock.advance(1);
	assert.equal(reads, 7);
	stop();
	assert.equal(clock.jobs.size, 0);
});

it("waits for initial creation, emits normalized active changes, and retains tasks on missing/invalid reloads", async () => {
	const clock = new Clock();
	let next = load([], false);
	let failure = false;
	const updates: Task[][] = [];
	const warnings: RefreshWarnings[] = [];
	const stop = startTaskListRefresh({
		initial: next, scheduler: clock.scheduler,
		loadTasks: async () => { if (failure) throw new Error("private task contents"); return next; },
		loadConfig: async () => ({ refreshIntervalMs: 1000 }),
		onTasks: (tasks) => updates.push(tasks), onWarnings: (value) => warnings.push(value),
	});
	await flush();
	await clock.advance(1000);
	assert.deepEqual(updates, []);
	assert.deepEqual(warnings, []);
	const all = [task("done", "done"), task("archived", "archived"), task("open")];
	next = load(all);
	await clock.advance(1000);
	assert.deepEqual(updates, [filterTasks(all, "active")]);
	// Fresh objects/property order and body-only changes do not redraw.
	next = load(all.map(({ updated, ...rest }) => ({ updated, ...rest })));
	await clock.advance(1000);
	assert.equal(updates.length, 1);
	next = load([all[0], { ...all[1], notes: "archived change" }, all[2]]);
	await clock.advance(1000);
	assert.equal(updates.length, 1);
	next = load([], false);
	await clock.advance(1000);
	assert.equal(updates.length, 1);
	assert.ok(warnings.at(-1)?.task);
	const missingWarningCount = warnings.length;
	await clock.advance(1000);
	assert.equal(warnings.length, missingWarningCount);
	failure = true;
	await clock.advance(1000);
	assert.equal(updates.length, 1);
	assert.ok(!JSON.stringify(warnings).includes("private"));
	failure = false;
	next = load(all);
	await clock.advance(1000);
	assert.equal(updates.length, 1, "unchanged recovery still clears warning");
	assert.deepEqual(warnings.at(-1), {});
	next = load([]);
	await clock.advance(1000);
	assert.deepEqual(updates.at(-1), [], "valid persisted empty is a real update");
	assert.equal(updates.length, 2);
	stop();
});

it("keeps independent deduplicated warnings and the last valid interval until config recovery", async () => {
	const clock = new Clock();
	let taskFailure = true;
	let configFailure = true;
	let interval = 250;
	let reads = 0;
	const warnings: RefreshWarnings[] = [];
	const stop = startTaskListRefresh({
		initial: load([task()]), scheduler: clock.scheduler,
		loadTasks: async () => { reads++; if (taskFailure) throw new Error("bad task"); return load([task()]); },
		loadConfig: async () => { if (configFailure) throw new Error("private config"); return { refreshIntervalMs: interval }; },
		onTasks: () => assert.fail("same data must not emit"), onWarnings: (value) => warnings.push(value),
	});
	await flush();
	assert.ok(warnings.at(-1)?.task);
	assert.ok(warnings.at(-1)?.config);
	assert.ok(!JSON.stringify(warnings).includes("private"));
	const count = warnings.length;
	await clock.advance(2000);
	assert.equal(reads, 3, "default cadence on initial config failure");
	assert.equal(warnings.length, count);
	configFailure = false;
	await clock.advance(1000);
	assert.ok(warnings.at(-1)?.task);
	assert.equal(warnings.at(-1)?.config, undefined);
	const afterConfig = reads;
	configFailure = true;
	await clock.advance(1000);
	assert.equal(reads - afterConfig, 4, "retain last valid 250ms cadence");
	assert.ok(warnings.at(-1)?.task);
	assert.ok(warnings.at(-1)?.config);
	taskFailure = false;
	await clock.advance(250);
	assert.equal(warnings.at(-1)?.task, undefined);
	assert.ok(warnings.at(-1)?.config);
	configFailure = false;
	interval = 1000;
	await clock.advance(750);
	assert.deepEqual(warnings.at(-1), {});
	stop();
});

it("discards resolved and rejected pending reads after idempotent disposal", async () => {
	for (const reject of [false, true]) {
		const clock = new Clock();
		const tasks = deferred<ArtifactLoad>();
		const config = deferred<TelosConfig>();
		let callbacks = 0;
		let reads = 0;
		const stop = startTaskListRefresh({
			initial: load(), scheduler: clock.scheduler,
			loadTasks: () => { reads++; return tasks.promise; }, loadConfig: () => config.promise,
			onTasks: () => { callbacks++; }, onWarnings: () => { callbacks++; },
		});
		stop(); stop();
		if (reject) {
			tasks.reject(new Error("late task rejection"));
			config.reject(new Error("late config rejection"));
		} else {
			tasks.resolve(load([task()]));
			config.resolve({ refreshIntervalMs: 250 });
		}
		await flush();
		assert.equal(callbacks, 0, "pending results cannot notify after stop");
		assert.equal(clock.jobs.size, 0, "pending results cannot schedule after stop");
		await clock.advance(5000);
		assert.equal(reads, 1);
	}
});

it("contains consumer callback errors without unhandled rejections or stopping either stream", async () => {
	const clock = new Clock();
	let taskReads = 0;
	let configReads = 0;
	let taskNotifications = 0;
	let warningNotifications = 0;
	const stop = startTaskListRefresh({
		initial: load(), scheduler: clock.scheduler,
		loadTasks: async () => { taskReads++; return load([task(String(taskReads))]); },
		loadConfig: async () => { configReads++; throw new Error("invalid config"); },
		onTasks: () => { taskNotifications++; throw new Error("consumer task callback"); },
		onWarnings: () => { warningNotifications++; throw new Error("consumer warning callback"); },
	});
	await flush();
	await clock.advance(2000);
	stop();
	assert.equal(taskReads, 3);
	assert.equal(configReads, 3);
	assert.equal(taskNotifications, 3);
	assert.equal(warningNotifications, 1, "consumer errors do not become task-load warnings");
});
