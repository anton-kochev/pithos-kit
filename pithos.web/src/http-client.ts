import type { LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import {
	resolvePublicUrl,
	type DnsLookup,
	type ResolvedAddress,
	WebNetworkError,
} from "./network-policy.ts";

export const DEFAULT_RESPONSE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_REDIRECTS = 5;
export const DEFAULT_TIMEOUT_MS = 15_000;

export type TransportResponse = {
	response: Response;
	dispose?: () => Promise<void>;
};

export type PublicRequestTransport = (
	url: URL,
	address: ResolvedAddress,
	signal: AbortSignal,
) => Promise<TransportResponse>;

export type FetchPublicOptions = {
	lookup?: DnsLookup;
	transport?: PublicRequestTransport;
	signal?: AbortSignal;
	timeoutMs?: number;
	maxResponseBytes?: number;
	maxRedirects?: number;
};

export type PublicResource = {
	finalUrl: string;
	status: number;
	contentType: string;
	body: string;
	bytes: number;
	redirects: number;
};

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function createPinnedLookup(address: ResolvedAddress): LookupFunction {
	return ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
		if (options.all) callback(null, [{ address: address.address, family: address.family }]);
		else callback(null, address.address, address.family);
	}) as LookupFunction;
}

const defaultTransport: PublicRequestTransport = async (url, address, signal) => {
	const dispatcher = new Agent({
		connect: { lookup: createPinnedLookup(address) },
	});
	try {
		const response = await undiciFetch(url, {
			method: "GET",
			redirect: "manual",
			signal,
			dispatcher,
			headers: {
				accept: "text/html, text/plain, text/markdown, application/xhtml+xml;q=0.9, application/json;q=0.8, application/xml;q=0.7",
				"user-agent": "@pithos-kit/web/0.1",
			},
		});
		return {
			response: response as unknown as Response,
			dispose: async () => dispatcher.close(),
		};
	} catch (error) {
		await dispatcher.close().catch(() => undefined);
		throw error;
	}
};

async function cancelBody(response: Response): Promise<void> {
	await response.body?.cancel().catch(() => undefined);
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

function declaredCharset(contentType: string): string | undefined {
	const match = /(?:^|;)\s*charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/iu.exec(contentType);
	return (match?.[1] ?? match?.[2] ?? match?.[3])?.trim();
}

function decodeBody(buffer: Buffer, contentType: string): string {
	let encoding = declaredCharset(contentType) ?? "utf-8";
	if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) encoding = "utf-8";
	else if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) encoding = "utf-16le";
	else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) encoding = "utf-16be";
	let decoder: TextDecoder;
	try {
		decoder = new TextDecoder(encoding, { fatal: true });
	} catch (error) {
		throw new WebNetworkError(`Web response declares an unsupported charset: ${encoding}`, { cause: error });
	}
	try {
		return decoder.decode(buffer);
	} catch (error) {
		throw new WebNetworkError(`Web response is not valid ${encoding} text`, { cause: error });
	}
}

async function readBoundedBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<{ body: string; bytes: number }> {
	const contentLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > maxBytes) {
		await cancelBody(response);
		throw new WebNetworkError(`Web response exceeds the ${maxBytes}-byte download limit`);
	}
	if (!response.body) return { body: "", bytes: 0 };

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
				throw new WebNetworkError(`Web response exceeds the ${maxBytes}-byte download limit`);
			}
			chunks.push(value);
		}
	} catch (error) {
		await reader.cancel().catch(() => undefined);
		throw error;
	} finally {
		reader.releaseLock();
	}
	const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes);
	return {
		body: decodeBody(buffer, response.headers.get("content-type") ?? ""),
		bytes,
	};
}

export async function fetchPublicResource(input: string, options: FetchPublicOptions = {}): Promise<PublicResource> {
	const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
	const transport = options.transport ?? defaultTransport;
	const maxBytes = options.maxResponseBytes ?? DEFAULT_RESPONSE_BYTES;
	const maxRedirects = options.maxRedirects ?? DEFAULT_REDIRECTS;
	let current = input;
	let redirects = 0;

	try {
		while (true) {
			signal.throwIfAborted();
			const resolved = await waitWithSignal(resolvePublicUrl(current, options.lookup), signal);
			const requestUrl = new URL(resolved.url);
			requestUrl.hash = "";
			const { response, dispose } = await waitWithSignal(
				transport(requestUrl, resolved.addresses[0]!, signal),
				signal,
			);
			try {
				if (REDIRECT_STATUSES.has(response.status)) {
					const location = response.headers.get("location");
					await cancelBody(response);
					if (!location) throw new WebNetworkError(`Web redirect returned HTTP ${response.status} without a location`);
					if (redirects >= maxRedirects) throw new WebNetworkError(`Web request exceeded ${maxRedirects} redirects`);
					current = new URL(location, requestUrl).href;
					redirects += 1;
					continue;
				}
				if (!response.ok) {
					await cancelBody(response);
					throw new WebNetworkError(`Web server returned HTTP ${response.status}`);
				}
				const { body, bytes } = await readBoundedBody(response, maxBytes, signal);
				return {
					finalUrl: requestUrl.href,
					status: response.status,
					contentType: response.headers.get("content-type") ?? "",
					body,
					bytes,
					redirects,
				};
			} finally {
				await dispose?.().catch(() => undefined);
			}
		}
	} catch (error) {
		if (error instanceof WebNetworkError) throw error;
		if (options.signal?.aborted) throw new WebNetworkError("Web request was cancelled", { cause: error });
		if (timeoutSignal.aborted) throw new WebNetworkError("Web request timed out", { cause: error });
		throw new WebNetworkError("Unable to fetch the public web resource", { cause: error });
	}
}
