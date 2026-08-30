import "./runtime-compat.ts";
import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Key,
	Markdown,
	Text,
	TruncatedText,
	matchesKey,
	truncateToWidth,
	type Component,
	type KeybindingsManager,
} from "@earendil-works/pi-tui";

type PlanPreviewTheme = Pick<Theme, "bold" | "fg" | "italic" | "strikethrough" | "underline">;

function makeDraftTerminalSafe(content: string): string {
	return content.replace(/[\p{Cc}\p{Cf}]/gu, (character) => {
		if (character === "\n") return character;
		const codePoint = character.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0") ?? "0000";
		return `⟦U+${codePoint}⟧`;
	});
}

function createMarkdownTheme(theme: PlanPreviewTheme) {
	return {
		heading: (text: string) => theme.fg("mdHeading", text),
		link: (text: string) => theme.fg("mdLink", text),
		linkUrl: (text: string) => theme.fg("mdLinkUrl", text),
		code: (text: string) => theme.fg("mdCode", text),
		codeBlock: (text: string) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text: string) => theme.fg("mdCodeBlockBorder", text),
		quote: (text: string) => theme.fg("mdQuote", text),
		quoteBorder: (text: string) => theme.fg("mdQuoteBorder", text),
		hr: (text: string) => theme.fg("mdHr", text),
		listBullet: (text: string) => theme.fg("mdListBullet", text),
		bold: (text: string) => theme.bold(text),
		italic: (text: string) => theme.italic(text),
		strikethrough: (text: string) => theme.strikethrough(text),
		underline: (text: string) => theme.underline(text),
	};
}

type PlanPreviewKeybindings = Pick<KeybindingsManager, "getKeys" | "matches">;

export type PlanPreviewOptions = {
	content: string;
	planPath: string;
	terminalRows: () => number;
	theme: PlanPreviewTheme;
	keybindings: PlanPreviewKeybindings;
	onClose: () => void;
	onRender: () => void;
};

const CHROME_ROWS = 7;
const KEY_LABELS: Record<string, string> = {
	up: "↑",
	down: "↓",
	pageUp: "PgUp",
	pageDown: "PgDn",
	enter: "Enter",
	return: "Return",
	escape: "Esc",
};

export class PlanPreview implements Component {
	private readonly safeContent: string;
	private readonly markdown: Markdown;
	private readonly topBorder: DynamicBorder;
	private readonly sectionBorder: DynamicBorder;
	private readonly bottomBorder: DynamicBorder;
	private title: TruncatedText;
	private path: TruncatedText;
	private readonly status: Text;
	private help: TruncatedText;
	private readonly options: PlanPreviewOptions;
	private scrollOffset = 0;
	private viewportRows = 1;
	private maxOffset = 0;

	constructor(options: PlanPreviewOptions) {
		this.options = options;
		const { theme } = options;
		const borderColor = (text: string) => theme.fg("borderAccent", text);
		this.safeContent = makeDraftTerminalSafe(options.content);
		this.markdown = new Markdown(this.safeContent, 1, 0, createMarkdownTheme(theme));
		this.topBorder = new DynamicBorder(borderColor);
		this.sectionBorder = new DynamicBorder((text: string) => theme.fg("borderMuted", text));
		this.bottomBorder = new DynamicBorder(borderColor);
		this.title = new TruncatedText("", 1, 0);
		this.path = new TruncatedText("", 1, 0);
		this.status = new Text("", 1, 0);
		this.help = new TruncatedText("", 1, 0);
		this.refreshThemedText();
	}

	private keyLabel(
		action:
			| "tui.select.up"
			| "tui.select.down"
			| "tui.select.pageUp"
			| "tui.select.pageDown"
			| "tui.select.confirm"
			| "tui.select.cancel",
	): string {
		const key = String(this.options.keybindings.getKeys(action)[0] ?? "");
		return KEY_LABELS[key] ?? key;
	}

	private refreshThemedText(): void {
		const { theme } = this.options;
		const confirm = this.keyLabel("tui.select.confirm");
		const cancel = this.keyLabel("tui.select.cancel");
		const up = this.keyLabel("tui.select.up");
		const down = this.keyLabel("tui.select.down");
		const pageUp = this.keyLabel("tui.select.pageUp");
		const pageDown = this.keyLabel("tui.select.pageDown");
		this.title = new TruncatedText(theme.fg("accent", theme.bold("Review plan draft")), 1, 0);
		this.path = new TruncatedText(theme.fg("muted", `Target: ${this.options.planPath}`), 1, 0);
		this.help = new TruncatedText(
			theme.fg("dim", `${confirm}/${cancel}: confirmation • ${up}/${down} line • ${pageUp}/${pageDown} page • Home/End bounds`),
			1,
			0,
		);
	}

	private fit(lines: string[], width: number, availableRows: number): string[] {
		return lines
			.slice(0, availableRows)
			.map((line) => truncateToWidth(line, Math.max(0, width), ""));
	}

	render(width: number): string[] {
		const availableRows = Math.max(1, Math.floor(this.options.terminalRows()) - 1);
		const markdownLines = width < 3
			? this.safeContent.split("\n").map((line) => truncateToWidth(line, Math.max(0, width), ""))
			: this.markdown.render(width);

		if (availableRows < 4) {
			const confirm = this.keyLabel("tui.select.confirm");
			const cancel = this.keyLabel("tui.select.cancel");
			this.status.setText(
				this.options.theme.fg(
					"warning",
					`${confirm}/${cancel}: confirmation; terminal too short for preview`,
				),
			);
			return this.fit(
				[...this.status.render(width), ...this.path.render(width), ...this.help.render(width)],
				width,
				availableRows,
			);
		}

		const compact = availableRows < CHROME_ROWS + 1;
		this.viewportRows = compact ? availableRows - 2 : availableRows - CHROME_ROWS;
		this.maxOffset = Math.max(0, markdownLines.length - this.viewportRows);
		this.scrollOffset = Math.min(this.scrollOffset, this.maxOffset);
		const visibleDraft = markdownLines.slice(this.scrollOffset, this.scrollOffset + this.viewportRows);
		while (visibleDraft.length < this.viewportRows) visibleDraft.push("");

		if (compact) {
			return this.fit(
				[...this.path.render(width), ...visibleDraft, ...this.help.render(width)],
				width,
				availableRows,
			);
		}

		const firstVisible = markdownLines.length === 0 ? 0 : this.scrollOffset + 1;
		const lastVisible = Math.min(markdownLines.length, this.scrollOffset + this.viewportRows);
		this.status.setText(
			this.options.theme.fg("dim", `Draft lines ${firstVisible}–${lastVisible} of ${markdownLines.length}`),
		);

		return this.fit(
			[
				...this.topBorder.render(width),
				...this.title.render(width),
				...this.path.render(width),
				...this.sectionBorder.render(width),
				...visibleDraft,
				...this.status.render(width),
				...this.help.render(width),
				...this.bottomBorder.render(width),
			],
			width,
			availableRows,
		);
	}

	handleInput(data: string): void {
		const { keybindings, onClose, onRender } = this.options;
		if (
			keybindings.matches(data, "tui.select.cancel") ||
			keybindings.matches(data, "tui.select.confirm")
		) {
			onClose();
			return;
		}
		if (keybindings.matches(data, "tui.select.up")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			onRender();
			return;
		}
		if (keybindings.matches(data, "tui.select.down")) {
			this.scrollOffset = Math.min(this.maxOffset, this.scrollOffset + 1);
			onRender();
			return;
		}
		if (keybindings.matches(data, "tui.select.pageUp") || data === "b") {
			this.scrollOffset = Math.max(0, this.scrollOffset - this.viewportRows);
			onRender();
			return;
		}
		if (keybindings.matches(data, "tui.select.pageDown") || data === " ") {
			this.scrollOffset = Math.min(this.maxOffset, this.scrollOffset + this.viewportRows);
			onRender();
			return;
		}
		if (matchesKey(data, Key.home)) {
			this.scrollOffset = 0;
			onRender();
			return;
		}
		if (matchesKey(data, Key.end)) {
			this.scrollOffset = this.maxOffset;
			onRender();
		}
	}

	invalidate(): void {
		this.markdown.invalidate();
		this.topBorder.invalidate();
		this.sectionBorder.invalidate();
		this.bottomBorder.invalidate();
		this.status.invalidate();
		this.refreshThemedText();
	}
}
