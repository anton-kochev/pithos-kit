import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, DynamicBorder, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, matchesKey, SelectList, Spacer, Text, type SelectItem } from "@earendil-works/pi-tui";
import { ASK_HELP, getEchoCommandHelp } from "./command-help";
import { createPithosLogger, errorMetadata, usageMetadata } from "./logging";

type QaUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
};

type AskOptions = {
	question: string;
	model?: string;
};

type QaResult = {
	question: string;
	answer: string;
	exitCode: number;
	stderr: string;
	model?: string;
	usage: QaUsage;
	tools?: string[];
	sessionSnapshot?: {
		entries: number;
		truncated: boolean;
	};
	options?: Omit<AskOptions, "question">;
	stopReason?: string;
	errorMessage?: string;
};

const HISTORY_CUSTOM_TYPE = "echo.history";
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const INLINE_RECENT_MESSAGES = 8;
const MAX_INLINE_SESSION_CHARS = 12_000;
const MAX_INLINE_MESSAGE_CHARS = 2_500;
const MAX_SNAPSHOT_FILE_CHARS = 2_000_000;
const MAX_SNAPSHOT_MESSAGE_CHARS = 100_000;

function formatCount(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

function formatUsage(result: Pick<QaResult, "usage" | "model">): string {
	const parts: string[] = [];
	if (result.usage.turns) parts.push(`${result.usage.turns} turn${result.usage.turns === 1 ? "" : "s"}`);
	if (result.usage.input) parts.push(`↑${formatCount(result.usage.input)}`);
	if (result.usage.output) parts.push(`↓${formatCount(result.usage.output)}`);
	if (result.usage.cacheRead) parts.push(`R${formatCount(result.usage.cacheRead)}`);
	if (result.usage.cacheWrite) parts.push(`W${formatCount(result.usage.cacheWrite)}`);
	if (result.usage.cost) parts.push(`$${result.usage.cost.toFixed(4)}`);
	if (result.model) parts.push(result.model);
	return parts.join(" ");
}

function tokenizeArgs(input: string): string[] {
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
	if (current) tokens.push(current);
	return tokens;
}

type ParseResult =
	| { type: "ok"; options: AskOptions }
	| { type: "help" }
	| { type: "error"; message: string };

function parseAskArgs(rawArgs: string): ParseResult {
	const tokens = tokenizeArgs(rawArgs.trim());
	let model: string | undefined;
	let questionTokens: string[] = [];

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--") {
			questionTokens = tokens.slice(i + 1);
			break;
		}
		if (token === "--help" || token === "-h") return { type: "help" };
		if (token === "--model") {
			const value = tokens[++i];
			if (!value) return { type: "error", message: `${token} requires a value` };
			model = value;
			continue;
		}
		if (token.startsWith("--model=")) {
			model = token.slice("--model=".length);
			if (!model) return { type: "error", message: "--model requires a value" };
			continue;
		}
		if (token.startsWith("--")) return { type: "error", message: `Unknown /ask option: ${token}` };

		questionTokens = tokens.slice(i);
		break;
	}

	return {
		type: "ok",
		options: {
			question: questionTokens.join(" ").trim(),
			model,
		},
	};
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
	if (text.length <= maxChars) return { text, truncated: false };
	const head = Math.floor(maxChars * 0.35);
	const tail = Math.max(0, maxChars - head - 80);
	return {
		text: `${text.slice(0, head)}\n\n[... ${text.length - head - tail} characters omitted ...]\n\n${text.slice(-tail)}`,
		truncated: true,
	};
}

function contentToText(content: any): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return JSON.stringify(content ?? "");
	return content
		.map((part) => {
			if (part?.type === "text") return part.text ?? "";
			if (part?.type === "thinking") return "[thinking omitted]";
			if (part?.type === "image") return `[image: ${part.mimeType ?? part.mediaType ?? "unknown"}]`;
			if (part?.type === "toolCall") return `[tool call: ${part.name} ${JSON.stringify(part.arguments ?? {})}]`;
			return JSON.stringify(part);
		})
		.filter(Boolean)
		.join("\n");
}

function messageToTranscript(message: any): string {
	switch (message?.role) {
		case "user":
			return `User:\n${contentToText(message.content)}`;
		case "assistant":
			return `Assistant${message.model ? ` (${message.model})` : ""}:\n${contentToText(message.content)}`;
		case "toolResult":
			return `Tool result (${message.toolName ?? "tool"}${message.isError ? ", error" : ""}):\n${contentToText(message.content)}`;
		case "bashExecution":
			return `User bash (${message.exitCode ?? "unknown"}): ${message.command}\n${message.output ?? ""}`;
		case "custom":
			return message.display ? `Custom (${message.customType ?? "extension"}):\n${contentToText(message.content)}` : "";
		case "branchSummary":
			return `Branch summary:\n${message.summary ?? ""}`;
		case "compactionSummary":
			return `Compaction summary:\n${message.summary ?? ""}`;
		default:
			return JSON.stringify(message ?? {});
	}
}

function getSessionMessages(ctx: ExtensionCommandContext): any[] {
	const manager = ctx.sessionManager as any;
	try {
		const built = manager.buildSessionContext?.();
		if (built?.messages && Array.isArray(built.messages)) return built.messages;
	} catch {
		// Fall back to branch serialization below.
	}
	return manager
		.getBranch()
		.filter((entry: any) => entry.type === "message")
		.map((entry: any) => entry.message);
}

type SessionSnapshot = {
	fileText: string;
	inlineText: string;
	entries: number;
	recentCount: number;
	fileTruncated: boolean;
	inlineTruncated: boolean;
};

function buildSessionSnapshot(ctx: ExtensionCommandContext): SessionSnapshot {
	const messages = getSessionMessages(ctx);
	let fileTruncated = false;
	let inlineTruncated = false;

	const renderSection = (message: any, index: number, maxChars: number) => {
		const rendered = messageToTranscript(message).trim();
		if (!rendered) return "";
		const clipped = truncateText(rendered, maxChars);
		return {
			text: `### ${index + 1}. ${message?.role ?? "entry"}\n${clipped.text}`,
			truncated: clipped.truncated,
		};
	};

	const fullParts = messages
		.map((message, index) => {
			const section = renderSection(message, index, MAX_SNAPSHOT_MESSAGE_CHARS);
			if (!section) return "";
			if (section.truncated) fileTruncated = true;
			return section.text;
		})
		.filter(Boolean);

	let fileText = fullParts.join("\n\n---\n\n") || "(current session is empty)";
	const clippedFile = truncateText(fileText, MAX_SNAPSHOT_FILE_CHARS);
	if (clippedFile.truncated) fileTruncated = true;
	fileText = clippedFile.text;

	const recentStart = Math.max(0, messages.length - INLINE_RECENT_MESSAGES);
	const recentMessages = messages.slice(recentStart);
	const inlineParts = recentMessages
		.map((message, offset) => {
			const section = renderSection(message, recentStart + offset, MAX_INLINE_MESSAGE_CHARS);
			if (!section) return "";
			if (section.truncated) inlineTruncated = true;
			return section.text;
		})
		.filter(Boolean);

	let inlineText = inlineParts.join("\n\n---\n\n") || "(current session is empty)";
	const clippedInline = truncateText(inlineText, MAX_INLINE_SESSION_CHARS);
	if (clippedInline.truncated) inlineTruncated = true;
	inlineText = clippedInline.text;

	return {
		fileText,
		inlineText,
		entries: messages.length,
		recentCount: recentMessages.length,
		fileTruncated,
		inlineTruncated,
	};
}

async function writeSessionSnapshotFile(snapshot: SessionSnapshot): Promise<{ dir: string; filePath: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-ask-session-"));
	const filePath = path.join(dir, "current-session.md");
	const header = [
		"# Current session snapshot for /ask",
		"",
		`- Messages: ${snapshot.entries}`,
		`- Snapshot truncated: ${snapshot.fileTruncated ? "yes" : "no"}`,
		`- Generated: ${new Date().toISOString()}`,
		"",
		"This temporary transcript is read-only context for the isolated /ask side agent.",
		"",
	].join("\n");
	await fs.promises.writeFile(filePath, header + snapshot.fileText, { encoding: "utf8", mode: 0o600 });
	return { dir, filePath };
}

function buildPrompt(options: AskOptions, snapshot: SessionSnapshot, snapshotFilePath: string): string {
	return [
		"Answer this user question in an isolated side-channel session.",
		"You have read-only access only. You may inspect project files with read, grep, find, and ls, but you must not modify files or run shell commands.",
		"Use progressive disclosure for the main session context:",
		"1. Start with the recent-session excerpt included below.",
		`2. If the question needs older or more precise conversation history, inspect the full temporary session transcript at: ${snapshotFilePath}`,
		"3. Prefer grep/find/read targeted ranges over reading the whole transcript when possible.",
		"Do not mention the temporary transcript path unless the user asks for implementation details.",
		"This side-channel answer will be shown to the user only; it will not be injected into the main agent context.",
		"If you cannot answer confidently, say what information is missing rather than guessing.",
		"",
		`Recent session excerpt (${snapshot.recentCount} of ${snapshot.entries} messages${snapshot.inlineTruncated ? ", truncated" : ""}):`,
		"<recent_session>",
		snapshot.inlineText,
		"</recent_session>",
		"",
		`Question: ${options.question}`,
	].join("\n");
}

async function runSideQuestion(
	options: AskOptions,
	ctx: ExtensionCommandContext,
	signal?: AbortSignal,
): Promise<QaResult> {
	const args = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-extensions",
		"--no-context-files",
		"--no-skills",
		"--no-prompt-templates",
		"--tools",
		READ_ONLY_TOOLS.join(","),
	];

	const selectedModel = options.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
	if (selectedModel) args.push("--model", selectedModel);

	const sessionSnapshot = buildSessionSnapshot(ctx);
	const snapshotFile = await writeSessionSnapshotFile(sessionSnapshot);
	args.push(buildPrompt(options, sessionSnapshot, snapshotFile.filePath));

	const result: QaResult = {
		question: options.question,
		answer: "",
		exitCode: 0,
		stderr: "",
		model: selectedModel,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		tools: [...READ_ONLY_TOOLS],
		sessionSnapshot: { entries: sessionSnapshot.entries, truncated: sessionSnapshot.fileTruncated },
		options: { model: options.model },
	};

	const invocation = getPiInvocation(args);
	let wasAborted = false;

	result.exitCode = await new Promise<number>((resolve) => {
		const proc = spawn(invocation.command, invocation.args, {
			cwd: ctx.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, PI_SKIP_VERSION_CHECK: "1" },
		});

		let buffer = "";
		let closed = false;
		let killTimer: NodeJS.Timeout | undefined;
		let abortHandler: (() => void) | undefined;

		const cleanup = () => {
			closed = true;
			if (killTimer) clearTimeout(killTimer);
			if (abortHandler) signal?.removeEventListener("abort", abortHandler);
		};

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}

			if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
				result.answer += event.assistantMessageEvent.delta ?? "";
			}

			if (event.type === "message_end" && event.message?.role === "assistant") {
				result.usage.turns++;
				result.model = event.message.model ?? result.model;
				result.stopReason = event.message.stopReason ?? result.stopReason;
				result.errorMessage = event.message.errorMessage ?? result.errorMessage;
				const usage = event.message.usage;
				if (usage) {
					result.usage.input += usage.input || 0;
					result.usage.output += usage.output || 0;
					result.usage.cacheRead += usage.cacheRead || 0;
					result.usage.cacheWrite += usage.cacheWrite || 0;
					result.usage.cost += usage.cost?.total || 0;
				}

				if (!result.answer.trim() && Array.isArray(event.message.content)) {
					result.answer = event.message.content
						.filter((part: any) => part?.type === "text" && typeof part.text === "string")
						.map((part: any) => part.text)
						.join("\n");
				}
			}

			if (event.type === "error") {
				result.errorMessage = event.error?.message ?? event.message ?? result.errorMessage;
			}
		};

		proc.stdout.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});

		proc.stderr.on("data", (data) => {
			result.stderr += data.toString();
		});

		proc.on("close", (code) => {
			cleanup();
			if (buffer.trim()) processLine(buffer);
			resolve(code ?? 0);
		});

		proc.on("error", (error) => {
			cleanup();
			result.stderr += String(error?.message ?? error);
			resolve(1);
		});

		const kill = () => {
			if (closed) return;
			wasAborted = true;
			proc.kill("SIGTERM");
			killTimer = setTimeout(() => {
				if (!closed) proc.kill("SIGKILL");
			}, 3000);
			killTimer.unref?.();
		};

		abortHandler = kill;
		if (signal?.aborted) kill();
		else signal?.addEventListener("abort", kill, { once: true });
	});

	try {
		await fs.promises.rm(snapshotFile.dir, { recursive: true, force: true });
	} catch {
		// Best-effort cleanup of the temporary session transcript.
	}

	if (wasAborted) throw new Error("Echo was aborted");
	result.answer = result.answer.trim();
	if (result.exitCode !== 0 && !result.answer) {
		throw new Error(
			result.errorMessage || result.stderr.trim().split("\n").slice(-4).join("\n") || `Side agent exited with ${result.exitCode}`,
		);
	}
	return result;
}

async function showMarkdown(title: string, markdown: string, ctx: ExtensionCommandContext) {
	if (!ctx.hasUI) {
		console.log(markdown);
		return;
	}

	await ctx.ui.custom((_tui, theme, _kb, done) => {
		const container = new Container();
		const border = new DynamicBorder((s: string) => theme.fg("accent", s));
		container.addChild(border);
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		container.addChild(new Spacer(1));
		container.addChild(new Markdown(markdown, 1, 0, getMarkdownTheme()));
		container.addChild(new Text(theme.fg("dim", "Press Enter or Esc to close"), 1, 0));
		container.addChild(border);

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (matchesKey(data, "enter") || matchesKey(data, "escape")) done(undefined);
				return true;
			},
		};
	});
}

async function showAnswer(result: QaResult, ctx: ExtensionCommandContext) {
	if (!ctx.hasUI) {
		console.log(result.answer);
		return;
	}

	const usage = formatUsage(result);
	await ctx.ui.custom((_tui, theme, _kb, done) => {
		const container = new Container();
		const border = new DynamicBorder((s: string) => theme.fg("accent", s));
		container.addChild(border);
		container.addChild(new Text(theme.fg("accent", theme.bold("Echo (isolated)")), 1, 0));
		container.addChild(new Text(theme.fg("muted", `Q: ${result.question}`), 1, 0));
		container.addChild(new Text(theme.fg("dim", `Tools: ${result.tools?.join(",") || "none"}`), 1, 0));
		container.addChild(new Spacer(1));
		container.addChild(new Markdown(result.answer || "(no answer)", 1, 0, getMarkdownTheme()));
		if (result.errorMessage) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("error", result.errorMessage), 1, 0));
		}
		if (result.stderr.trim()) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("warning", result.stderr.trim().split("\n").slice(-4).join("\n")), 1, 0));
		}
		if (usage) container.addChild(new Text(theme.fg("dim", usage), 1, 0));
		container.addChild(new Text(theme.fg("dim", "Press Enter or Esc to close"), 1, 0));
		container.addChild(border);

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (matchesKey(data, "enter") || matchesKey(data, "escape")) done(undefined);
				return true;
			},
		};
	});
}

async function askWithOptionalLoader(options: AskOptions, ctx: ExtensionCommandContext): Promise<QaResult | null> {
	if (!ctx.hasUI) return runSideQuestion(options, ctx, ctx.signal);

	type LoaderResult = QaResult | { error: string } | null;
	const modelLabel = options.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "default model");
	const toolsLabel = READ_ONLY_TOOLS.join(",");

	const loaderResult = await ctx.ui.custom<LoaderResult>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, `Asking isolated agent (${modelLabel}; ${toolsLabel}; current session)...`, {
			cancellable: true,
		});
		let finished = false;
		const finish = (value: LoaderResult) => {
			if (finished) return;
			finished = true;
			done(value);
		};

		loader.onAbort = () => finish(null);
		runSideQuestion(options, ctx, loader.signal)
			.then((result) => finish(result))
			.catch((error) => {
				if (loader.signal.aborted) finish(null);
				else finish({ error: error instanceof Error ? error.message : String(error) });
			});

		return loader;
	});

	if (loaderResult === null) return null;
	if ("error" in loaderResult) throw new Error(loaderResult.error);
	return loaderResult;
}

export default function echo(pi: ExtensionAPI) {
	const log = createPithosLogger();
	log.info("extension.register");
	pi.registerCommand("ask", {
		description: "Ask Echo, an isolated read-only side agent; answer is not added to the main LLM context",
		handler: async (args, ctx) => {
			log.info("command.ask", { sessionId: (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.(), hasArgs: args.trim().length > 0 });
			const commandHelp = getEchoCommandHelp("ask", args);
			if (commandHelp) {
				await showMarkdown("/ask help", commandHelp, ctx);
				return;
			}

			const parsed = parseAskArgs(args);
			if (parsed.type === "help") {
				await showMarkdown("/ask help", ASK_HELP, ctx);
				return;
			}
			if (parsed.type === "error") {
				if (ctx.hasUI) ctx.ui.notify(`${parsed.message}. Use /ask --help for usage.`, "error");
				else console.error(parsed.message);
				return;
			}

			const options = parsed.options;
			if (!options.question) {
				const question = ctx.hasUI
					? await ctx.ui.input("Ask isolated question:", "What do you want to know?")
					: undefined;
				if (!question?.trim()) return;
				options.question = question.trim();
			}

			ctx.ui.setStatus("echo", "asking…");
			const started = Date.now();
			try {
				const result = await askWithOptionalLoader(options, ctx);
				if (!result) {
					if (ctx.hasUI) ctx.ui.notify("Echo cancelled", "info");
					return;
				}

				log.info("command.ask.complete", { sessionId: (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.(), durationMs: Date.now() - started, model: result.model, exitCode: result.exitCode, stopReason: result.stopReason, usage: usageMetadata({ ...result.usage, turns: result.usage.turns }) });
				pi.appendEntry(HISTORY_CUSTOM_TYPE, { ...result, timestamp: Date.now() });
				if (ctx.hasUI) {
					ctx.ui.setWidget("echo", undefined);
					ctx.ui.setWidget("session-qa", undefined);
				}
				await showAnswer(result, ctx);
			} catch (error) {
				log.error("command.ask.error", { sessionId: (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.(), durationMs: Date.now() - started, error: errorMetadata(error) });
				const message = error instanceof Error ? error.message : String(error);
				if (ctx.hasUI) ctx.ui.notify(`Echo failed: ${message}`, "error");
				else console.error(`Echo failed: ${message}`);
			} finally {
				ctx.ui.setStatus("echo", undefined);
			}
		},
	});

	pi.registerCommand("ask-clear", {
		description: "Hide any stale Echo answer widget",
		handler: async (args, ctx) => {
			log.info("command.ask-clear", { sessionId: (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.() });
			const commandHelp = getEchoCommandHelp("ask-clear", args);
			if (commandHelp) {
				await showMarkdown("/ask-clear help", commandHelp, ctx);
				return;
			}

			if (ctx.hasUI) {
				ctx.ui.setWidget("echo", undefined);
				ctx.ui.setWidget("session-qa", undefined);
			}
		},
	});

	const showAskedHistory = async (_args: string, ctx: ExtensionCommandContext) => {
		log.info("command.asked", { sessionId: (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.() });
		const items = ctx.sessionManager
			.getEntries()
			.filter((entry: any) => entry.type === "custom" && entry.customType === HISTORY_CUSTOM_TYPE)
			.map((entry: any) => entry.data as QaResult & { timestamp?: number });

		if (items.length === 0) {
			if (ctx.hasUI) ctx.ui.notify("No Echo history yet", "info");
			return;
		}

		if (!ctx.hasUI) {
			const markdown = [...items]
				.reverse()
				.map((item, index) => {
					const when = item.timestamp ? new Date(item.timestamp).toLocaleString() : "";
					const usage = item.usage ? formatUsage(item) : "";
					const metadata = [when, usage].filter(Boolean).join(" · ");
					return `## ${items.length - index}. ${item.question}${metadata ? `\n_${metadata}_` : ""}\n\n${item.answer}`;
				})
				.join("\n\n---\n\n");
			console.log(markdown);
			return;
		}

		const newestFirst = [...items].reverse();
		const selectItems: SelectItem[] = newestFirst.map((item, index) => {
			const when = item.timestamp ? new Date(item.timestamp).toLocaleString() : "";
			const usage = item.usage ? formatUsage(item) : "";
			return {
				value: String(index),
				label: item.question,
				description: [when, usage].filter(Boolean).join(" · "),
			};
		});

		const selectedIndex = await ctx.ui.custom<number | null>((tui, theme, _kb, done) => {
			const container = new Container();
			const border = new DynamicBorder((s: string) => theme.fg("accent", s));
			container.addChild(border);
			container.addChild(new Text(theme.fg("accent", theme.bold("Echo History")), 1, 0));
			const selectList = new SelectList(selectItems, Math.min(selectItems.length, 12), {
				selectedPrefix: (s: string) => theme.fg("accent", s),
				selectedText: (s: string) => theme.fg("accent", s),
				description: (s: string) => theme.fg("muted", s),
				scrollInfo: (s: string) => theme.fg("dim", s),
				noMatch: (s: string) => theme.fg("warning", s),
			});
			selectList.onSelect = (item) => done(Number(item.value));
			selectList.onCancel = () => done(null);
			container.addChild(selectList);
			container.addChild(new Text(theme.fg("dim", "↑↓ navigate • Enter open • Esc cancel"), 1, 0));
			container.addChild(border);
			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					selectList.handleInput(data);
					tui.requestRender();
					return true;
				},
			};
		});

		if (selectedIndex === null || selectedIndex === undefined) return;
		await showAnswer(newestFirst[selectedIndex], ctx);
	};

	pi.registerCommand("asked", {
		description: "Interactively browse previous /ask answers",
		handler: async (args, ctx) => {
			const commandHelp = getEchoCommandHelp("asked", args);
			if (commandHelp) {
				await showMarkdown("/asked help", commandHelp, ctx);
				return;
			}
			await showAskedHistory(args, ctx);
		},
	});

}
