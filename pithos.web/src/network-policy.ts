import { lookup as nodeLookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";

export type ResolvedAddress = {
	address: string;
	family: 4 | 6;
};

export type DnsLookup = (hostname: string) => Promise<ResolvedAddress[]>;

export type ResolvedPublicUrl = {
	url: URL;
	addresses: ResolvedAddress[];
};

export class WebNetworkError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "WebNetworkError";
	}
}

const defaultLookup: DnsLookup = async (hostname) => {
	const addresses = await nodeLookup(hostname, { all: true, verbatim: true });
	return addresses.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
};

function unbracket(hostname: string): string {
	return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

export function isPublicAddress(input: string): boolean {
	try {
		const address = ipaddr.process(input);
		return address.range() === "unicast";
	} catch {
		return false;
	}
}

function normalizeAddress(address: ResolvedAddress): ResolvedAddress {
	const parsed = ipaddr.process(address.address);
	return {
		address: parsed.toString(),
		family: parsed.kind() === "ipv4" ? 4 : 6,
	};
}

export async function resolvePublicUrl(input: string, lookup: DnsLookup = defaultLookup): Promise<ResolvedPublicUrl> {
	if (input.length > 4_096) throw new WebNetworkError("web_fetch URL must not exceed 4096 characters");
	let url: URL;
	try {
		url = new URL(input);
	} catch (error) {
		throw new WebNetworkError("web_fetch requires a valid absolute URL", { cause: error });
	}

	if (url.href.length > 4_096) throw new WebNetworkError("web_fetch URL must not exceed 4096 characters");
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new WebNetworkError("web_fetch supports only public HTTP(S) URLs");
	}
	if (url.username || url.password) {
		throw new WebNetworkError("web_fetch does not allow credentials in URLs");
	}
	if (url.port) {
		throw new WebNetworkError("web_fetch allows only standard HTTP(S) ports");
	}

	const hostname = unbracket(url.hostname).toLowerCase();
	const policyHostname = hostname.replace(/\.+$/u, "");
	if (!policyHostname || policyHostname === "localhost" || policyHostname.endsWith(".localhost")) {
		throw new WebNetworkError("web_fetch requires a public Internet host");
	}

	let addresses: ResolvedAddress[];
	if (ipaddr.isValid(hostname)) {
		const parsed = ipaddr.process(hostname);
		addresses = [{ address: parsed.toString(), family: parsed.kind() === "ipv4" ? 4 : 6 }];
	} else {
		try {
			addresses = (await lookup(hostname)).map(normalizeAddress);
		} catch (error) {
			throw new WebNetworkError(`Unable to resolve public host ${url.hostname}`, { cause: error });
		}
	}

	if (addresses.length === 0) throw new WebNetworkError(`Unable to resolve public host ${url.hostname}`);
	if (addresses.some(({ address }) => !isPublicAddress(address))) {
		throw new WebNetworkError(`Host ${url.hostname} resolved to a non-public address`);
	}

	const unique = new Map(addresses.map((address) => [`${address.family}:${address.address}`, address]));
	return { url, addresses: [...unique.values()] };
}
