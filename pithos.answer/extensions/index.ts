import { complete, StringEnum, type ToolCall, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { getAnswerCommandHelp } from "./command-help.ts";
import { createPithosLogger, errorMetadata, modelMetadata, usageMetadata } from "./logging.ts";

type SelectionMode = "none" | "single" | "multiple";

type ExtractedOption = {
	label: string;
	value?: string;
	description?: string;
};

type ExtractedQuestion = {
	id: string;
	question: string;
	context?: string;
	selection: SelectionMode;
	options: ExtractedOption[];
};

type AnswerResult = {
	questions: ExtractedQuestion[];
	answers: string[];
	selectedOptions: string[][];
};

const TOOL_NAME = "extract_questions";

const ExtractionOptionSchema = Type.Object({
	label: Type.String({ description: "Option label shown to the user" }),
	value: Type.Optional(Type.String({ description: "Machine-readable value; omit to use label" })),
	description: Type.Optional(Type.String({ description: "Short explanation of this option" })),
});

const ExtractionParameters = Type.Object({
	questions: Type.Array(
		Type.Object({
			id: Type.String({ description: "Stable id: q1, q2, q3, ..." }),
			question: Type.String({ description: "Standalone question for the user" }),
			context: Type.Optional(Type.String({ description: "Helpful one-sentence hint explaining why this answer matters" })),
			selection: StringEnum(["none", "single", "multiple"] as const, {
				description: "Whether provided options should allow no selection, exactly one selection, or many selections",
			}),
			options: Type.Optional(Type.Array(ExtractionOptionSchema, { description: "Options offered by the assistant, if any" })),
		}),
	),
});

const EXTRACTION_TOOL = {
	name: TOOL_NAME,
	description: "Return structured questions extracted from the assistant response.",
	parameters: ExtractionParameters,
};

const EXTRACTION_PROMPT = `You extract questions from an assistant message so the user can answer them.

You must call the extract_questions tool exactly once.

Rules:
- Extract direct and implied questions that ask the user for information, choices, preferences, clarification, confirmation, or next-step decisions.
- Preserve the assistant's wording where practical, but make each question standalone.
- Add context when available: a concise hint that helps the user understand why the answer matters or how it will be used.
- Keep questions in the order they appear.
- Use stable ids q1, q2, q3, ...
- If the assistant provides candidate answers/options, include them in options.
- Use selection="single" when the user should pick one option.
- Use selection="multiple" when the user can pick more than one option.
- Use selection="none" when no options are provided or the question is purely free-form.
- If there are no questions for the user to answer, call extract_questions with {"questions":[]}.`;

export default function answer(pi: ExtensionAPI) {
	const log = createPithosLogger();
	log.info("extension.register");
	pi.registerCommand("answer", {
		description: "Extract questions from the last assistant response, answer them in a TUI, then submit the answers",
		handler: async (args, ctx) => {
			log.info("command.answer", { sessionId: (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.(), hasArgs: args.trim().length > 0 });
			const commandHelp = getAnswerCommandHelp(args);
			if (commandHelp) {
				if (ctx.hasUI) ctx.ui.notify(commandHelp, "info");
				else console.log(commandHelp);
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify("/answer requires interactive mode", "error");
				return;
			}

			await ctx.waitForIdle();

			const lastAssistantText = getLastAssistantText(ctx);
			if (!lastAssistantText) {
				ctx.ui.notify("No completed assistant message found", "error");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			const questions = await extractQuestions(ctx, lastAssistantText, log);
			if (questions === null) {
				ctx.ui.notify("Question extraction cancelled", "info");
				return;
			}
			if (questions.length === 0) {
				ctx.ui.notify("No questions found in the last assistant response", "info");
				return;
			}

			const result = await collectAnswers(ctx, questions);
			if (!result) {
				ctx.ui.notify("Answering cancelled", "info");
				return;
			}

			pi.sendUserMessage(compileAnswers(result));
		},
	});
}

function getLastAssistantText(ctx: ExtensionCommandContext): string | null {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;

		const msg = entry.message;
		if (!("role" in msg) || msg.role !== "assistant") continue;
		if (msg.stopReason !== "stop") return null;

		const text = msg.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();

		if (text) return text;
	}
	return null;
}

async function extractQuestions(ctx: ExtensionCommandContext, assistantText: string, log = createPithosLogger()): Promise<ExtractedQuestion[] | null> {
	return ctx.ui.custom<ExtractedQuestion[] | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, `Extracting questions using ${ctx.model!.id}...`);
		loader.onAbort = () => done(null);

		const run = async () => {
			const started = Date.now();
			log.info("model.extract_questions.start", { sessionId: (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.(), ...modelMetadata(ctx.model) });
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
			if (!auth.ok || !auth.apiKey) {
				throw new Error(auth.ok ? `No API key for ${ctx.model!.provider}` : auth.error);
			}

			const userMessage: UserMessage = {
				role: "user",
				content: [{ type: "text", text: assistantText }],
				timestamp: Date.now(),
			};

			const response = await complete(
				ctx.model!,
				{ systemPrompt: EXTRACTION_PROMPT, messages: [userMessage], tools: [EXTRACTION_TOOL] },
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					signal: loader.signal,
					...getToolChoiceOption(ctx.model!),
				},
			);

			if (response.stopReason === "aborted") {
				log.warn("model.extract_questions.aborted", { sessionId: (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.(), durationMs: Date.now() - started, ...modelMetadata(ctx.model), usage: usageMetadata(response.usage) });
				return null;
			}

			const toolCall = response.content.find(
				(part): part is ToolCall => part.type === "toolCall" && part.name === TOOL_NAME,
			);
			if (!toolCall) throw new Error("model did not call extract_questions");

			const questions = normalizeQuestions(toolCall.arguments);
			log.info("model.extract_questions.complete", { sessionId: (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.(), durationMs: Date.now() - started, ...modelMetadata(ctx.model), questionCount: questions.length, usage: usageMetadata(response.usage) });
			return questions;
		};

		run()
			.then(done)
			.catch((error) => {
				log.error("model.extract_questions.error", { sessionId: (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.(), ...modelMetadata(ctx.model), error: errorMetadata(error) });
				ctx.ui.notify(`Question extraction failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				done(null);
			});

		return loader;
	});
}

function getToolChoiceOption(model: { api?: string }): Record<string, unknown> {
	const api = model.api ?? "";
	if (api.includes("anthropic") || api.includes("bedrock")) return { toolChoice: { type: "tool", name: TOOL_NAME } };
	if (api.includes("openai-completions") || api.includes("mistral")) {
		return { toolChoice: { type: "function", function: { name: TOOL_NAME } } };
	}
	if (api.includes("google")) return { toolChoice: "any" };
	return {};
}

function normalizeQuestions(value: unknown): ExtractedQuestion[] {
	if (!value || typeof value !== "object") throw new Error("tool arguments must be an object");
	const questions = (value as { questions?: unknown }).questions;
	if (!Array.isArray(questions)) throw new Error("tool arguments must contain a questions array");

	return questions
		.map((item, index): ExtractedQuestion | null => {
			if (!item || typeof item !== "object") return null;
			const record = item as Record<string, unknown>;
			const question = typeof record.question === "string" ? record.question.trim() : "";
			if (!question) return null;
			const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : `q${index + 1}`;
			const context = typeof record.context === "string" && record.context.trim() ? record.context.trim() : undefined;
			const options = normalizeOptions(record.options);
			const selection = normalizeSelection(record.selection, options);
			return { id, question, context, options, selection };
		})
		.filter((q): q is ExtractedQuestion => q !== null);
}

function normalizeOptions(value: unknown): ExtractedOption[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((item): ExtractedOption | null => {
			if (typeof item === "string") return item.trim() ? { label: item.trim() } : null;
			if (!item || typeof item !== "object") return null;
			const record = item as Record<string, unknown>;
			const label = typeof record.label === "string" ? record.label.trim() : "";
			if (!label) return null;
			const option: ExtractedOption = { label };
			if (typeof record.value === "string" && record.value.trim()) option.value = record.value.trim();
			if (typeof record.description === "string" && record.description.trim()) option.description = record.description.trim();
			return option;
		})
		.filter((option): option is ExtractedOption => option !== null);
}

function normalizeSelection(value: unknown, options: ExtractedOption[]): SelectionMode {
	if (options.length === 0) return "none";
	return value === "multiple" || value === "single" ? value : "single";
}

async function collectAnswers(ctx: ExtensionCommandContext, questions: ExtractedQuestion[]): Promise<AnswerResult | null> {
	return ctx.ui.custom<AnswerResult | null>((tui, theme, _kb, done) => {
		let current = 0;
		let cursor = 0;
		let optionCursor = 0;
		let optionFocus = false;
		let focused = false;
		let cachedLines: string[] | undefined;
		let cachedWidth: number | undefined;
		const answers = Array.from({ length: questions.length }, () => "");
		const selectedOptions = questions.map((): number[] => []);

		function questionAnswered(index: number) {
			return answers[index].trim().length > 0 || selectedOptions[index].length > 0;
		}

		function allAnswered() {
			return questions.every((_q, index) => questionAnswered(index));
		}

		function refresh() {
			cachedLines = undefined;
			cachedWidth = undefined;
			tui.requestRender();
		}

		function goTo(next: number) {
			current = Math.max(0, Math.min(questions.length - 1, next));
			cursor = answers[current].length;
			optionCursor = Math.min(optionCursor, Math.max(0, questions[current].options.length - 1));
			optionFocus = false;
			refresh();
		}

		function submitIfReady() {
			if (allAnswered()) {
				done({
					questions,
					answers,
					selectedOptions: selectedOptions.map((selected, questionIndex) =>
						selected.map((optionIndex) => questions[questionIndex].options[optionIndex]?.label).filter((label): label is string => !!label),
					),
				});
			} else {
				const firstMissing = questions.findIndex((_q, index) => !questionAnswered(index));
				goTo(firstMissing >= 0 ? firstMissing : current);
			}
		}

		function insertText(text: string) {
			const answer = answers[current];
			answers[current] = answer.slice(0, cursor) + text + answer.slice(cursor);
			cursor += text.length;
			refresh();
		}

		function toggleCurrentOption() {
			const q = questions[current];
			if (q.options.length === 0 || q.selection === "none") return;
			if (q.selection === "single") {
				selectedOptions[current] = [optionCursor];
			} else {
				const selected = selectedOptions[current];
				selectedOptions[current] = selected.includes(optionCursor)
					? selected.filter((index) => index !== optionCursor)
					: [...selected, optionCursor].sort((a, b) => a - b);
			}
			refresh();
		}

		function handleInput(data: string) {
			const q = questions[current];
			if (matchesKey(data, Key.escape)) {
				done(null);
				return;
			}
			if (matchesKey(data, Key.tab)) {
				goTo(current + 1);
				return;
			}
			if (matchesKey(data, Key.shift("tab"))) {
				goTo(current - 1);
				return;
			}
			if (matchesKey(data, Key.ctrl("s"))) {
				submitIfReady();
				return;
			}
			if (matchesKey(data, Key.shift("enter")) || matchesKey(data, Key.alt("enter"))) {
				optionFocus = false;
				insertText("\n");
				return;
			}
			if (matchesKey(data, Key.enter)) {
				if (optionFocus) {
					toggleCurrentOption();
					return;
				}
				if (current === questions.length - 1 && allAnswered()) submitIfReady();
				else goTo(current + 1);
				return;
			}
			if (matchesKey(data, Key.up) && q.options.length > 0) {
				optionFocus = true;
				optionCursor = Math.max(0, optionCursor - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down) && q.options.length > 0) {
				optionFocus = true;
				optionCursor = Math.min(q.options.length - 1, optionCursor + 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.space) && optionFocus) {
				toggleCurrentOption();
				return;
			}
			if (matchesKey(data, Key.left)) {
				optionFocus = false;
				cursor = Math.max(0, cursor - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.right)) {
				optionFocus = false;
				cursor = Math.min(answers[current].length, cursor + 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.home)) {
				optionFocus = false;
				cursor = 0;
				refresh();
				return;
			}
			if (matchesKey(data, Key.end)) {
				optionFocus = false;
				cursor = answers[current].length;
				refresh();
				return;
			}
			if (matchesKey(data, Key.backspace)) {
				optionFocus = false;
				if (cursor > 0) {
					const answer = answers[current];
					answers[current] = answer.slice(0, cursor - 1) + answer.slice(cursor);
					cursor--;
					refresh();
				}
				return;
			}
			if (matchesKey(data, Key.delete)) {
				optionFocus = false;
				const answer = answers[current];
				if (cursor < answer.length) {
					answers[current] = answer.slice(0, cursor) + answer.slice(cursor + 1);
					refresh();
				}
				return;
			}

			if (!data.startsWith("\x1b") && data.length > 0) {
				optionFocus = false;
				const printable = Array.from(data.replace(/\r\n/g, "\n").replace(/\r/g, "\n"))
					.filter((char) => {
						const code = char.codePointAt(0) ?? 0;
						return char === "\n" || (code >= 32 && code !== 127);
					})
					.join("");
				if (printable) insertText(printable);
			}
		}

		function render(width: number): string[] {
			if (cachedLines && cachedWidth === width) return cachedLines;

			const innerWidth = Math.max(28, Math.min(width - 6, 92));
			const lines: string[] = [];
			const q = questions[current]!;
			const answeredCount = questions.filter((_q, index) => questionAnswered(index)).length;
			const answered = questions.map((_q, index) => questionAnswered(index));
			const states = renderQuestionStates(questions.length, current, answered, theme);
			const ready = allAnswered();

			lines.push(centerCardLine(width, cardBorder("top", innerWidth, theme)));
			lines.push(
				centerCardLine(
					width,
					cardLineColumns(
						theme.fg("accent", theme.bold("Answer questions")),
						`${states}  ${theme.fg(ready ? "success" : "dim", `${answeredCount}/${questions.length}`)}`,
						innerWidth,
						theme,
					),
				),
			);
			lines.push(centerCardLine(width, cardBorder("separator", innerWidth, theme)));

			for (const line of wrapTextWithAnsi(`${theme.fg("accent", theme.bold("Q:"))} ${theme.fg("text", q.question)}`, innerWidth)) {
				lines.push(centerCardLine(width, cardLine(line, innerWidth, theme)));
			}
			if (q.context) {
				lines.push(centerCardLine(width, cardLine("", innerWidth, theme)));
				for (const line of wrapTextWithAnsi(`${theme.fg("muted", "›")} ${theme.fg("muted", q.context)}`, innerWidth)) {
					lines.push(centerCardLine(width, cardLine(line, innerWidth, theme)));
				}
			}

			if (q.options.length > 0) {
				lines.push(centerCardLine(width, cardLine("", innerWidth, theme)));
				const mode = q.selection === "multiple" ? "choose one or more" : "choose one";
				lines.push(centerCardLine(width, cardLine(theme.fg("dim", `Options · ${mode}`), innerWidth, theme)));
				for (let i = 0; i < q.options.length; i++) {
					for (const line of renderOptionLines(q.options[i], q.selection, selectedOptions[current].includes(i), optionFocus && i === optionCursor, innerWidth, theme)) {
						lines.push(centerCardLine(width, cardLine(line, innerWidth, theme)));
					}
				}
			}

			lines.push(centerCardLine(width, cardLine("", innerWidth, theme)));
			for (const line of renderAnswerLines(answers[current], cursor, focused && !optionFocus, innerWidth, theme)) {
				lines.push(centerCardLine(width, cardLine(line, innerWidth, theme)));
			}
			lines.push(centerCardLine(width, cardBorder("separator", innerWidth, theme)));

			const help = q.options.length > 0
				? "Type anytime • ↑↓ options • Space/Enter select • Shift+Enter/Alt+Enter newline • Tab next • Ctrl+S submit • Esc cancel"
				: "Type answer • Shift+Enter/Alt+Enter newline • Tab next • Shift+Tab previous • Enter next/submit • Esc cancel";
			for (const line of wrapTextWithAnsi(theme.fg("dim", help), innerWidth)) {
				lines.push(centerCardLine(width, cardLine(line, innerWidth, theme)));
			}
			lines.push(centerCardLine(width, cardBorder("bottom", innerWidth, theme)));

			cachedLines = lines;
			cachedWidth = width;
			return lines;
		}

		return {
			get focused() {
				return focused;
			},
			set focused(value: boolean) {
				focused = value;
			},
			render,
			invalidate: () => {
				cachedLines = undefined;
				cachedWidth = undefined;
			},
			handleInput,
		};
	});
}

function renderQuestionStates(count: number, current: number, answered: boolean[], theme: any): string {
	const chunks: string[] = [];
	for (let i = 0; i < count; i++) {
		if (i === current) chunks.push(theme.fg(answered[i] ? "success" : "accent", "◉"));
		else if (answered[i]) chunks.push(theme.fg("success", "●"));
		else chunks.push(theme.fg("muted", "○"));
	}
	return chunks.join(" ");
}

function renderOptionLines(option: ExtractedOption, selection: SelectionMode, selected: boolean, focused: boolean, innerWidth: number, theme: any): string[] {
	const marker = selection === "multiple" ? (selected ? "☑" : "☐") : selected ? "◉" : "○";
	const markerColor = selected ? "success" : focused ? "accent" : "muted";
	const labelText = `${focused ? "› " : "  "}${marker} ${option.label}`;
	const label = focused
		? theme.bg("selectedBg", theme.fg("text", padVisible(labelText, innerWidth)))
		: `${focused ? theme.fg("accent", "› ") : "  "}${theme.fg(markerColor, marker)} ${theme.fg(selected ? "success" : "text", option.label)}`;
	const lines = wrapTextWithAnsi(label, innerWidth);
	if (option.description) {
		for (const line of wrapTextWithAnsi(`    ${theme.fg("muted", option.description)}`, innerWidth)) lines.push(line);
	}
	return lines;
}

function renderAnswerLines(answer: string, cursor: number, focused: boolean, innerWidth: number, theme: any): string[] {
	const prefix = `${theme.fg("accent", theme.bold("A:"))} `;
	if (!answer && !focused) return wrapTextWithAnsi(`${prefix}${theme.fg("dim", "type your answer…")}`, innerWidth);

	const before = answer.slice(0, cursor);
	const after = answer.slice(cursor);
	const cursorText = focused ? `${CURSOR_MARKER}${theme.fg("accent", "_")}` : "";
	return wrapTextWithAnsi(`${prefix}${theme.fg("text", before)}${cursorText}${theme.fg("text", after)}`, innerWidth);
}

function cardBorder(kind: "top" | "separator" | "bottom", innerWidth: number, theme: any): string {
	if (kind === "top") return theme.fg("accent", `╭${"─".repeat(innerWidth + 2)}╮`);
	if (kind === "bottom") return theme.fg("accent", `╰${"─".repeat(innerWidth + 2)}╯`);
	return theme.fg("borderMuted", `├${"─".repeat(innerWidth + 2)}┤`);
}

function cardLine(content: string, innerWidth: number, theme: any): string {
	const truncated = truncateToWidth(content, innerWidth, "");
	return theme.fg("accent", "│ ") + padVisible(truncated, innerWidth) + theme.fg("accent", " │");
}

function cardLineColumns(left: string, right: string, innerWidth: number, theme: any): string {
	const gap = Math.max(1, innerWidth - visibleWidth(left) - visibleWidth(right));
	if (gap > 1) return cardLine(`${left}${" ".repeat(gap)}${right}`, innerWidth, theme);
	return cardLine(`${left} ${right}`, innerWidth, theme);
}

function centerCardLine(width: number, line: string): string {
	const pad = Math.max(0, Math.floor((width - visibleWidth(line)) / 2));
	return `${" ".repeat(pad)}${truncateToWidth(line, width)}`;
}

function padVisible(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function compileAnswers(result: AnswerResult): string {
	const lines = ["Here are my answers to your questions:", ""];
	for (let i = 0; i < result.questions.length; i++) {
		const question = result.questions[i]!;
		const answer = result.answers[i]!.trim();
		const selected = result.selectedOptions[i] ?? [];
		lines.push(`${i + 1}. ${question.question}`);
		if (selected.length > 0) lines.push(`Selected option${selected.length === 1 ? "" : "s"}: ${selected.join(", ")}`);
		if (answer) lines.push(`Answer: ${answer}`);
		if (!answer && selected.length === 0) lines.push("Answer: (no response)");
		if (i < result.questions.length - 1) lines.push("");
	}
	return lines.join("\n");
}
