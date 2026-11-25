import { convert } from "html-to-text";
import { hasUnicodeFormattingControls, revealUnicodeFormattingControls } from "./sanitize.ts";

export const MAX_SEARCH_QUERY_LENGTH = 500;
export const DEFAULT_SEARCH_COUNT = 5;
export const MAX_SEARCH_COUNT = 10;

export type SearchResult = {
	title: string;
	url: string;
	description: string;
};

export type SearchOptions = {
	apiKey?: string;
	count?: number;
	fetch?: typeof globalThis.fetch;
	signal?: AbortSignal;
	timeoutMs?: number;
	maxResponseBytes?: number;
};

export function normalizeSearchQuery(query: string, SearchError: new (message: string) => Error = Error): string {
	const normalizedQuery = query.trim();
	if (!normalizedQuery) throw new SearchError("web_search requires a non-empty query");
	if (normalizedQuery.length > MAX_SEARCH_QUERY_LENGTH) throw new SearchError(`web_search query must not exceed ${MAX_SEARCH_QUERY_LENGTH} characters`);
	if (/[\u0000-\u001f\u007f-\u009f]/u.test(normalizedQuery) || hasUnicodeFormattingControls(normalizedQuery)) {
		throw new SearchError("web_search query must not contain control characters");
	}
	return normalizedQuery;
}

function clipUtf8(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	let output = "";
	let bytes = 0;
	for (const character of value) {
		const size = Buffer.byteLength(character, "utf8");
		if (bytes + size > maxBytes) break;
		output += character;
		bytes += size;
	}
	return output;
}

function cleanSearchText(value: string, maxBytes: number): string {
	const converted = revealUnicodeFormattingControls(convert(value.slice(0, maxBytes * 4), {
		wordwrap: false,
		limits: { maxInputLength: maxBytes * 4, maxDepth: 8, maxChildNodes: 100 },
		selectors: [
			{ selector: "a", options: { ignoreHref: true } },
			{ selector: "img", format: "skip" },
		],
	}))
		.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
	return clipUtf8(converted, maxBytes);
}

export function sanitizeSearchResult(title: string, url: string, description: string): SearchResult | undefined {
	const parsedUrl = URL.parse(url);
	if (!parsedUrl || (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") || parsedUrl.username || parsedUrl.password) return undefined;
	if (Buffer.byteLength(parsedUrl.href, "utf8") > 2_048) return undefined;
	const cleanTitle = cleanSearchText(title, 512);
	if (!cleanTitle) return undefined;
	return { title: cleanTitle, url: parsedUrl.href, description: cleanSearchText(description, 1_024) };
}
