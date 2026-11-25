import { addAbortListener } from "node:events";
import { Socket } from "node:net";
import {
	DEFAULT_SEARCH_COUNT,
	MAX_SEARCH_COUNT,
	MAX_SEARCH_QUERY_LENGTH,
	sanitizeSearchResult,
	type SearchResult,
} from "./search.ts";

const STATUS_TIMEOUT_MS = 2_000;
const SEARCH_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
export const BROKER_UNAVAILABLE = "Pithos host web search is unavailable. Run /web-setup for host setup guidance.";
const REPLY_ERRORS = {
	unauthorized: "Pithos host web search did not authorize this session. Restart Pithos.",
	invalid_request: "Pithos host web search received an invalid request. Check the Web extension and restart Pithos.",
	invalid_query: `Invalid web search query. Use non-empty text of at most ${MAX_SEARCH_QUERY_LENGTH} characters without control characters.`,
	url_query: "Pithos host web search does not accept URL-only queries. Use web_fetch for a specific public URL.",
	credential_rejected: "The search provider rejected its host credential. Check the host API key and plan, then restart Pithos.",
	quota_exhausted: "The search provider reports insufficient funds or exhausted quota. Check its balance and plan before retrying.",
	rate_limited: "The search provider is rate limiting requests. Wait before retrying.",
	timeout: "Pithos host web search timed out.",
	provider_unavailable: "The search provider is temporarily unavailable. Try again later.",
	invalid_response: "Pithos host web search returned an invalid response.",
	upstream_rejected: "The search provider rejected the request.",
	unavailable: BROKER_UNAVAILABLE,
	offline: "Pithos host web search is offline. Restart Pithos in an online session.",
} as const;

export class SearchBrokerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SearchBrokerError";
	}
}

export type ReadySearchBroker = {
	status: "ready";
	endpoint: { path: string } | { host: "host.docker.internal"; port: number };
	token: string;
};

type SearchBroker = ReadySearchBroker | { status: "standalone" | "unconfigured" | "unavailable" | "offline" };

export function searchBrokerFromEnvironment(env: NodeJS.ProcessEnv): SearchBroker {
	const status = env.PITHOS_WEB_SEARCH_STATUS;
	// Only an absent launch marker allows direct Brave search; malformed host setup must not unlock it.
	if (status === undefined) return { status: "standalone" };
	if (status === "unconfigured" || status === "offline") return { status };
	if (status !== "ready") return { status: "unavailable" };

	const token = env.PITHOS_WEB_SEARCH_TOKEN;
	if (!token || !/^[0-9a-f]{64}$/u.test(token)) return { status: "unavailable" };
	const path = env.PITHOS_WEB_SEARCH_SOCKET;
	const port = env.PITHOS_WEB_SEARCH_PORT;
	if (path !== undefined && port === undefined && path.startsWith("/") && !path.includes("\0")) {
		return { status: "ready", endpoint: { path }, token };
	}
	if (path === undefined && port !== undefined && /^[0-9]{1,5}$/u.test(port)) {
		const portNumber = Number(port);
		if (portNumber >= 1 && portNumber <= 65_535) {
			return { status: "ready", endpoint: { host: "host.docker.internal", port: portNumber }, token };
		}
	}
	return { status: "unavailable" };
}

const CANCELLED = "Pithos host web search was cancelled.";

function readReply(broker: ReadySearchBroker, request: string, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
	if (signal?.aborted) return Promise.reject(new SearchBrokerError(CANCELLED));
	return new Promise((resolve, reject) => {
		const deadline = performance.now() + timeoutMs;
		const socket = new Socket();
		const frame = Buffer.alloc(MAX_RESPONSE_BYTES);
		let bytes = 0;
		let settled = false;
		const cancelled = () => finish(new SearchBrokerError(CANCELLED));
		const unavailable = () => finish(new SearchBrokerError(BROKER_UNAVAILABLE));
		const timedOut = () => finish(new SearchBrokerError(REPLY_ERRORS.timeout));
		const timer = setTimeout(timedOut, timeoutMs);

		function finish(error?: SearchBrokerError, response?: unknown): void {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			abortListener?.[Symbol.dispose]();
			socket.destroy();
			if (error) reject(error);
			else resolve(response);
		}
		function expired(): boolean {
			if (settled) return true;
			if (performance.now() < deadline) return false;
			timedOut();
			return true;
		}

		socket.once("connect", () => {
			if (expired()) return;
			try {
				socket.write(request, "utf8");
			} catch {
				unavailable();
			}
		});
		socket.on("data", (chunk: Buffer) => {
			if (settled) return;
			if (chunk.length > MAX_RESPONSE_BYTES - bytes) {
				finish(new SearchBrokerError("Pithos host web search response exceeds the 64 KiB limit."));
				return;
			}
			chunk.copy(frame, bytes);
			bytes += chunk.length;
		});
		socket.once("end", () => {
			if (expired()) return;
			// The broker closes after its only reply, so trailing data must not be accepted as a second frame.
			const reply = frame.subarray(0, bytes);
			if (bytes === 0 || reply.indexOf(0x0a) !== bytes - 1) {
				finish(new SearchBrokerError(REPLY_ERRORS.invalid_response));
				return;
			}
			try {
				const json = new TextDecoder("utf-8", { fatal: true }).decode(reply.subarray(0, -1));
				const response: unknown = JSON.parse(json);
				if (!expired()) finish(undefined, response);
			} catch {
				finish(new SearchBrokerError(REPLY_ERRORS.invalid_response));
			}
		});
		socket.on("error", unavailable);
		socket.once("close", unavailable);
		const abortListener = signal && addAbortListener(signal, cancelled);
		try {
			socket.connect(broker.endpoint);
		} catch {
			unavailable();
		}
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

type BrokerOperation = { operation: "status" } | { operation: "search"; query: string; count?: number };

async function requestBroker(broker: ReadySearchBroker, operation: BrokerOperation, signal?: AbortSignal): Promise<{ provider: string; results?: unknown }> {
	const request = JSON.stringify({ version: 1, token: broker.token, ...operation }) + "\n";
	const response = await readReply(broker, request, operation.operation === "status" ? STATUS_TIMEOUT_MS : SEARCH_TIMEOUT_MS, signal);
	if (isRecord(response) && response.ok === false && typeof response.error === "string" && Object.hasOwn(REPLY_ERRORS, response.error)) {
		throw new SearchBrokerError(REPLY_ERRORS[response.error as keyof typeof REPLY_ERRORS]);
	}
	if (!isRecord(response) || response.ok !== true || typeof response.provider !== "string"
		|| !/^[a-z][a-z0-9_-]{0,63}$/u.test(response.provider)) {
		throw new SearchBrokerError(REPLY_ERRORS.invalid_response);
	}
	return { provider: response.provider, results: response.results };
}

export async function readyBrokerProvider(broker: ReadySearchBroker): Promise<string> {
	const { provider } = await requestBroker(broker, { operation: "status" });
	return provider;
}

export async function searchThroughBroker(broker: ReadySearchBroker, query: string, count?: number, signal?: AbortSignal): Promise<{ provider: string; results: SearchResult[] }> {
	if (count !== undefined && (!Number.isInteger(count) || count < 1 || count > MAX_SEARCH_COUNT)) {
		throw new SearchBrokerError(`web_search count must be an integer between 1 and ${MAX_SEARCH_COUNT}`);
	}
	const { provider, results: entries } = await requestBroker(broker, { operation: "search", query, count }, signal);
	if (!Array.isArray(entries)) throw new SearchBrokerError(REPLY_ERRORS.invalid_response);
	const results: SearchResult[] = [];
	for (const entry of entries) {
		if (!isRecord(entry)) continue;
		const { title, url, description } = entry;
		if (typeof title !== "string" || typeof url !== "string" || typeof description !== "string") continue;
		const result = sanitizeSearchResult(title, url, description);
		if (!result) continue;
		results.push(result);
		if (results.length >= (count ?? DEFAULT_SEARCH_COUNT)) break;
	}
	return { provider, results };
}
