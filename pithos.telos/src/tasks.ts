import { randomBytes } from "node:crypto";

export const TASK_STATUSES = ["todo", "in_progress", "blocked", "done", "archived"] as const;
export const TASK_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export const LIST_SCOPES = ["active", "archived", "all"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export type ListScope = (typeof LIST_SCOPES)[number];

export type Task = {
	id: string;
	title: string;
	status: TaskStatus;
	priority: TaskPriority;
	notes: string;
	dependencies: string[];
	created: string;
	updated: string;
};

export type TaskArtifact = {
	telos_version: 1;
	tasks: Task[];
};

export type TaskOperation =
	| {
			action: "create";
			title?: string;
			status?: TaskStatus;
			priority?: TaskPriority;
			notes?: string;
			dependencies?: string[];
	  }
	| { action: "list"; scope?: ListScope; includeArchived?: boolean }
	| { action: "show"; id?: string }
	| {
			action: "update";
			id?: string;
			title?: string;
			status?: TaskStatus;
			priority?: TaskPriority;
			notes?: string;
			dependencies?: string[];
	  }
	| { action: "status"; id?: string; status?: TaskStatus }
	| { action: "complete"; id?: string }
	| { action: "reopen"; id?: string }
	| { action: "block"; id?: string }
	| { action: "archive"; id?: string }
	| { action: "delete"; id?: string };

export type TaskOperationResult = {
	artifact: TaskArtifact;
	text: string;
	task?: Task;
	tasks?: Task[];
	rejected?: boolean;
};

export type TaskIdHashGenerator = () => string;

export function createEmptyArtifact(): TaskArtifact {
	return { telos_version: 1, tasks: [] };
}

export function validateArtifact(value: unknown): TaskArtifact {
	if (!isRecord(value)) throw new Error("Telos artifact must be a YAML object");
	if (value.telos_version !== 1) throw new Error("Telos artifact telos_version must be 1");
	if (!Array.isArray(value.tasks)) throw new Error("Telos artifact tasks must be an array");

	const ids = new Set<string>();
	const tasks = value.tasks.map((raw, index) => validateTask(raw, index));
	for (const task of tasks) {
		if (ids.has(task.id)) throw new Error(`Duplicate task ID: ${task.id}`);
		ids.add(task.id);
	}
	validateDependencies(tasks);

	return { telos_version: 1, tasks };
}

export function validateTask(value: unknown, index = 0): Task {
	if (!isRecord(value)) throw new Error(`Task at index ${index} must be an object`);

	const id = requiredString(value.id, `tasks[${index}].id`);
	const title = requiredString(value.title, `tasks[${index}].title`);
	const status = validateStatus(value.status, `tasks[${index}].status`);
	const priority = validatePriority(value.priority, `tasks[${index}].priority`);
	const notes = stringField(value.notes, `tasks[${index}].notes`);
	const dependencies = stringArrayField(value.dependencies, `tasks[${index}].dependencies`);
	const created = validateIsoTimestamp(value.created, `tasks[${index}].created`);
	const updated = validateIsoTimestamp(value.updated, `tasks[${index}].updated`);

	if (!title.trim()) throw new Error(`tasks[${index}].title must not be empty`);
	return { id, title, status, priority, notes, dependencies, created, updated };
}

export function applyTaskOperation(
	artifact: TaskArtifact,
	operation: TaskOperation,
	now: () => Date = () => new Date(),
	generateIdHash: TaskIdHashGenerator = randomTaskIdHash,
): TaskOperationResult {
	const current = validateArtifact(artifact);
	const tasks = current.tasks.map((task) => ({ ...task, dependencies: [...task.dependencies] }));
	const nextArtifact: TaskArtifact = { telos_version: 1, tasks };

	switch (operation.action) {
		case "create": {
			const title = requireNonEmpty(operation.title, "title");
			const status = operation.status === undefined ? "todo" : validateStatus(operation.status, "status");
			const priority = operation.priority === undefined ? "medium" : validatePriority(operation.priority, "priority");
			const notes = operation.notes === undefined ? "" : stringField(operation.notes, "notes");
			const dependencies = operation.dependencies === undefined ? [] : stringArrayField(operation.dependencies, "dependencies");
			const timestamp = now().toISOString();
			const task: Task = {
				id: nextTaskId(tasks, generateIdHash),
				title,
				status,
				priority,
				notes,
				dependencies,
				created: timestamp,
				updated: timestamp,
			};
			tasks.push(task);
			validateDependencies(tasks);
			return { artifact: nextArtifact, text: `Created ${task.id}: ${task.title}`, task };
		}

		case "list": {
			const scope: ListScope = operation.scope ?? (operation.includeArchived ? "all" : "active");
			validateListScope(scope, "scope");
			const filtered = filterTasks(tasks, scope);
			return { artifact: nextArtifact, text: formatTaskList(filtered, scope), tasks: filtered };
		}

		case "show": {
			const task = findRequired(tasks, operation.id);
			return { artifact: nextArtifact, text: formatTaskDetails(task), task };
		}

		case "update": {
			const index = findRequiredIndex(tasks, operation.id);
			const task = tasks[index];
			let changed = false;

			if (operation.title !== undefined) {
				task.title = requireNonEmpty(operation.title, "title");
				changed = true;
			}
			if (operation.status !== undefined) {
				task.status = validateStatus(operation.status, "status");
				changed = true;
			}
			if (operation.priority !== undefined) {
				task.priority = validatePriority(operation.priority, "priority");
				changed = true;
			}
			if (operation.notes !== undefined) {
				task.notes = stringField(operation.notes, "notes");
				changed = true;
			}
			if (operation.dependencies !== undefined) {
				task.dependencies = stringArrayField(operation.dependencies, "dependencies");
				changed = true;
			}

			if (!changed) throw new Error("Update requires at least one of title, status, priority, notes, or dependencies");
			validateDependencies(tasks);
			task.updated = now().toISOString();
			return { artifact: nextArtifact, text: `Updated ${task.id}: ${task.title}`, task };
		}

		case "status":
			return setStatus(nextArtifact, operation.id, validateStatus(operation.status, "status"), now);
		case "complete":
			return setStatus(nextArtifact, operation.id, "done", now);
		case "reopen":
			return setStatus(nextArtifact, operation.id, "todo", now);
		case "block":
			return setStatus(nextArtifact, operation.id, "blocked", now);
		case "archive":
			return setStatus(nextArtifact, operation.id, "archived", now);

		case "delete": {
			const task = findRequired(tasks, operation.id);
			return {
				artifact: nextArtifact,
				text: `Physical deletion is not supported. Archive ${task.id} instead with /tasks archive ${task.id}.`,
				task,
				rejected: true,
			};
		}
	}
}

export function formatTaskList(tasks: Task[], scope: ListScope = "active"): string {
	if (tasks.length === 0) {
		if (scope === "archived") return "No archived tasks.";
		if (scope === "all") return "No tasks.";
		return "No active tasks.";
	}

	return tasks.map((task) => `${task.id} [${task.status}] (${task.priority}) ${task.title}`).join("\n");
}

export function formatTaskDetails(task: Task): string {
	return [
		`${task.id}: ${task.title}`,
		`Status: ${task.status}`,
		`Priority: ${task.priority}`,
		`Created: ${task.created}`,
		`Updated: ${task.updated}`,
		`Dependencies: ${task.dependencies.length ? task.dependencies.join(", ") : "(none)"}`,
		`Notes: ${task.notes || "(empty)"}`,
	].join("\n");
}

export function filterTasks(tasks: Task[], scope: ListScope): Task[] {
	if (scope === "archived") return tasks.filter((task) => task.status === "archived");
	const visible = scope === "all" ? [...tasks] : tasks.filter((task) => task.status !== "archived");
	return visible.sort((a, b) => STATUS_SORT_ORDER[a.status] - STATUS_SORT_ORDER[b.status]);
}

const STATUS_SORT_ORDER: Record<TaskStatus, number> = {
	in_progress: 0,
	blocked: 1,
	todo: 2,
	done: 3,
	archived: 4,
};

function setStatus(artifact: TaskArtifact, id: string | undefined, status: TaskStatus, now: () => Date): TaskOperationResult {
	const index = findRequiredIndex(artifact.tasks, id);
	const task = artifact.tasks[index];
	task.status = status;
	task.updated = now().toISOString();
	return { artifact, text: `Set ${task.id} status to ${status}`, task };
}

function nextTaskId(tasks: Task[], generateIdHash: TaskIdHashGenerator): string {
	const existing = new Set(tasks.map((task) => task.id));
	for (let attempt = 0; attempt < 100; attempt++) {
		const hash = normalizeShortHash(generateIdHash());
		const id = `TSK-${hash}`;
		if (!existing.has(id)) return id;
	}
	throw new Error("Unable to generate a unique task ID after 100 attempts");
}

function randomTaskIdHash(): string {
	return randomBytes(4).toString("hex");
}

function normalizeShortHash(hash: string): string {
	const normalized = hash.trim().replace(/^TSK-/i, "").toLowerCase();
	if (!/^[0-9a-f]{8}$/.test(normalized)) {
		throw new Error(`Generated task ID hash must be 8 hexadecimal characters: ${hash}`);
	}
	return normalized;
}

function findRequired(tasks: Task[], id: string | undefined): Task {
	return tasks[findRequiredIndex(tasks, id)];
}

function findRequiredIndex(tasks: Task[], id: string | undefined): number {
	const taskId = requireNonEmpty(id, "id");
	const index = tasks.findIndex((task) => task.id === taskId);
	if (index === -1) throw new Error(`No task exists for ID ${taskId}`);
	return index;
}

function validateStatus(value: unknown, field: string): TaskStatus {
	if (typeof value !== "string" || !TASK_STATUSES.includes(value as TaskStatus)) {
		throw new Error(`Invalid status for ${field}: ${String(value)}. Expected one of ${TASK_STATUSES.join(", ")}`);
	}
	return value as TaskStatus;
}

function validatePriority(value: unknown, field: string): TaskPriority {
	if (typeof value !== "string" || !TASK_PRIORITIES.includes(value as TaskPriority)) {
		throw new Error(`Invalid priority for ${field}: ${String(value)}. Expected one of ${TASK_PRIORITIES.join(", ")}`);
	}
	return value as TaskPriority;
}

function validateListScope(value: unknown, field: string): ListScope {
	if (typeof value !== "string" || !LIST_SCOPES.includes(value as ListScope)) {
		throw new Error(`Invalid list scope for ${field}: ${String(value)}. Expected one of ${LIST_SCOPES.join(", ")}`);
	}
	return value as ListScope;
}

function validateIsoTimestamp(value: unknown, field: string): string {
	const text = requiredString(value, field);
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text) || Number.isNaN(Date.parse(text))) {
		throw new Error(`${field} must be an ISO 8601 timestamp string`);
	}
	return text;
}

function requireNonEmpty(value: unknown, field: string): string {
	const text = requiredString(value, field).trim();
	if (!text) throw new Error(`${field} is required`);
	return text;
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string") throw new Error(`${field} must be a string`);
	return value;
}

function stringField(value: unknown, field: string): string {
	if (typeof value !== "string") throw new Error(`${field} must be a string`);
	return value;
}

function stringArrayField(value: unknown, field: string): string[] {
	if (!Array.isArray(value)) throw new Error(`${field} must be an array of task IDs`);
	return value.map((entry, index) => requireNonEmpty(entry, `${field}[${index}]`));
}

function validateDependencies(tasks: Task[]): void {
	const ids = new Set(tasks.map((task) => task.id));
	for (const task of tasks) {
		const seen = new Set<string>();
		for (const dependencyId of task.dependencies) {
			if (dependencyId === task.id) throw new Error(`Task ${task.id} cannot depend on itself`);
			if (!ids.has(dependencyId)) throw new Error(`Dependency ${dependencyId} for task ${task.id} does not exist`);
			if (seen.has(dependencyId)) throw new Error(`Task ${task.id} lists duplicate dependency ${dependencyId}`);
			seen.add(dependencyId);
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
