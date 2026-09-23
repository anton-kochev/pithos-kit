import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTask, childTools, LIMITS, renderReport, type GuildReport } from "./protocol.ts";
import { ResultStream } from "./result-stream.ts";
import {
	type GuildProfile,
	type GuildRole,
} from "./agents.ts";

export interface RunUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface GuildRunState {
	task: string;
	output: string;
	exitCode: number;
	stderr: string;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	activity: string;
	activityTool?: string;
	usage: RunUsage;
}

export interface GuildRoleRunResult extends GuildRunState {
	role: GuildRole;
	profile: GuildProfile;
	runId?: string;
	taskId?: string;
	status?: "completed" | "failed" | "cancelled";
	report?: GuildReport;
	usageKnown?: boolean;
	/** Fields with at least one finite child observation; totals may be partial. */
	usageFields?: Array<keyof RunUsage>;
}

export interface RunGuildRoleOptions {
	/** Parent tool-call or direct-command ID for protocol correlation. */
	runId?: string;
	role: GuildRole;
	profile: GuildProfile;
	task: string;
	cwd: string;
	model?: string;
	thinkingLevel?: string;
	projectTrusted: boolean;
	signal?: AbortSignal;
	onUpdate?: (result: GuildRoleRunResult) => void;
}

function buildGuildRoleChildArguments(
	options: RunGuildRoleOptions,
	baseSystemPromptFile: string,
	roleProfileSystemPromptFile: string,
): string[] {
	const args = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		options.projectTrusted ? "--approve" : "--no-approve",
		"--tools",
		childTools(options.role).join(","),
		"--extension",
		fileURLToPath(new URL("./child-protocol.ts", import.meta.url)),
	];
	if (options.model) args.push("--model", options.model);
	if (options.thinkingLevel) args.push("--thinking", options.thinkingLevel);
	args.push(
		"--system-prompt",
		baseSystemPromptFile,
		"--append-system-prompt",
		roleProfileSystemPromptFile,
		`Task: ${options.task}`,
	);
	return args;
}

function createEmptyRunState(task: string): GuildRunState {
	return {
		task,
		output: "",
		exitCode: 0,
		stderr: "",
		activity: "Starting handover",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 0,
			turns: 0,
		},
	};
}

export function createEmptyGuildRoleRunResult(
	role: GuildRole,
	profile: GuildProfile,
	task: string,
): GuildRoleRunResult {
	return { role, profile, ...createEmptyRunState(task) };
}

function finalizedText(message: any): string {
	if (!Array.isArray(message?.content)) return "";
	return message.content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n");
}

function toolActivity(toolName: string): string {
	switch (toolName) {
		case "read": return "Reading file";
		case "grep": return "Searching code";
		case "find": return "Scanning repository";
		case "ls": return "Listing directory";
		case "edit":
		case "write": return "Editing files";
		case "bash": return "Running verification";
		default: return toolName ? `Using ${toolName}` : "Working";
	}
}

export function applyJsonEvent(result: GuildRoleRunResult, event: any): void {
	if (event?.type === "tool_execution_start") {
		result.activityTool = typeof event.toolName === "string" ? event.toolName : undefined;
		result.activity = toolActivity(result.activityTool ?? "");
		return;
	}

	if (event?.type === "tool_execution_end") {
		result.activityTool = undefined;
		result.activity = "Thinking";
		return;
	}

	if (event?.type === "message_start" && event.message?.role === "assistant") {
		result.output = "";
		result.activity = "Thinking";
		return;
	}

	if (event?.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
		result.output = truncateUtf8(result.output + (event.assistantMessageEvent.delta ?? ""), LIMITS.result);
		result.activity = "Preparing report";
		return;
	}

	if (event?.type === "message_end" && event.message?.role === "assistant") {
		result.usage.turns++;
		result.model = event.message.model ?? result.model;
		result.stopReason = event.message.stopReason ?? result.stopReason;
		result.errorMessage = event.message.errorMessage ?? result.errorMessage;
		const text = finalizedText(event.message);
		if (text) result.output = truncateUtf8(text, LIMITS.result);

		const usage = event.message.usage;
		if (usage) {
			const observed: Partial<RunUsage> = {...usage, cost: usage.cost?.total, contextTokens: usage.totalTokens};
			const fields = new Set(result.usageFields);
			for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost", "contextTokens"] as const) {
				const value = observed[key];
				if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
				fields.add(key);
				if (key === "contextTokens") result.usage[key] = value;
				else result.usage[key] += value;
			}
			result.usageFields = [...fields];
			result.usageKnown = fields.size > 0;
		}
		return;
	}

	if (event?.type === "error") {
		result.errorMessage = event.error?.message ?? event.message ?? result.errorMessage;
	}
}

export function getRunFailure(result: GuildRoleRunResult): string | null {
	const failedStop = result.stopReason === "error" || result.stopReason === "aborted";
	if (result.status === "failed" || result.status === "cancelled") return result.errorMessage ?? `Guild handover ${result.status}`;
	if (result.exitCode === 0 && !failedStop && !result.errorMessage) return null;
	return (
		result.errorMessage?.trim() ||
		result.stderr.trim().split("\n").slice(-6).join("\n") ||
		result.output.trim() ||
		`Guild member process exited with code ${result.exitCode}`
	);
}

export function truncateUtf8(value: string, maxBytes: number): string {
	const totalBytes = Buffer.byteLength(value, "utf8");
	if (totalBytes <= maxBytes) return value;

	let kept = "";
	let keptBytes = 0;
	for (const character of value) {
		const characterBytes = Buffer.byteLength(character, "utf8");
		if (keptBytes + characterBytes > maxBytes) break;
		kept += character;
		keptBytes += characterBytes;
	}
	return `${kept}\n\n[Output truncated: ${totalBytes - keptBytes} bytes omitted.]`;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const executableName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(executableName)) return { command: process.execPath, args };
	return { command: "pi", args };
}

interface GuildRolePromptFiles {
	directory: string;
	baseSystemPromptFile: string;
	roleProfileSystemPromptFile: string;
}

const GUILD_ROLE_PROMPT_URLS = {
	explorer: new URL("../agents/roles/explorer.md", import.meta.url),
	architect: new URL("../agents/roles/architect.md", import.meta.url),
	coder: new URL("../agents/roles/coder.md", import.meta.url),
	reviewer: new URL("../agents/roles/reviewer.md", import.meta.url),
} satisfies Record<GuildRole, URL>;

const GUILD_PROFILE_PROMPT_URLS = {
	general: new URL("../agents/profiles/general.md", import.meta.url),
	frontend: new URL("../agents/profiles/frontend.md", import.meta.url),
	angular: new URL("../agents/profiles/angular.md", import.meta.url),
	typescript: new URL("../agents/profiles/typescript.md", import.meta.url),
	dotnet: new URL("../agents/profiles/dotnet.md", import.meta.url),
	rust: new URL("../agents/profiles/rust.md", import.meta.url),
} satisfies Record<GuildProfile, URL>;

function guildRoleBaseSystemPrompt(role: GuildRole, profile: GuildProfile): string {
	return [
		`# Standalone Guild member: ${role}/${profile}`,
		"",
		"Work only on the delegated task. You have an isolated context and cannot ask another member to finish your role.",
		"Treat the tool allowlist as a hard capability boundary.",
	].join("\n");
}

async function writeGuildRoleSystemPrompts(
	role: GuildRole,
	profile: GuildProfile,
): Promise<GuildRolePromptFiles> {
	const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-guild-"));
	const baseSystemPromptFile = path.join(directory, "base.md");
	const roleProfileSystemPromptFile = path.join(directory, `${role}-${profile}.md`);

	try {
		const [rolePrompt, profilePrompt] = await Promise.all([
			fs.promises.readFile(GUILD_ROLE_PROMPT_URLS[role], "utf8"),
			fs.promises.readFile(GUILD_PROFILE_PROMPT_URLS[profile], "utf8"),
		]);
		await fs.promises.writeFile(
			baseSystemPromptFile,
			guildRoleBaseSystemPrompt(role, profile),
			{ encoding: "utf8", mode: 0o600 },
		);
		await fs.promises.writeFile(
			roleProfileSystemPromptFile,
			`${rolePrompt.trimEnd()}\n\n${profilePrompt.trimEnd()}`,
			{ encoding: "utf8", mode: 0o600 },
		);
		return { directory, baseSystemPromptFile, roleProfileSystemPromptFile };
	} catch (error) {
		await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
}

interface GuildChildProcessOptions {
	taskFile: string;
	stream: ResultStream;
	cwd: string;
	signal?: AbortSignal;
	onUpdate?: (result: GuildRoleRunResult) => void;
}

function snapshotRunResult(result: GuildRoleRunResult): GuildRoleRunResult {
	return { ...result, usage: { ...result.usage }, usageFields: result.usageFields?.slice() };
}

async function runGuildChild(
	result: GuildRoleRunResult,
	args: string[],
	options: GuildChildProcessOptions,
): Promise<boolean> {
	const invocation = getPiInvocation(args);
	let wasAborted = false;

	result.exitCode = await new Promise<number>((resolve) => {
		const child = spawn(invocation.command, invocation.args, {
			cwd: options.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, PI_SKIP_VERSION_CHECK: "1", GUILD_TASK_FILE: options.taskFile },
		});
		let closed = false;
		let stopping = false;
		let killTimer: NodeJS.Timeout | undefined;
		let lastUpdate = 0;
		let stderrBytes = 0;
		const emitUpdate = (force = false) => {
			const now = Date.now();
			if (!force && now - lastUpdate < 100) return;
			lastUpdate = now;
			try { options.onUpdate?.(snapshotRunResult(result)); } catch { /* observational */ }
		};
		const stop = () => {
			if (closed || stopping) return;
			stopping = true;
			child.kill("SIGTERM");
			killTimer = setTimeout(() => { if (!closed) child.kill("SIGKILL"); }, 3000);
			killTimer.unref?.();
		};
		const abort = () => { wasAborted = true; stop(); };
		const event = (value: unknown) => { applyJsonEvent(result, value); emitUpdate(); };
		child.stdout.on("data", (chunk: Buffer) => {
			if (closed) return;
			options.stream.push(chunk, event);
			if (options.stream.failure) stop();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (closed) return;
			stderrBytes += chunk.length;
			result.stderr = truncateUtf8(result.stderr + chunk.toString(), LIMITS.stderr);
			if (stderrBytes > LIMITS.stderr) options.stream.fail("Guild stderr byte limit exceeded");
			if (/Extension error|Failed to load extension/i.test(result.stderr)) options.stream.fail("Guild child extension failure");
			if (options.stream.failure) stop();
		});
		child.on("error", (error) => {
			options.stream.fail(error.message);
			result.errorMessage = error.message;
		});
		child.on("close", (code) => {
			if (closed) return;
			closed = true;
			if (killTimer) clearTimeout(killTimer);
			options.signal?.removeEventListener("abort", abort);
			options.stream.end(event);
			emitUpdate(true);
			resolve(code ?? 1);
		});

		if (options.signal?.aborted) abort();
		else options.signal?.addEventListener("abort", abort, { once: true });
	});

	return wasAborted;
}

export async function runGuildRole(options: RunGuildRoleOptions): Promise<GuildRoleRunResult> {
	const result = createEmptyGuildRoleRunResult(options.role, options.profile, options.task);
	result.usageKnown = false;
	result.usageFields = [];
	let stream: ResultStream | undefined;
	result.model = options.model;
	const runId = options.runId ?? randomUUID();
	result.runId = runId;
	result.taskId = randomUUID();
	let prompts: GuildRolePromptFiles | undefined;
	let wasAborted = false;

	try {
		const task = buildTask({ ...options, runId, taskId: result.taskId });
		stream = new ResultStream(task);
		if (options.signal?.aborted) throw new Error("Guild handover cancelled before setup");
		prompts = await writeGuildRoleSystemPrompts(options.role, options.profile);
		const taskFile = path.join(prompts.directory, "task.json");
		await fs.promises.writeFile(taskFile, JSON.stringify(task), {encoding: "utf8", mode: 0o600});
		const args = buildGuildRoleChildArguments(
			options,
			prompts.baseSystemPromptFile,
			prompts.roleProfileSystemPromptFile,
		);
		wasAborted = await runGuildChild(result, args, { ...options, stream, taskFile });
	} catch (error) {
		result.errorMessage = error instanceof Error ? error.message : String(error);
		stream?.fail(result.errorMessage);
	} finally {
		if (prompts) await fs.promises.rm(prompts.directory, { recursive: true, force: true }).catch((error) => {
			result.errorMessage = `Guild cleanup failed: ${String(error).slice(0, 1024)}`;
			stream?.fail(result.errorMessage);
		});
	}

	const terminal = stream?.finish(result.exitCode, wasAborted || options.signal?.aborted === true) ?? {status: options.signal?.aborted ? "cancelled" : "failed", diagnostic: result.errorMessage} as const;
	result.status = terminal.status;
	result.report = "report" in terminal ? terminal.report : undefined;
	result.output = result.report ? renderReport(result.report) : "";
	if (terminal.status !== "completed") result.errorMessage = terminal.diagnostic;
	return result;
}
