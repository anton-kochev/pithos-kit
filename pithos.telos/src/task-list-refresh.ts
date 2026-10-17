import type { ArtifactLoad } from "./artifact";
import { CONFIG_CHECK_INTERVAL_MS, DEFAULT_REFRESH_INTERVAL_MS, type TelosConfig } from "./config";
import { filterTasks, type Task } from "./tasks";

export type RefreshWarnings = { task?: string; config?: string };
export type RefreshTimer = number | { unref?: () => void };
export type RefreshScheduler = {
	setTimeout: (callback: () => void, delayMs: number) => RefreshTimer;
	clearTimeout: (timer: RefreshTimer) => void;
};
export type TaskListRefreshOptions = {
	loadTasks: () => Promise<ArtifactLoad>;
	loadConfig: () => Promise<TelosConfig>;
	initial: ArtifactLoad;
	onTasks: (tasks: Task[]) => void;
	onWarnings: (warnings: RefreshWarnings) => void;
	onConfig?: (config: TelosConfig) => void;
	scheduler?: RefreshScheduler;
};

const defaultScheduler: RefreshScheduler = {
	setTimeout: (callback, delay) => setTimeout(callback, delay),
	clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export function startTaskListRefresh(options: TaskListRefreshOptions): () => void {
	const scheduler = options.scheduler ?? defaultScheduler;
	let stopped = false;
	let taskTimer: RefreshTimer | undefined;
	let configTimer: RefreshTimer | undefined;
	let interval = DEFAULT_REFRESH_INTERVAL_MS;
	let taskBusy = false;
	let taskRequested = false;
	let seenPersisted = options.initial.existed;
	let tasksKey = activeTasksKey(filterTasks(options.initial.artifact.tasks, "active"));
	let warnings: RefreshWarnings = {};
	let lastConfig: TelosConfig | undefined;

	function setWarning(stream: keyof RefreshWarnings, message?: string): void {
		if (stopped || warnings[stream] === message) return;
		warnings = { ...warnings };
		if (message === undefined) delete warnings[stream];
		else warnings[stream] = message;
		// Consumer failures must not reject background polling promises.
		try { options.onWarnings({ ...warnings }); } catch {}
	}

	function schedule(callback: () => void, delay: number): RefreshTimer {
		const timer = scheduler.setTimeout(callback, delay);
		if (typeof timer === "object") timer.unref?.();
		return timer;
	}

	function requestTasks(): void {
		if (stopped) return;
		if (taskBusy) {
			taskRequested = true;
			return;
		}
		if (taskTimer !== undefined) scheduler.clearTimeout(taskTimer);
		taskTimer = undefined;
		void checkTasks();
	}

	async function checkTasks(): Promise<void> {
		taskBusy = true;
		try {
			const result = await options.loadTasks();
			if (stopped) return;
			if (!result.existed && seenPersisted) {
				setWarning("task", "Task artifact is missing; keeping last valid tasks");
				return;
			}
			seenPersisted ||= result.existed;
			const tasks = filterTasks(result.artifact.tasks, "active");
			const key = activeTasksKey(tasks);
			setWarning("task");
			if (!stopped && key !== tasksKey) {
				tasksKey = key;
				try { options.onTasks(tasks); } catch {}
			}
		} catch {
			setWarning("task", "Unable to reload task artifact; keeping last valid tasks");
		} finally {
			taskBusy = false;
			if (!stopped) {
				if (taskRequested) {
					taskRequested = false;
					requestTasks();
				} else {
					taskTimer = schedule(requestTasks, interval);
				}
			}
		}
	}

	async function checkConfig(): Promise<void> {
		try {
			const config = await options.loadConfig();
			if (stopped) return;
			setWarning("config");
			if (stopped) return;
			if (config.refreshIntervalMs !== interval) {
				interval = config.refreshIntervalMs;
				requestTasks();
			}
			if (!stopped && (lastConfig?.refreshIntervalMs !== config.refreshIntervalMs || lastConfig?.visibleTaskCount !== config.visibleTaskCount)) {
				lastConfig = { ...config };
				try { options.onConfig?.({ ...config }); } catch {}
			}
		} catch {
			setWarning("config", "Unable to reload Telos config; keeping last valid settings");
		} finally {
			if (!stopped) configTimer = schedule(() => { void checkConfig(); }, CONFIG_CHECK_INTERVAL_MS);
		}
	}

	void checkTasks();
	void checkConfig();
	return () => {
		if (stopped) return;
		stopped = true;
		if (taskTimer !== undefined) scheduler.clearTimeout(taskTimer);
		if (configTimer !== undefined) scheduler.clearTimeout(configTimer);
	};
}

// Compare the normalized visible data, not object key order or Markdown output.
function activeTasksKey(tasks: Task[]): string {
	return JSON.stringify(tasks.map((task) => [
		task.id, task.title, task.status, task.priority, task.notes,
		task.dependencies, task.created, task.updated,
	]));
}
