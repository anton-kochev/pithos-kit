import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatArtifactList } from "./artifact";
import { loadSessionTasks, captureTaskSession, EPHEMERAL_NOTICE, type TaskSession } from "./session-store";
import { loadTelosConfig } from "./config";
import { startTaskListRefresh } from "./task-list-refresh";
import { filterTasks, type Task } from "./tasks";

export async function showTaskList(
	ctx: ExtensionCommandContext,
	session: TaskSession = captureTaskSession(ctx),
	openViews?: Set<() => void>,
): Promise<void> {
	let closed = false;
	let component: TaskListComponent | undefined;
	let stop = () => {};
	let finish: (() => void) | undefined;
	const close = () => {
		if (closed) return;
		closed = true;
		stop();
		component?.dispose();
		finish?.();
	};
	openViews?.add(close);
	try {
		const loaded = await loadSessionTasks(session);
		if (closed) return;
		await ctx.ui.custom<void>((tui, theme, _kb, done) => {
			finish = () => done();
			component = new TaskListComponent(filterTasks(loaded.artifact.tasks, "active"), theme, close,
				() => tui.requestRender(), { ephemeral: session.ephemeral, onDispose: () => stop() });
			if (closed) {
				component.dispose();
				done();
				return component;
			}
			stop = startTaskListRefresh({
				initial: loaded,
				loadTasks: () => loadSessionTasks(session),
				loadConfig: () => loadTelosConfig(session.cwd),
				onTasks: (tasks) => component?.updateTasks(tasks),
				onWarnings: (warnings) => component?.setWarnings(warnings),
			});
			return component;
		});
	} finally {
		close();
		openViews?.delete(close);
	}
}

export async function activeTaskListText(session: TaskSession): Promise<string> {
	const loaded = await loadSessionTasks(session);
	const text = formatArtifactList(loaded.artifact, "active");
	return session.ephemeral ? `${text}\n\n${EPHEMERAL_NOTICE}` : text;
}

type TaskListMode = "list" | "detail";

export class TaskListComponent {
	private cachedWidth?: number;
	private cachedLines?: string[];
	private selectedIndex = 0;
	private viewportStart = 0;
	private disposed = false;
	private mode: TaskListMode = "list";
	private warnings: { task?: string; config?: string } = {};

	constructor(
		private tasks: Task[],
		private readonly theme: Theme,
		private readonly onClose: () => void,
		private readonly requestRender: () => void = () => {},
		private readonly options: { ephemeral?: boolean; onDispose?: () => void } = {},
	) {
		this.tasks = tasks.map((task) => ({ ...task, dependencies: [...task.dependencies] }));
	}

	updateTasks(tasks: Task[]): void {
		if (this.disposed) return;
		const unchanged = tasks.length === this.tasks.length && tasks.every((task, index) => {
			const previous = this.tasks[index];
			return task.id === previous.id && task.title === previous.title && task.status === previous.status
				&& task.priority === previous.priority && task.notes === previous.notes
				&& task.created === previous.created && task.updated === previous.updated
				&& task.dependencies.length === previous.dependencies.length
				&& task.dependencies.every((id, dependencyIndex) => id === previous.dependencies[dependencyIndex]);
		});
		if (unchanged) return;

		const selectedId = this.tasks[this.selectedIndex]?.id;
		const nextIndex = tasks.findIndex((task) => task.id === selectedId);
		this.tasks = tasks.map((task) => ({ ...task, dependencies: [...task.dependencies] }));
		if (nextIndex >= 0) {
			this.selectedIndex = nextIndex;
		} else {
			this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, tasks.length - 1));
			this.mode = "list";
		}
		this.clampViewport();
		this.invalidate();
		this.requestRender();
	}

	setWarnings(warnings: { task?: string; config?: string }): void {
		if (this.disposed) return;
		if (this.warnings.task === warnings.task && this.warnings.config === warnings.config) return;
		this.warnings = { ...warnings };
		this.invalidate();
		this.requestRender();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.options.onDispose?.();
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || matchesKey(data, "q")) {
			this.dispose();
			this.onClose();
			return;
		}

		if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
			this.toggleDetails();
			return;
		}

		if (this.mode === "detail") return;

		if (matchesKey(data, Key.up)) {
			this.moveSelection(-1);
			return;
		}

		if (matchesKey(data, Key.down)) {
			this.moveSelection(1);
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const th = this.theme;
		const lines: string[] = [];
		const add = (line = "") => lines.push(truncateToWidth(line, width));
		const addWrapped = (text: string, indent = "") => {
			const availableWidth = Math.max(1, width - visibleWidth(indent));
			for (const line of wrapTextWithAnsi(text, availableWidth)) {
				add(`${indent}${line}`);
			}
		};

		if (this.mode === "detail" && this.tasks[this.selectedIndex]) {
			this.renderTaskDetails(add, addWrapped, width);
			this.cachedWidth = width;
			this.cachedLines = lines;
			return lines;
		}

		const activeCount = this.tasks.length;
		const doneCount = this.tasks.filter((task) => task.status === "done").length;
		const blockedCount = this.tasks.filter((task) => task.status === "blocked").length;

		add("");
		add(headerLine("Telos Tasks", width, th));
		this.renderNotices(add);
		add("");
		add(`  ${th.fg("muted", `${doneCount}/${activeCount} done · ${blockedCount} blocked`)}`);
		add("");

		if (this.tasks.length === 0) {
			add(`  ${th.fg("dim", "No active tasks. Create one with /tasks create \"Task title\".")}`);
		} else {
			for (let index = this.viewportStart; index < Math.min(this.tasks.length, this.viewportStart + 10); index++) {
				const task = this.tasks[index];
				const selected = index === this.selectedIndex;
				const isDone = task.status === "done";
				const pointer = selected ? th.fg("accent", "›") : " ";
				const status = isDone ? th.fg("dim", statusGlyph(task.status)) : statusGlyph(task.status);
				const id = isDone ? th.fg("dim", task.id) : th.fg("accent", task.id);
				const priority = isDone ? th.fg("dim", priorityGlyph(task.priority)) : priorityColor(task.priority, th);
				const title = isDone ? th.fg("dim", task.title) : th.fg("text", task.title);
				const dependency = dependencyIndicator(task, th);
				const prefix = `${pointer} ${status} ${id} ${priority} `;
				const suffix = dependency ? `  ${dependency}` : "";
				const titleWidth = Math.max(0, width - visibleWidth(prefix) - visibleWidth(suffix));
				add(`${prefix}${truncateToWidth(title, titleWidth, "…")}${suffix}`);
			}
		}

		if (activeCount > 10) {
			add(`  ${th.fg("muted", `${this.viewportStart + 1}–${Math.min(activeCount, this.viewportStart + 10)} of ${activeCount}`)}`);
		}

		add("");
		add(`  ${th.fg("dim", "Use ↑/↓ to navigate, Enter/Space for details. Esc, Ctrl+C, or q closes.")}`);
		add("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private renderNotices(add: (line?: string) => void): void {
		if (this.options.ephemeral) add(`  ${this.theme.fg("warning", "Ephemeral session · tasks are lost on exit")}`);
		for (const warning of [this.warnings.task, this.warnings.config]) {
			if (warning) add(`  ${this.theme.fg("warning", warning)}`);
		}
	}

	private renderTaskDetails(add: (line?: string) => void, addWrapped: (text: string, indent?: string) => void, width: number): void {
		const task = this.tasks[this.selectedIndex];
		const th = this.theme;
		const description = task.notes.trim();

		add("");
		add(headerLine(task.id, width, th));
		this.renderNotices(add);
		add("");
		add(`  ${th.fg("text", task.title)}`);
		add(`  ${statusGlyph(task.status)} ${task.status} · ${priorityGlyph(task.priority)} ${task.priority}`);

		if (description) {
			add("");
			add(`  ${detailLabel("Description", th)}`);
			addWrapped(description, "  ");
		}

		if (task.dependencies.length > 0) {
			add("");
			add(`  ${detailLabel("Dependencies", th)}`);
			for (const dependencyId of task.dependencies) {
				add(`  ${formatDependency(dependencyId, this.tasks, th)}`);
			}
		}

		add("");
		add(`  ${detailLabel("Created", th)}  ${formatTaskDate(task.created)}`);
		add(`  ${detailLabel("Updated", th)}  ${formatTaskDate(task.updated)}`);
		add("");
		add(`  ${th.fg("dim", "Press Enter/Space to return. Press Esc, Ctrl+C, or q to close.")}`);
		add("");
	}

	private moveSelection(delta: number): void {
		if (this.tasks.length === 0) return;

		const nextIndex = Math.max(0, Math.min(this.tasks.length - 1, this.selectedIndex + delta));
		if (nextIndex === this.selectedIndex) return;

		this.selectedIndex = nextIndex;
		this.clampViewport();
		this.invalidate();
		this.requestRender();
	}

	private clampViewport(): void {
		this.viewportStart = Math.max(0, Math.min(this.viewportStart, this.tasks.length - 10));
		if (this.selectedIndex < this.viewportStart) this.viewportStart = this.selectedIndex;
		if (this.selectedIndex >= this.viewportStart + 10) this.viewportStart = this.selectedIndex - 9;
	}

	private toggleDetails(): void {
		if (this.tasks.length === 0) return;
		this.mode = this.mode === "list" ? "detail" : "list";
		this.invalidate();
		this.requestRender();
	}
}

function headerLine(label: string, width: number, theme: Theme): string {
	const left = theme.fg("borderMuted", "─".repeat(3));
	const title = theme.fg("accent", ` ${label} `);
	const rightWidth = Math.max(0, width - visibleWidth(left) - visibleWidth(title));
	return left + title + theme.fg("borderMuted", "─".repeat(rightWidth));
}

function detailLabel(label: string, theme: Theme): string {
	return theme.fg("muted", label);
}

function formatTaskDate(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;

	const year = date.getUTCFullYear();
	const month = String(date.getUTCMonth() + 1).padStart(2, "0");
	const day = String(date.getUTCDate()).padStart(2, "0");
	const hours = String(date.getUTCHours()).padStart(2, "0");
	const minutes = String(date.getUTCMinutes()).padStart(2, "0");
	return `${year}-${month}-${day} ${hours}:${minutes} UTC`;
}

function formatDependency(dependencyId: string, tasks: Task[], theme: Theme): string {
	const dependency = tasks.find((entry) => entry.id === dependencyId);
	if (!dependency) return theme.fg("dim", dependencyId);

	return `${statusGlyph(dependency.status)} ${dependency.id}  ${priorityGlyph(dependency.priority)}  ${dependency.title}`;
}

function statusGlyph(status: Task["status"]): string {
	switch (status) {
		case "todo":
			return "□";
		case "in_progress":
			return "▣";
		case "blocked":
			return "▧";
		case "done":
			return "■";
		case "archived":
			return "▫";
	}
}

function dependencyIndicator(task: Task, theme: Theme): string {
	if (task.dependencies.length === 0) return "";
	return theme.fg("dim", `◂${task.dependencies.length}`);
}

function priorityColor(priority: Task["priority"], theme: Theme): string {
	const glyph = priorityGlyph(priority);
	switch (priority) {
		case "urgent":
			return theme.fg("error", glyph);
		case "high":
			return theme.fg("warning", glyph);
		case "medium":
			return theme.fg("muted", glyph);
		case "low":
			return theme.fg("dim", glyph);
	}
}

function priorityGlyph(priority: Task["priority"]): string {
	switch (priority) {
		case "urgent":
			return "●●●";
		case "high":
			return "●●○";
		case "medium":
			return "●○○";
		case "low":
			return "○○○";
	}
}
