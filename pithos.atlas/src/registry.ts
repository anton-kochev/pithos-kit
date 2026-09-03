import { rcompare, valid } from "semver";
import type { CatalogPackage } from "./catalog.ts";
import { validatePackageManifest } from "./catalog.ts";

const REGISTRY_ORIGIN = "https://registry.npmjs.org";
const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const PACKAGE_NAME_RE = /^@pithos-kit\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 4_000;

export class RegistryError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "RegistryError";
	}
}

export interface RegistryClientOptions {
	fetch?: typeof fetch;
	offline?: boolean;
	maxResponseBytes?: number;
	timeoutMs?: number;
}

export interface RegistryRequestOptions {
	signal?: AbortSignal;
	refresh?: boolean;
}

export class RegistryClient {
	readonly #fetch: typeof fetch;
	readonly #offline: boolean;
	readonly #maxResponseBytes: number;
	readonly #timeoutMs: number;
	readonly #latestCache = new Map<string, CatalogPackage>();
	readonly #versionsCache = new Map<string, CatalogPackage[]>();
	#discoveryCache: string[] | undefined;
	#piVersionCache: string | undefined;

	constructor(options: RegistryClientOptions = {}) {
		this.#fetch = options.fetch ?? globalThis.fetch;
		this.#offline = options.offline ?? false;
		this.#maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	async #responseBody(response: Response, target: string, signal: AbortSignal): Promise<string> {
		if (!response.body) return "";
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let bytes = 0;
		let removeAbort: (() => void) | undefined;
		try {
			while (true) {
				if (signal.aborted) {
					void reader.cancel().catch(() => undefined);
					throw new RegistryError(`Unable to read the npm registry response for ${target}`);
				}
				const read = reader.read();
				const abort = new Promise<never>((_resolve, reject) => {
					const onAbort = () => {
						void reader.cancel().catch(() => undefined);
						reject(new RegistryError(`Unable to read the npm registry response for ${target}`));
					};
					signal.addEventListener("abort", onAbort, { once: true });
					removeAbort = () => signal.removeEventListener("abort", onAbort);
				});
				const { done, value } = await Promise.race([read, abort]);
				removeAbort?.();
				removeAbort = undefined;
				if (done) break;
				bytes += value.byteLength;
				if (bytes > this.#maxResponseBytes) {
					await reader.cancel().catch(() => undefined);
					throw new RegistryError(`npm registry response for ${target} is too large`);
				}
				chunks.push(value);
			}
		} catch (error) {
			if (error instanceof RegistryError) throw error;
			throw new RegistryError(`Unable to read the npm registry response for ${target}`, { cause: error });
		} finally {
			removeAbort?.();
			try {
				reader.releaseLock();
			} catch {
				// A provider may leave read() pending after ignoring cancellation.
			}
		}
		return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes).toString("utf8");
	}

	async #json(path: string, target: string, callerSignal?: AbortSignal): Promise<unknown> {
		const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
		const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
		let response: Response;
		try {
			response = await this.#fetch(`${REGISTRY_ORIGIN}${path}`, {
				headers: { accept: "application/json" },
				redirect: "error",
				signal,
			});
		} catch (error) {
			throw new RegistryError(`Unable to reach the npm registry for ${target}`, { cause: error });
		}
		if (!response.ok) throw new RegistryError(`npm registry returned HTTP ${response.status} for ${target}`);
		const length = Number(response.headers.get("content-length"));
		if (Number.isFinite(length) && length > this.#maxResponseBytes) {
			await response.body?.cancel().catch(() => undefined);
			throw new RegistryError(`npm registry response for ${target} is too large`);
		}
		const body = await this.#responseBody(response, target, signal);
		try {
			return JSON.parse(body);
		} catch (error) {
			throw new RegistryError(`npm registry returned invalid JSON for ${target}`, { cause: error });
		}
	}

	async discover(options: RegistryRequestOptions = {}): Promise<string[]> {
		if (this.#offline) throw new RegistryError("npm registry access is disabled by PI_OFFLINE");
		if (this.#discoveryCache && !options.refresh) return [...this.#discoveryCache];
		const raw = await this.#json("/-/v1/search?text=scope%3Apithos-kit&size=250", "@pithos-kit search", options.signal);
		if (!raw || typeof raw !== "object" || !Array.isArray((raw as { objects?: unknown }).objects)) {
			throw new RegistryError("npm registry search returned invalid data");
		}
		const names = new Set<string>();
		for (const entry of (raw as { objects: unknown[] }).objects.slice(0, 250)) {
			if (!entry || typeof entry !== "object") continue;
			const pkg = (entry as { package?: unknown }).package;
			if (!pkg || typeof pkg !== "object") continue;
			const name = (pkg as { name?: unknown }).name;
			if (typeof name === "string" && PACKAGE_NAME_RE.test(name)) names.add(name);
		}
		this.#discoveryCache = [...names].sort();
		return [...this.#discoveryCache];
	}

	async latestPiVersion(options: RegistryRequestOptions = {}): Promise<string> {
		if (this.#offline) throw new RegistryError("npm registry access is disabled by PI_OFFLINE");
		if (this.#piVersionCache && !options.refresh) return this.#piVersionCache;
		const raw = await this.#json(`/${encodeURIComponent(PI_PACKAGE)}/latest`, "Pi", options.signal);
		if (!raw || typeof raw !== "object") throw new RegistryError("npm registry returned invalid metadata for Pi");
		const name = (raw as { name?: unknown }).name;
		const version = (raw as { version?: unknown }).version;
		if (name !== PI_PACKAGE || typeof version !== "string" || !valid(version)) {
			throw new RegistryError("npm registry returned invalid metadata for Pi");
		}
		this.#piVersionCache = version;
		return version;
	}

	async versions(name: string, options: RegistryRequestOptions = {}): Promise<CatalogPackage[]> {
		if (!PACKAGE_NAME_RE.test(name)) throw new RegistryError(`Invalid pithos-kit package name: ${name}`);
		if (this.#offline) throw new RegistryError("npm registry access is disabled by PI_OFFLINE");
		const cached = this.#versionsCache.get(name);
		if (cached && !options.refresh) return [...cached];
		const raw = await this.#json(`/${encodeURIComponent(name)}`, name, options.signal);
		if (!raw || typeof raw !== "object" || !((raw as { versions?: unknown }).versions instanceof Object)) {
			throw new RegistryError(`npm registry returned invalid version metadata for ${name}`);
		}
		const entries: CatalogPackage[] = [];
		for (const [version, value] of Object.entries((raw as { versions: Record<string, unknown> }).versions)) {
			try {
				const manifest = validatePackageManifest(value);
				if (manifest.name === name && manifest.version === version) entries.push(manifest);
			} catch {
				// Older or malformed releases without pithosKit metadata cannot be selected safely.
			}
		}
		if (entries.length === 0) throw new RegistryError(`npm registry returned no usable versions for ${name}`);
		entries.sort((left, right) => rcompare(left.version, right.version));
		this.#versionsCache.set(name, entries);
		return [...entries];
	}

	async latest(name: string, options: RegistryRequestOptions = {}): Promise<CatalogPackage> {
		if (!PACKAGE_NAME_RE.test(name)) throw new RegistryError(`Invalid pithos-kit package name: ${name}`);
		if (this.#offline) throw new RegistryError("npm registry access is disabled by PI_OFFLINE");
		const cached = this.#latestCache.get(name);
		if (cached && !options.refresh) return cached;

		const raw = await this.#json(`/${encodeURIComponent(name)}/latest`, name, options.signal);
		let manifest: CatalogPackage;
		try {
			manifest = validatePackageManifest(raw);
		} catch (error) {
			throw new RegistryError(`npm registry returned invalid package metadata for ${name}`, { cause: error });
		}
		if (manifest.name !== name) throw new RegistryError(`npm registry returned metadata for ${manifest.name}, expected ${name}`);
		this.#latestCache.set(name, manifest);
		return manifest;
	}
}

export function isOfflineEnvironment(value = process.env.PI_OFFLINE): boolean {
	return /^(?:1|true|yes)$/iu.test(value?.trim() ?? "");
}
