import type { ListScope, TaskOperation, TaskPriority, TaskStatus } from "./tasks";

export type ParsedTasksCommand =
	| { type: "interactive" }
	| { type: "cleanup" }
	| { type: "help"; text: string }
	| { type: "operation"; operation: TaskOperation }
	| { type: "error"; message: string };

export const TASKS_HELP = `Usage: /tasks [subcommand] [options]

Run /tasks without a subcommand to open the interactive task navigator.

Subcommands:
  list [--archived|--all]                 List this session's active tasks by default
  cleanup                                Preview orphan task files and confirm removal
  create [options] <title>                Create a task
  show <id>                               Show one task
  update <id> [options]                   Update title, status, priority, notes, or dependencies
  status <id> <status>                    Set status: todo, in_progress, blocked, done, archived
  complete <id>                           Set status to done
  reopen <id>                             Set status to todo
  block <id>                              Set status to blocked
  archive <id>                            Set status to archived
  delete <id>                             Rejected; physical deletion is out of scope

Options:
  --title <title>                         New title for update
  --status <status>                       todo, in_progress, blocked, done, archived
  --priority <priority>                   low, medium, high, urgent
  --notes <notes>                         Task notes; empty string is allowed
  --depends <id[,id...]>                  Task dependencies; use an empty value to clear
  --help, -h                              Show this help

Examples:
  /tasks create --priority high "Implement Telos"
  /tasks list --all
  /tasks update TSK-abc123ef --notes "Blocked on review"
  /tasks complete TSK-abc123ef`;

export function parseTasksCommand(rawArgs: string): ParsedTasksCommand {
	const tokens = tokenizeArgs(rawArgs.trim());
	if (tokens.length === 0) return { type: "interactive" };

	const [subcommand, ...rest] = tokens;
	if (subcommand === "--help" || subcommand === "-h" || subcommand === "help") return { type: "help", text: TASKS_HELP };

	try {
		switch (subcommand) {
			case "cleanup":
				if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) return { type: "help", text: TASKS_HELP };
				if (rest.length) throw new Error("cleanup does not accept arguments or options; confirmation is required");
				return { type: "cleanup" };
			case "list":
				return { type: "operation", operation: parseList(rest) };
			case "create":
			case "add":
				return { type: "operation", operation: parseCreate(rest) };
			case "show":
			case "view":
				return { type: "operation", operation: { action: "show", id: onlyPositional(rest, "show <id>")[0] } };
			case "update":
			case "edit":
				return { type: "operation", operation: parseUpdate(rest) };
			case "status":
				return { type: "operation", operation: parseStatus(rest) };
			case "complete":
			case "done":
			case "reopen":
			case "block":
			case "archive":
			case "delete":
				return { type: "operation", operation: parseIdOnly(subcommand, rest) };
			default:
				return { type: "error", message: `Unknown /tasks subcommand: ${subcommand}` };
		}
	} catch (error) {
		return { type: "error", message: error instanceof Error ? error.message : String(error) };
	}
}

export function tokenizeArgs(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaping = false;

	for (const char of input) {
		if (escaping) {
			current += char;
			escaping = false;
			continue;
		}
		if (char === "\\") {
			escaping = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}

	if (escaping) current += "\\";
	if (quote) throw new Error("Unterminated quoted argument");
	if (current) tokens.push(current);
	return tokens;
}

function parseList(tokens: string[]): TaskOperation {
	let scope: ListScope = "active";
	for (const token of tokens) {
		if (token === "--archived") scope = "archived";
		else if (token === "--all") scope = "all";
		else if (token === "--active") scope = "active";
		else if (token === "--help" || token === "-h") throw new Error(TASKS_HELP);
		else throw new Error(`Unknown list option: ${token}`);
	}
	return { action: "list", scope };
}

function parseCreate(tokens: string[]): TaskOperation {
	const options = parseOptions(tokens, new Set(["--status", "--priority", "--notes", "--depends", "--dependencies"]));
	if (options.positionals.length === 0) throw new Error("create requires a title");
	const operation: TaskOperation = { action: "create", title: options.positionals.join(" ") };
	const status = options.values.get("--status");
	const priority = options.values.get("--priority");
	const notes = options.values.get("--notes");
	const dependencies = options.values.get("--depends") ?? options.values.get("--dependencies");
	if (status !== undefined) operation.status = status as TaskStatus;
	if (priority !== undefined) operation.priority = priority as TaskPriority;
	if (notes !== undefined) operation.notes = notes;
	if (dependencies !== undefined) operation.dependencies = parseDependencies(dependencies);
	return operation;
}

function parseUpdate(tokens: string[]): TaskOperation {
	if (tokens.length === 0) throw new Error("update requires an id");
	const [id, ...rest] = tokens;
	const options = parseOptions(rest, new Set(["--title", "--status", "--priority", "--notes", "--depends", "--dependencies"]));
	if (options.positionals.length > 0) throw new Error(`Unexpected update argument: ${options.positionals[0]}`);
	const operation: TaskOperation = { action: "update", id };
	const title = options.values.get("--title");
	const status = options.values.get("--status");
	const priority = options.values.get("--priority");
	const notes = options.values.get("--notes");
	const dependencies = options.values.get("--depends") ?? options.values.get("--dependencies");
	if (title !== undefined) operation.title = title;
	if (status !== undefined) operation.status = status as TaskStatus;
	if (priority !== undefined) operation.priority = priority as TaskPriority;
	if (notes !== undefined) operation.notes = notes;
	if (dependencies !== undefined) operation.dependencies = parseDependencies(dependencies);
	return operation;
}

function parseStatus(tokens: string[]): TaskOperation {
	const positionals = onlyPositional(tokens, "status <id> <status>");
	if (positionals.length !== 2) throw new Error("status requires an id and status");
	return { action: "status", id: positionals[0], status: positionals[1] as TaskStatus };
}

function parseIdOnly(action: string, tokens: string[]): TaskOperation {
	const positionals = onlyPositional(tokens, `${action} <id>`);
	if (positionals.length !== 1) throw new Error(`${action} requires exactly one id`);
	const normalized = action === "done" ? "complete" : action;
	return { action: normalized as "complete" | "reopen" | "block" | "archive" | "delete", id: positionals[0] };
}

function onlyPositional(tokens: string[], usage: string): string[] {
	for (const token of tokens) {
		if (token.startsWith("-")) throw new Error(`${usage} does not accept option ${token}`);
	}
	return tokens;
}

function parseDependencies(value: string): string[] {
	return value
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function parseOptions(tokens: string[], allowed: Set<string>): { values: Map<string, string>; positionals: string[] } {
	const values = new Map<string, string>();
	const positionals: string[] = [];

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--") {
			positionals.push(...tokens.slice(i + 1));
			break;
		}

		if (!token.startsWith("--")) {
			positionals.push(token);
			continue;
		}

		const eq = token.indexOf("=");
		const name = eq === -1 ? token : token.slice(0, eq);
		if (!allowed.has(name)) throw new Error(`Unknown option: ${name}`);

		const value = eq === -1 ? tokens[++i] : token.slice(eq + 1);
		if (value === undefined) throw new Error(`${name} requires a value`);
		values.set(name, value);
	}

	return { values, positionals };
}
