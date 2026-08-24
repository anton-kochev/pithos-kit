import { convert } from "html-to-text";
import { hasUnicodeFormattingControls, revealUnicodeFormattingControls } from "./sanitize.ts";

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
export const BRAVE_SEARCH_REGISTER_URL = "https://api-dashboard.search.brave.com/register";
export const BRAVE_SEARCH_PLANS_URL = "https://api-dashboard.search.brave.com/app/plans";
export const BRAVE_SEARCH_KEYS_URL = "https://api-dashboard.search.brave.com/app/keys";
const DEFAULT_COUNT = 5;
const MAX_COUNT = 10;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

export type BraveSearchResult = {
	title: string;
	url: string;
	description: string;
};

export type BraveSearchOptions = {
	apiKey?: string;
	count?: number;
	fetch?: typeof globalThis.fetch;
	signal?: AbortSignal;
	timeoutMs?: number;
	maxResponseBytes?: number;
};

export class BraveSearchError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "BraveSearchError";
	}
}

export function hasBraveSearchApiKey(value: string | undefined): boolean {
	return Boolean(value?.trim());
}

export function normalizeBraveSearchQuery(query: string): string {
	const normalizedQuery = query.trim();
	if (!normalizedQuery) throw new BraveSearchError("web_search requires a non-empty query");
	if (normalizedQuery.length > 500) throw new BraveSearchError("web_search query must not exceed 500 characters");
	if (/[\u0000-\u001f\u007f-\u009f]/u.test(normalizedQuery) || hasUnicodeFormattingControls(normalizedQuery)) {
		throw new BraveSearchError("web_search query must not contain control characters");
	}
	return normalizedQuery;
}

export function missingBraveSearchApiKeyMessage(): string {
	return "web_search is unavailable because BRAVE_SEARCH_API_KEY is missing. "
		+ "Run /web-setup for secure setup instructions. "
		+ `Register with Brave at ${BRAVE_SEARCH_REGISTER_URL}, activate a Search plan at ${BRAVE_SEARCH_PLANS_URL}, `
		+ `and create or manage a key at ${BRAVE_SEARCH_KEYS_URL}. `
		+ "Export the key in the shell that starts Pi, then restart Pi. "
		+ "web_fetch still works without this key. Never paste the key into chat or tool arguments.";
}

function braveHttpError(status: number): BraveSearchError {
	if (status === 401 || status === 403) {
		return new BraveSearchError(
			`Brave Search rejected the credential (HTTP ${status}), or the credential has an inactive Search plan. `
			+ `Run /web-setup, then verify the key at ${BRAVE_SEARCH_KEYS_URL} and Search plan at ${BRAVE_SEARCH_PLANS_URL}; `
			+ "restart Pi after updating the key.",
		);
	}
	if (status === 429) {
		return new BraveSearchError(
			`Brave Search quota or rate limit reached (HTTP ${status}). `
			+ `Check the Search plan quota and rate limits at ${BRAVE_SEARCH_PLANS_URL}; wait before retrying or increase the plan.`,
		);
	}
	return new BraveSearchError(`Brave Search returned HTTP ${status}`);
}

function waitWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			cleanup();
			reject(signal.reason);
		};
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		signal.addEventListener("abort", onAbort, { once: true });
		operation.then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error) => {
				cleanup();
				reject(error);
			},
		);
	});
}

async function readBoundedJson(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
	const length = Number(response.headers.get("content-length"));
	if (Number.isFinite(length) && length > maxBytes) {
		await response.body?.cancel().catch(() => undefined);
		throw new BraveSearchError(`Brave Search response exceeds the ${maxBytes}-byte limit`);
	}
	if (!response.body) throw new BraveSearchError("Brave Search returned an empty response");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			const { done, value } = await waitWithSignal(reader.read(), signal);
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) {
				await reader.cancel().catch(() => undefined);
				throw new BraveSearchError(`Brave Search response exceeds the ${maxBytes}-byte limit`);
			}
			chunks.push(value);
		}
	} catch (error) {
		await reader.cancel().catch(() => undefined);
		throw error;
	} finally {
		reader.releaseLock();
	}

	try {
		return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes).toString("utf8"));
	} catch (error) {
		throw new BraveSearchError("Brave Search returned invalid JSON", { cause: error });
	}
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

function cleanText(value: string, maxBytes: number): string {
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

function parseResults(raw: unknown, count: number): BraveSearchResult[] {
	if (!raw || typeof raw !== "object") throw new BraveSearchError("Brave Search returned invalid result data");
	const web = (raw as { web?: unknown }).web;
	if (web === undefined) return [];
	if (!web || typeof web !== "object" || !Array.isArray((web as { results?: unknown }).results)) {
		throw new BraveSearchError("Brave Search returned invalid web results");
	}

	const results: BraveSearchResult[] = [];
	for (const entry of (web as { results: unknown[] }).results) {
		if (!entry || typeof entry !== "object") continue;
		const { title, url, description } = entry as Record<string, unknown>;
		if (typeof title !== "string" || typeof url !== "string") continue;
		let parsedUrl: URL;
		try {
			parsedUrl = new URL(url);
		} catch {
			continue;
		}
		if ((parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") || parsedUrl.username || parsedUrl.password) continue;
		if (Buffer.byteLength(parsedUrl.href, "utf8") > 2_048) continue;
		const cleanTitle = cleanText(title, 512);
		if (!cleanTitle) continue;
		results.push({
			title: cleanTitle,
			url: parsedUrl.href,
			description: typeof description === "string" ? cleanText(description, 1_024) : "",
		});
		if (results.length >= count) break;
	}
	return results;
}

export async function searchBrave(query: string, options: BraveSearchOptions = {}): Promise<BraveSearchResult[]> {
	const normalizedQuery = normalizeBraveSearchQuery(query);
	const apiKey = options.apiKey?.trim();
	if (!apiKey) throw new BraveSearchError(missingBraveSearchApiKeyMessage());
	const count = Math.min(MAX_COUNT, Math.max(1, Math.floor(options.count ?? DEFAULT_COUNT)));
	const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
	const url = new URL(BRAVE_SEARCH_ENDPOINT);
	url.searchParams.set("q", normalizedQuery);
	url.searchParams.set("count", String(count));
	url.searchParams.set("safesearch", "moderate");
	url.searchParams.set("text_decorations", "false");

	try {
		const response = await waitWithSignal((options.fetch ?? globalThis.fetch)(url, {
			method: "GET",
			redirect: "error",
			signal,
			headers: {
				accept: "application/json",
				"x-subscription-token": apiKey,
			},
		}), signal);
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			throw braveHttpError(response.status);
		}
		const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
		if (!contentType.includes("application/json")) {
			await response.body?.cancel().catch(() => undefined);
			throw new BraveSearchError("Brave Search returned a non-JSON response");
		}
		return parseResults(await readBoundedJson(response, options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, signal), count);
	} catch (error) {
		if (error instanceof BraveSearchError) throw error;
		if (options.signal?.aborted) throw new BraveSearchError("Brave Search was cancelled", { cause: error });
		if (timeoutSignal.aborted) throw new BraveSearchError("Brave Search timed out", { cause: error });
		throw new BraveSearchError("Unable to reach Brave Search", { cause: error });
	}
}
