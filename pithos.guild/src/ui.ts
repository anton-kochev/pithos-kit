import { getMarkdownTheme, keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Markdown,
	matchesKey,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
} from "@earendil-works/pi-tui";
import {
	isGuildProfile,
	isGuildRole,
	type GuildProfile,
	type GuildRole,
} from "./agents";
import type { GuildRunPhase } from "./visibility";

interface ToolResultLike {
	content?: Array<{ type: string; text?: string }>;
	details?: unknown;
}

interface LifecycleMessageLike {
	content?: string | Array<{ type: string; text?: string }>;
	details?: unknown;
}

function compact(value: string, maxLength = 100): string {
	const text = value.replace(/\s+/g, " ").trim();
	return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function styledPanelLine(line: string, theme: Theme): string {
	if (line.startsWith("⏳ ")) {
		const [member = "guild member", ...metadata] = line.slice("⏳ ".length).split(" · ");
		const queued = metadata[0] === "queued";
		return theme.fg(queued ? "muted" : "warning", queued ? "○" : "●") +
			` ${theme.fg("accent", member)}` +
			(metadata.length > 0 ? theme.fg("dim", ` · ${metadata.join(" · ")}`) : "");
	}
	return theme.fg("muted", line);
}

interface GuildPanelColor {
	r: number;
	g: number;
	b: number;
	ansi256: number;
}

const GUILD_PANEL_LIGHT: GuildPanelColor = { r: 233, g: 221, b: 242, ansi256: 189 };
const GUILD_PANEL_DARK: GuildPanelColor = { r: 45, g: 37, b: 56, ansi256: 236 };

function usesLightGuildPanel(theme: Theme): boolean {
	const name = theme.name?.toLowerCase();
	if (name?.includes("light")) return true;
	if (name?.includes("dark")) return false;
	const match = (theme.getBgAnsi?.("toolPendingBg") ?? "").match(/\[48;2;(\d+);(\d+);(\d+)m/);
	if (!match) return false;
	const [, red = "0", green = "0", blue = "0"] = match;
	return 0.2126 * Number(red) + 0.7152 * Number(green) + 0.0722 * Number(blue) >= 128;
}

export function guildPanelAnsi(theme: Theme): { background: string; foreground: string } {
	const color = usesLightGuildPanel(theme) ? GUILD_PANEL_LIGHT : GUILD_PANEL_DARK;
	if (typeof theme.getColorMode === "function" && theme.getColorMode() === "256color") {
		return {
			background: `\u001b[48;5;${color.ansi256}m`,
			foreground: `\u001b[38;5;${color.ansi256}m`,
		};
	}
	const channels = `${color.r};${color.g};${color.b}`;
	return {
		background: `\u001b[48;2;${channels}m`,
		foreground: `\u001b[38;2;${channels}m`,
	};
}

export function createGuildPanel(lines: string[], theme: Theme, inspection?: { runIds: readonly string[]; inspect(id: string): void }, hint = "↑ select · → expand", selectedIndex?: number): Component {
	return {
		invalidate(): void {},
		handleMouse(event) {
			if (event.type !== "click" || event.button !== "left") return;
			const id = inspection?.runIds[event.y - 2];
			if (!id) return;
			inspection?.inspect(id);
			return { handled: true, render: false };
		},
		render(width: number): string[] {
			if (width <= 0) return [];
			const summary = lines[0]?.replace(/^Guild\s*/, "") ?? "";
			const title = theme.fg("accent", "Guild") + (summary ? theme.fg("muted", ` ${summary}`) : "") + theme.fg("dim", ` · ${hint}`);
			const runs = lines.slice(1).map((line, index) => (index === selectedIndex ? theme.fg("accent", "›") : "") + styledPanelLine(line, theme));
			const { background, foreground } = guildPanelAnsi(theme);
			const edge = (block: "▄" | "▀") => `${foreground}${block.repeat(width)}\u001b[39m`;
			const content = [title, ...runs].map((line) =>
				`${background}${padAnsi(` ${line}`, width)}\u001b[49m`);
			return [edge("▄"), ...content, edge("▀")];
		},
	};
}

export type GuildCallArgs =
	| { role: GuildRole; profile: GuildProfile; task?: string; member?: string }
	| { member?: string; task?: string; role?: never; profile?: never };

export function renderGuildCall(args: GuildCallArgs, theme: Theme): Component {
	const container = new Container();
	const identity = presentationIdentity(args, "selecting…");
	const metadata = [sourceLabel(identity.source), permissionLabel(identity.role)].filter(Boolean).join(" · ");
	container.addChild(new Text(
		theme.fg("toolTitle", theme.bold("✦ Guild  ")) +
			theme.fg("accent", identity.label) +
			(metadata ? theme.fg("dim", ` · ${metadata}`) : ""),
		0,
		0,
	));
	container.addChild(new Text(theme.fg("muted", `↳ ${compact(args.task ?? "Preparing delegated task…")}`), 0, 0));
	return container;
}

function resultText(result: ToolResultLike): string {
	return result.content
		?.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n") ?? "";
}

function usageText(details: unknown): string {
	const parts: string[] = [];
	const elapsedMs = numberField(details, "elapsedMs");
	const usage = recordOf(details)?.usage;
	const turns = numberField(usage, "turns");
	const cost = numberField(usage, "cost");
	if (elapsedMs !== undefined) parts.push(`${(elapsedMs / 1000).toFixed(1)}s`);
	if (turns) parts.push(`${turns} turn${turns === 1 ? "" : "s"}`);
	if (cost) parts.push(`$${cost.toFixed(4)}`);
	if (recordOf(details)?.usageKnown === false) parts.push("usage unknown");
	else if (Array.isArray(recordOf(details)?.usageFields)) parts.push("reported usage (may be partial)");
	return parts.join(" · ");
}

const HANDOVER_CARD_MAX_WIDTH = 100;
const HANDOVER_PROGRESS_MAX_WIDTH = 96;

interface LifecyclePresentation {
	icon: string;
	label: string;
	color: "success" | "error" | "muted" | "warning";
	background: "toolSuccessBg" | "toolErrorBg" | "customMessageBg" | "toolPendingBg";
}

function lifecyclePresentation(status: string, phase: GuildRunPhase | undefined, taskOutcome?: string): LifecyclePresentation {
	if (status === "completed" && taskOutcome === "blocked") return {icon: "!", label: "Blocked", color: "warning", background: "toolPendingBg"};
	if (status === "completed") return { icon: "✓", label: "Completed", color: "success", background: "toolSuccessBg" };
	if (status === "failed") return { icon: "✗", label: "Failed", color: "error", background: "toolErrorBg" };
	if (status === "cancelled") return { icon: "■", label: "Cancelled", color: "muted", background: "customMessageBg" };
	if (phase === "queued") return { icon: "○", label: "Queued", color: "muted", background: "toolPendingBg" };
	return { icon: "●", label: "Running", color: "warning", background: "toolPendingBg" };
}

function padAnsi(value: string, width: number): string {
	const clipped = truncateToWidth(value, Math.max(0, width));
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function joinSides(left: string, right: string, width: number, fill = " "): string {
	const rightWidth = visibleWidth(right);
	let fittedLeft = left;
	if (visibleWidth(fittedLeft) + rightWidth + 1 > width) {
		if (rightWidth >= width) return truncateToWidth(right, width);
		fittedLeft = truncateToWidth(fittedLeft, width - rightWidth - 1);
	}
	return `${fittedLeft}${fill.repeat(Math.max(0, width - visibleWidth(fittedLeft) - rightWidth))}${right}`;
}

interface GuildPresentationIdentity {
	label: string;
	role: GuildRole | undefined;
	source: string | undefined;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
	const field = recordOf(value)?.[key];
	return typeof field === "string" ? field : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
	const field = recordOf(value)?.[key];
	return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function presentationPhase(value: unknown): GuildRunPhase | undefined {
	const phase = stringField(value, "phase");
	if (phase === "queued" || phase === "running") return phase;
	const status = stringField(value, "status");
	return status === "queued" || status === "running" ? status : undefined;
}

function presentationIdentity(value: unknown, fallbackLabel = "guild member"): GuildPresentationIdentity {
	const details = recordOf(value);
	const role = isGuildRole(details?.role) ? details.role : undefined;
	const profile = isGuildProfile(details?.profile) ? details.profile : undefined;
	if (role && profile) {
		return {
			label: `${role}/${profile}`,
			role,
			source: stringField(details, "source") ?? "package",
		};
	}
	return {
		label: stringField(details, "member") ?? fallbackLabel,
		role,
		source: stringField(details, "memberSource"),
	};
}

function sourceLabel(source: string | undefined): string | undefined {
	return source === "builtin" ? "built-in" : source;
}

function permissionLabel(role: GuildRole | undefined): string | undefined {
	return role === "explorer" || role === "architect"
		? "read-only"
		: role === "reviewer"
			? "read-only review"
			: role === "coder"
				? "write-enabled"
				: undefined;
}

function memberSummary(
	member: string,
	source: string | undefined,
	role: GuildRole | undefined,
	theme: Theme,
): string {
	const metadata = [sourceLabel(source), permissionLabel(role)].filter(Boolean).join(" · ");
	return theme.fg("text", `  ${member}`) + (metadata ? theme.fg("dim", ` · ${metadata}`) : "");
}

function requestLines(task: string, width: number, theme: Theme): string[] {
	const rawPrefix = "  Request  ";
	const wrapped = wrapTextWithAnsi(theme.fg("text", task), Math.max(1, width - visibleWidth(rawPrefix)));
	return wrapped.map((line, index) =>
		(index === 0 ? theme.fg("accent", "  Request") + "  " : " ".repeat(visibleWidth(rawPrefix))) + line);
}

function presentationMarkdown(value: string): string {
	return value.replace(/^#{1,6}\s+(.+)$/gm, "**$1**");
}

interface ProgressTui {
	requestRender(): void;
}

interface ProgressKeybindings {
	matches(data: string, binding: "tui.select.cancel"): boolean;
}

interface GuildHandoverProgressBaseOptions {
	task: string;
	startedAt: number;
	phase?: GuildRunPhase;
	// Read-only view ownership is separate from this card's cancellation controller.
	createInspection?: () => Component & { dispose(): void };
}

export interface CanonicalGuildHandoverProgressOptions extends GuildHandoverProgressBaseOptions {
	role: GuildRole;
	profile: GuildProfile;
	source: "package";
	member?: string;
	memberSource?: string;
}

export interface LegacyGuildHandoverProgressOptions extends GuildHandoverProgressBaseOptions {
	member: string;
	memberSource: string;
	role: GuildRole;
	profile?: never;
	source?: never;
}

export type GuildHandoverProgressOptions =
	| CanonicalGuildHandoverProgressOptions
	| LegacyGuildHandoverProgressOptions;

export interface GuildHandoverProgress extends Component {
	readonly signal: AbortSignal;
	update(update: { activity?: string; activityTool?: string; phase?: GuildRunPhase; turns?: number }): void;
	handleInput(data: string): void;
	dispose(): void;
}

class GuildHandoverProgressCard implements GuildHandoverProgress {
	private readonly controller = new AbortController();
	private readonly timer: NodeJS.Timeout;
	private frame = 0;
	private activity = "Starting handover";
	private activityTool: string | undefined;
	private turns = 0;
	private phase: GuildRunPhase;
	private cancelling = false;
	private disposed = false;
	private inspection: (Component & { dispose(): void }) | undefined;

	constructor(
		private readonly options: GuildHandoverProgressOptions,
		private readonly tui: ProgressTui,
		private readonly theme: Theme,
		private readonly keybindings: ProgressKeybindings,
	) {
		this.phase = options.phase ?? "running";
		this.timer = setInterval(() => {
			this.frame = (this.frame + 1) % 10;
			this.tui.requestRender();
		}, 80);
		this.timer.unref?.();
	}

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	update(update: { activity?: string; activityTool?: string; phase?: GuildRunPhase; turns?: number }): void {
		if (update.activity) this.activity = update.activity;
		this.activityTool = update.activityTool;
		if (update.phase) this.phase = update.phase;
		if (update.turns !== undefined) this.turns = update.turns;
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		if (this.inspection) {
			if (matchesKey(data, "f6") || this.keybindings.matches(data, "tui.select.cancel")) {
				this.inspection.dispose();
				this.inspection = undefined;
				this.tui.requestRender();
			} else this.inspection.handleInput?.(data);
			return;
		}
		if (!this.controller.signal.aborted && this.options.createInspection && (matchesKey(data, "f6") || matchesKey(data, "return"))) {
			this.inspection = this.options.createInspection();
			this.tui.requestRender();
			return;
		}
		if (this.controller.signal.aborted || !this.keybindings.matches(data, "tui.select.cancel")) return;
		this.cancelling = true;
		this.activity = "Stopping Guild member";
		this.activityTool = undefined;
		this.controller.abort();
		this.tui.requestRender();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		clearInterval(this.timer);
		this.inspection?.dispose();
		this.inspection = undefined;
	}

	invalidate(): void { this.inspection?.invalidate(); }

	render(width: number): string[] {
		if (this.inspection) return this.inspection.render(Math.min(width, HANDOVER_PROGRESS_MAX_WIDTH));
		const cardWidth = Math.max(2, Math.min(width, HANDOVER_PROGRESS_MAX_WIDTH));
		const innerWidth = Math.max(1, cardWidth - 2);
		const border = (value: string) => this.theme.fg("borderAccent", value);
		const frameLine = (value = "") => `${border("│")}${padAnsi(value, innerWidth)}${border("│")}`;
		const elapsedSeconds = Math.max(0, Math.floor((Date.now() - this.options.startedAt) / 1000));
		const elapsed = `${String(Math.floor(elapsedSeconds / 60)).padStart(2, "0")}:${String(elapsedSeconds % 60).padStart(2, "0")}`;
		const state = this.cancelling
			? "■ Cancelling"
			: this.phase === "queued"
				? `○ Queued  ${elapsed}`
				: `● Running  ${elapsed}`;
		const stateColor = this.cancelling || this.phase === "queued" ? "muted" : "warning";
		const stateBackground = this.cancelling ? "customMessageBg" : "toolPendingBg";
		const pill = this.theme.bg(stateBackground, this.theme.fg(stateColor, `[${state}]`));
		const title = this.theme.fg("accent", "✦ Guild Relay");
		const headerMiddle = joinSides(`─ ${title} `, ` ${pill} ─`, innerWidth, "─");
		const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][this.frame];
		const activityIcon = this.cancelling ? "■" : this.phase === "queued" ? "○" : spinner;
		const activityMetadata = [
			this.activityTool,
			this.turns > 0 ? `${this.turns} turn${this.turns === 1 ? "" : "s"}` : undefined,
		].filter(Boolean).join(" · ");
		const activity = this.theme.fg(stateColor, `  ${activityIcon}  ${this.activity}`) +
			(activityMetadata ? this.theme.fg("dim", ` · ${activityMetadata}`) : "");
		const cancel = ` ${keyHint("tui.select.cancel", "cancel")}  `;
		const lines = [border("╭") + headerMiddle + border("╮")];

		const identity = presentationIdentity(this.options);
		lines.push(frameLine(memberSummary(identity.label, identity.source, identity.role, this.theme)));
		for (const requestLine of requestLines(this.options.task, innerWidth, this.theme)) lines.push(frameLine(requestLine));
		lines.push(frameLine(joinSides(activity, cancel, innerWidth)));
		if (this.options.createInspection) lines.push(frameLine(this.theme.fg("dim", "  F6 / Enter inspect · Esc / Ctrl+C cancel")));
		lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
		return lines;
	}
}

export function createGuildHandoverProgress(
	options: GuildHandoverProgressOptions,
	tui: ProgressTui,
	theme: Theme,
	keybindings: ProgressKeybindings,
): GuildHandoverProgress {
	return new GuildHandoverProgressCard(options, tui, theme, keybindings);
}

class GuildLifecycleCard implements Component {
	constructor(
		private readonly details: unknown,
		private readonly expanded: boolean,
		private readonly theme: Theme,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		const cardWidth = Math.max(2, Math.min(width, HANDOVER_CARD_MAX_WIDTH));
		const innerWidth = Math.max(1, cardWidth - 2);
		const contentWidth = Math.max(1, innerWidth - 4);
		const status = stringField(this.details, "status") ?? "started";
		const presentation = lifecyclePresentation(status, presentationPhase(this.details), stringField(this.details, "taskOutcome"));
		const border = (value: string) => this.theme.fg("borderAccent", value);
		const frame = (value = "") => `${border("│")}${padAnsi(value, innerWidth)}${border("│")}`;
		const section = (label: string) => {
			const prefix = `─ ${label} `;
			return border(`├${prefix}${"─".repeat(Math.max(0, cardWidth - visibleWidth(prefix) - 2))}┤`);
		};
		const pillText = ` ${presentation.icon} ${presentation.label} `;
		const pill = this.theme.bg(
			presentation.background,
			this.theme.fg(presentation.color, `[${pillText.trim()}]`),
		);
		const title = this.theme.fg("accent", "✦ Guild Relay");
		const headerMiddle = joinSides(`─ ${title} `, ` ${pill} ─`, innerWidth, "─");
		const lines = [border("╭") + headerMiddle + border("╮")];
		const identity = presentationIdentity(this.details);
		const summary = memberSummary(identity.label, identity.source, identity.role, this.theme);
		const metrics = this.theme.fg("dim", usageText(this.details));
		lines.push(frame(joinSides(summary, metrics ? ` ${metrics}  ` : "", innerWidth)));
		const task = stringField(this.details, "task");
		if (task) {
			for (const requestLine of requestLines(task, innerWidth, this.theme)) lines.push(frame(requestLine));
		}

		if (status === "cancelled") {
			lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
			return lines;
		}

		const output = stringField(this.details, status === "failed" ? "error" : "output");
		if (output) {
			lines.push(section(status === "failed" ? "DIAGNOSTICS" : "REPORT"));
			const renderedOutput = status === "failed"
				? wrapTextWithAnsi(this.theme.fg("error", output.trim()), contentWidth)
				: new Markdown(presentationMarkdown(output.trim()), 0, 0, getMarkdownTheme()).render(contentWidth);
			const visibleOutput = this.expanded ? renderedOutput : renderedOutput.slice(0, 7);
			for (const outputLine of visibleOutput) lines.push(frame(`  ${outputLine}`));
			if (!this.expanded && renderedOutput.length > visibleOutput.length) {
				lines.push(frame(this.theme.fg("dim", "  …")));
			}
		}

		const skills = selectedSkillIds(this.details);
		if (skills.length) lines.push(frame(this.theme.fg("dim", `  Selected skills: ${skills.join(", ")}`)));
		if (this.expanded) {
			const inheritedModel = stringField(this.details, "inheritedModel");
			const thinkingLevel = stringField(this.details, "thinkingLevel");
			const runId = stringField(this.details, "runId");
			const diagnostics = [
				inheritedModel ? `model ${inheritedModel}` : undefined,
				thinkingLevel ? `thinking ${thinkingLevel}` : undefined,
				runId ? `run ${runId}` : undefined,
			].filter(Boolean).join(" · ");
			if (diagnostics) lines.push(frame(this.theme.fg("dim", `  ${diagnostics}`)));
		}

		lines.push(border(`├${"─".repeat(innerWidth)}┤`));
		const hint = this.expanded ? this.theme.fg("dim", "  full report") : `  ${keyHint("app.tools.expand", "expand report")}`;
		lines.push(frame(hint));
		lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
		return lines;
	}
}

export function renderGuildLifecycleMessage(
	message: LifecycleMessageLike,
	options: { expanded?: boolean; outputPad?: number },
	theme: Theme,
): Component {
	return new GuildLifecycleCard(message.details, options.expanded ?? false, theme);
}

function selectedSkillIds(details: unknown): string[] {
	const skills = recordOf(details)?.selectedSkills;
	return Array.isArray(skills) ? skills.flatMap(skill => {
		const id = stringField(skill, "id");
		return id === "tdd" || id === "code-review-standards" ? [id] : [];
	}) : [];
}

export function renderGuildResult(
	result: ToolResultLike,
	options: { expanded?: boolean; isPartial?: boolean },
	theme: Theme,
	context?: { isError?: boolean },
): Component {
	const details = result.details;
	const output = stringField(details, "output") || resultText(result);
	const status = stringField(details, "status");
	const phase = presentationPhase(details);
	const cancelled = status === "cancelled";
	const failed = !cancelled && (context?.isError || status === "failed");
	const blocked = !failed && status === "completed" && stringField(details, "taskOutcome") === "blocked";
	const terminal = failed || status === "completed" || status === "cancelled";
	const queued = !terminal && phase === "queued";
	const running = !terminal && !queued && (options.isPartial || phase === "running");
	const icon = cancelled ? "■" : queued ? "○" : running ? "●" : failed ? "✗" : blocked ? "!" : "✓";
	const label = cancelled ? "Cancelled" : queued ? "Queued" : running ? "Running" : failed ? "Failed" : blocked ? "Blocked" : "Completed";
	const color = cancelled ? "muted" : queued ? "muted" : running || blocked ? "warning" : failed ? "error" : "success";
	const identity = presentationIdentity(details);

	const container = new Container();
	container.addChild(new Text(
		theme.fg(color, theme.bold(`${icon} ${label}  `)) + theme.fg("accent", identity.label),
		0,
		0,
	));

	const metadata = [
		sourceLabel(identity.source),
		permissionLabel(identity.role)?.toUpperCase(),
		usageText(details),
		...(selectedSkillIds(details).length ? [`skills: ${selectedSkillIds(details).join(", ")}`] : []),
	].filter(Boolean).join(" · ");
	if (metadata) container.addChild(new Text(theme.fg("dim", metadata), 0, 0));

	if (output) {
		container.addChild(new Spacer(1));
		if (options.expanded) {
			container.addChild(new Text(theme.fg("toolOutput", output.trim()), 0, 0));
		} else {
			const previewLines = output.trim().split("\n").slice(0, 4);
			container.addChild(new Text(theme.fg("toolOutput", previewLines.join("\n")), 0, 0));
			if (output.trim().split("\n").length > previewLines.length) {
				container.addChild(new Text(theme.fg("dim", "… expand for full guild member output"), 0, 0));
			}
		}
	}
	return container;
}
