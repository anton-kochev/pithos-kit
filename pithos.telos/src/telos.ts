import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { formatArtifactList, isMutatingOperation, loadTaskArtifact, mutateTaskArtifact, taskFilePath } from "./artifact";
import { parseTasksCommand, TASKS_HELP } from "./commands";
import { activeTaskListText, showTaskList } from "./ui";
import { createPithosLogger, errorMetadata } from "./logging";
import {
	applyTaskOperation,
	TASK_PRIORITIES,
	TASK_STATUSES,
	type ListScope,
	type TaskOperation,
	type TaskOperationResult,
	type TaskPriority,
	type TaskStatus,
} from "./tasks";

const TOOL_NAME = "telos_tasks";

const TaskToolParams = Type.Object({
	action: StringEnum(["create", "list", "show", "update", "status", "complete", "reopen", "block", "archive", "delete"] as const, {
		description: "Task operation to perform",
	}),
	id: Type.Optional(Type.String({ description: "Task ID, e.g. TSK-abc123ef" })),
	title: Type.Optional(Type.String({ description: "Task title for create or update" })),
	status: Type.Optional(StringEnum(TASK_STATUSES, { description: "Task status" })),
	priority: Type.Optional(StringEnum(TASK_PRIORITIES, { description: "Task priority" })),
	notes: Type.Optional(Type.String({ description: "Task notes; empty string is allowed" })),
	dependencies: Type.Optional(Type.Array(Type.String(), { description: "Task IDs this task depends on" })),
	scope: Type.Optional(StringEnum(["active", "archived", "all"] as const, { description: "List scope; defaults to active" })),
});

type TaskToolParams = {
	action: TaskOperation["action"];
	id?: string;
	title?: string;
	status?: TaskStatus;
	priority?: TaskPriority;
	notes?: string;
	dependencies?: string[];
	scope?: ListScope;
};

export default function telos(pi: ExtensionAPI) {
	const log = createPithosLogger();
	log.info("extension.register");
	pi.registerTool({
		name: TOOL_NAME,
		label: "Telos Tasks",
		description:
			"Manage repo-scoped project tasks in .pi/telos-tasks.md when the user wants task tracking. Supports create, list, show, update, status changes, complete, reopen, block, archive, and delete rejection.",
		promptSnippet: "Manage repo-scoped project tasks in .pi/telos-tasks.md when the user asks to track work.",
		promptGuidelines: [
			"Use telos_tasks only when the user asks to manage, track, inspect, or update project tasks; do not create or update tasks proactively without that intent.",
			"Use telos_tasks archive instead of physical deletion when a task should be removed from active work.",
		],
		parameters: TaskToolParams,

		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const started = Date.now();
			const operation = operationFromToolParams(params as TaskToolParams);
			log.info("tool.telos_tasks.start", { toolCallId, action: operation.action, id: "id" in operation ? operation.id : undefined });
			try {
			const result = await runOperation(ctx.cwd, operation);
			log.info("tool.telos_tasks.complete", { toolCallId, durationMs: Date.now() - started, action: operation.action, rejected: result.rejected });
			return {
				content: [{ type: "text", text: result.text }],
				details: summarizeResult(result),
			};
			} catch (error) {
				log.error("tool.telos_tasks.error", { toolCallId, durationMs: Date.now() - started, action: operation.action, error: errorMetadata(error) });
				throw error;
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("telos_tasks ")) + theme.fg("muted", String(args.action ?? ""));
			if (args.id) text += ` ${theme.fg("accent", String(args.id))}`;
			if (args.title) text += ` ${theme.fg("dim", `"${String(args.title)}"`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as ReturnType<typeof summarizeResult> | undefined;
			if (details?.rejected) return new Text(theme.fg("warning", resultText(result)), 0, 0);
			return new Text(theme.fg("muted", resultText(result)), 0, 0);
		},
	});

	pi.registerCommand("tasks", {
		description: "View and manage Telos project tasks",
		handler: async (args, ctx) => {
			const parsed = parseTasksCommand(args ?? "");
			log.info("command.tasks", { sessionId: (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.(), type: parsed.type });

			if (parsed.type === "interactive") {
				if (ctx.hasUI) {
					await showTaskList(ctx);
					return;
				}
				return emitText(ctx, await activeTaskListText(ctx.cwd));
			}

			if (parsed.type === "help") return emitText(ctx, parsed.text);
			if (parsed.type === "error") return emitText(ctx, `Error: ${parsed.message}`, "error");

			try {
				const started = Date.now();
				const result = await runOperation(ctx.cwd, parsed.operation);
				log.info("command.tasks.complete", { sessionId: (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.(), durationMs: Date.now() - started, action: parsed.operation.action, rejected: result.rejected });
				return emitText(ctx, result.text, result.rejected ? "warning" : "info");
			} catch (error) {
				log.error("command.tasks.error", { sessionId: (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.(), error: errorMetadata(error) });
				return emitText(ctx, `Error: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}

async function runOperation(cwd: string, operation: TaskOperation): Promise<TaskOperationResult> {
	const filePath = taskFilePath(cwd);
	if (isMutatingOperation(operation) || operation.action === "delete") {
		return mutateTaskArtifact(filePath, operation);
	}

	const loaded = await loadTaskArtifact(filePath);
	return applyTaskOperation(loaded.artifact, operation);
}

function operationFromToolParams(params: TaskToolParams): TaskOperation {
	switch (params.action) {
		case "create":
			return pruneUndefined({
				action: "create",
				title: params.title,
				status: params.status,
				priority: params.priority,
				notes: params.notes,
				dependencies: params.dependencies,
			}) as TaskOperation;
		case "list":
			return pruneUndefined({ action: "list", scope: params.scope }) as TaskOperation;
		case "show":
			return { action: "show", id: params.id };
		case "update":
			return pruneUndefined({
				action: "update",
				id: params.id,
				title: params.title,
				status: params.status,
				priority: params.priority,
				notes: params.notes,
				dependencies: params.dependencies,
			}) as TaskOperation;
		case "status":
			return { action: "status", id: params.id, status: params.status };
		case "complete":
			return { action: "complete", id: params.id };
		case "reopen":
			return { action: "reopen", id: params.id };
		case "block":
			return { action: "block", id: params.id };
		case "archive":
			return { action: "archive", id: params.id };
		case "delete":
			return { action: "delete", id: params.id };
	}
}

function summarizeResult(result: TaskOperationResult) {
	return {
		task: result.task,
		tasks: result.tasks,
		rejected: result.rejected === true,
	};
}

function resultText(result: { content?: Array<{ type?: string; text?: string }> }): string {
	return result.content
		?.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n") ?? "";
}

function emitText(ctx: ExtensionCommandContext, text: string, level: "info" | "warning" | "error" = "info"): string {
	if (ctx.hasUI) ctx.ui.notify(text, level);
	else console.log(text);
	return text;
}

function pruneUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
	return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

export { formatArtifactList, TASKS_HELP };
