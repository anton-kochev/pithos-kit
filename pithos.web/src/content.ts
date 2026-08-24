import { convert } from "html-to-text";
import type { PublicResource } from "./http-client.ts";
import { revealUnicodeFormattingControls } from "./sanitize.ts";

export const DEFAULT_OUTPUT_BYTES = 48 * 1024;
export const DEFAULT_OUTPUT_LINES = 1_900;
const MAX_HTML_DEPTH = 64;
const MAX_CHILD_NODES = 1_000;
const MAX_RENDERED_LINKS = 200;
const MAX_RENDERED_LINK_BYTES = 2_048;
const MAX_TITLE_BYTES = 1_024;
const HTML_SAFETY_ELLIPSIS = "[web content omitted by safety limit]";
const HTML_TITLE_ELLIPSIS = "[web title omitted by safety limit]";

export type ExtractContentOptions = {
	maxOutputBytes?: number;
	maxOutputLines?: number;
};

export type ExtractedWebContent = {
	text: string;
	title?: string;
	mediaType: string;
	truncated: boolean;
	omissions: string[];
	totalBytes: number;
	outputBytes: number;
	totalLines: number;
	outputLines: number;
};

export class WebContentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WebContentError";
	}
}

function mediaType(contentType: string): string {
	return contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function isTextual(type: string): boolean {
	return type.startsWith("text/")
		|| type === "application/json"
		|| type.endsWith("+json")
		|| type === "application/xml"
		|| type.endsWith("+xml");
}

function normalizeText(text: string): string {
	return revealUnicodeFormattingControls(text)
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
		.replace(/\r\n?/gu, "\n")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "")
		.replace(/[ \t]+$/gmu, "")
		.replace(/\n{4,}/gu, "\n\n\n")
		.trim();
}

function htmlTitle(html: string): { title?: string; limited: boolean } {
	const match = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title\s*>/iu.exec(html);
	if (!match) return { limited: false };
	const original = match[1] ?? "";
	const rawTitle = original.slice(0, 4_096);
	const normalized = normalizeText(convert(rawTitle, {
		wordwrap: false,
		limits: {
			maxInputLength: 4_096,
			maxDepth: 16,
			maxChildNodes: 100,
			ellipsis: HTML_TITLE_ELLIPSIS,
		},
	}));
	const title = clipUtf8(normalized, MAX_TITLE_BYTES);
	return {
		...(title ? { title } : {}),
		limited: original.length > rawTitle.length
			|| Buffer.byteLength(normalized, "utf8") > MAX_TITLE_BYTES
			|| normalized.includes(HTML_TITLE_ELLIPSIS),
	};
}

function htmlToReadableText(html: string, baseUrl: string): { text: string; omissions: string[] } {
	let renderedLinks = 0;
	let linksOmitted = false;
	const text = convert(html, {
		wordwrap: false,
		baseElements: { selectors: ["body"] },
		limits: {
			maxInputLength: 2 * 1024 * 1024,
			maxBaseElements: 1,
			maxChildNodes: MAX_CHILD_NODES,
			maxDepth: MAX_HTML_DEPTH,
			ellipsis: HTML_SAFETY_ELLIPSIS,
		},
		selectors: [
			{ selector: "script", format: "skip" },
			{ selector: "style", format: "skip" },
			{ selector: "noscript", format: "skip" },
			{ selector: "template", format: "skip" },
			{ selector: "svg", format: "skip" },
			{ selector: "canvas", format: "skip" },
			{ selector: "img", format: "skip" },
			{ selector: "h1", options: { uppercase: false } },
			{ selector: "h2", options: { uppercase: false } },
			{ selector: "h3", options: { uppercase: false } },
			{ selector: "h4", options: { uppercase: false } },
			{ selector: "h5", options: { uppercase: false } },
			{ selector: "h6", options: { uppercase: false } },
			{
				selector: "a",
				options: {
					pathRewrite: (href: string) => {
						if (renderedLinks >= MAX_RENDERED_LINKS) {
							linksOmitted = true;
							return "";
						}
						renderedLinks += 1;
						try {
							const absolute = new URL(href, baseUrl).href;
							if (Buffer.byteLength(absolute, "utf8") <= MAX_RENDERED_LINK_BYTES) return absolute;
							linksOmitted = true;
							return "";
						} catch {
							linksOmitted = true;
							return "";
						}
					},
				},
			},
		],
	});
	const omissions: string[] = [];
	if (linksOmitted) omissions.push("HTML link destination budget omitted links");
	if (text.includes(HTML_SAFETY_ELLIPSIS)) omissions.push("HTML traversal safety limits omitted content");
	return { text, omissions };
}

function clipUtf8(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let output = "";
	let bytes = 0;
	for (const character of text) {
		const size = Buffer.byteLength(character, "utf8");
		if (bytes + size > maxBytes) break;
		output += character;
		bytes += size;
	}
	return output;
}

function truncate(text: string, maxBytes: number, maxLines: number) {
	const totalBytes = Buffer.byteLength(text, "utf8");
	const lines = text.split("\n");
	const totalLines = lines.length;
	let output = lines.slice(0, maxLines).join("\n");
	output = clipUtf8(output, maxBytes).trimEnd();
	const outputBytes = Buffer.byteLength(output, "utf8");
	const outputLines = output ? output.split("\n").length : 0;
	return {
		text: output,
		truncated: outputBytes < totalBytes || outputLines < totalLines,
		totalBytes,
		outputBytes,
		totalLines,
		outputLines,
	};
}

export function extractWebContent(
	resource: PublicResource,
	options: ExtractContentOptions = {},
): ExtractedWebContent {
	const type = mediaType(resource.contentType);
	if (!type) throw new WebContentError("web_fetch requires a declared textual content type");
	if (type !== "text/html" && type !== "application/xhtml+xml" && !isTextual(type)) {
		throw new WebContentError(`web_fetch does not support content type ${type}`);
	}

	const html = type === "text/html" || type === "application/xhtml+xml";
	const titleResult = html ? htmlTitle(resource.body) : { limited: false };
	const converted = html ? htmlToReadableText(resource.body, resource.finalUrl) : { text: resource.body, omissions: [] };
	const omissions = [
		...(titleResult.limited ? ["HTML title exceeded the extraction budget"] : []),
		...converted.omissions,
	];
	const normalized = normalizeText(converted.text);
	if (!normalized) throw new WebContentError("web_fetch found no readable text in the response");
	const result = truncate(
		normalized,
		options.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES,
		options.maxOutputLines ?? DEFAULT_OUTPUT_LINES,
	);
	if (result.truncated) omissions.push("Extracted text exceeded the byte or line budget");
	return {
		...result,
		truncated: result.truncated || omissions.length > 0,
		title: titleResult.title,
		mediaType: type,
		omissions,
	};
}
