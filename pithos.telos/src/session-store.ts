import { lstat, readFile, realpath } from "node:fs/promises";
import { parse, stringify } from "yaml";
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve, isAbsolute } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
	type ArtifactLoad, isMutatingOperation, assertSafePath, parseArtifactText, serializeArtifact, atomicWriteText,
} from "./artifact.ts";
import {
	applyTaskOperation, createEmptyArtifact, validateArtifact,
	type TaskArtifact, type TaskOperation, type TaskOperationResult,
} from "./tasks.ts";

export type TaskSession = Readonly<{
	cwd: string;
	sessionId: string;
	ephemeral: boolean;
	filePath?: string;
	sessionFile?: string;
}>;
export const EPHEMERAL_NOTICE = "Tasks for this unsaved session are memory-only and will not survive process exit.";
const memoryKey = Symbol.for("pithos.telos.session-memory.v1");
const shared = globalThis as typeof globalThis & {[memoryKey]?: Map<string, TaskArtifact>};
const memory = shared[memoryKey] ??= new Map<string, TaskArtifact>();
const lifecycleKey = Symbol.for("pithos.telos.session-lifecycle.v1");
const lifecycleShared = globalThis as typeof globalThis & {[lifecycleKey]?: {
	generations: Map<string, object>; owners: WeakMap<TaskSession, object>;
}};
const lifecycle = lifecycleShared[lifecycleKey] ??= {generations: new Map<string, object>(), owners: new WeakMap<TaskSession, object>()};
function trackOwner(owner: TaskSession): TaskSession {
	if (owner.ephemeral) {
		let generation = lifecycle.generations.get(key(owner));
		if (!generation) lifecycle.generations.set(key(owner), generation = {});
		lifecycle.owners.set(owner, generation);
	}
	return owner;
}
function assertLive(owner: TaskSession): void {
	if (owner.ephemeral && lifecycle.owners.get(owner) !== lifecycle.generations.get(key(owner))) throw new Error("Session tasks released");
}

export function canonicalCwd(cwd: string): string { return realpathSync(resolve(cwd)); }
export function sessionArtifactPath(cwd: string, id: string): string {
	return join(cwd, ".pi", "telos", "sessions", createHash("sha256").update(id).digest("hex") + ".md");
}
function sessionLocator(cwd: string, file: string): string {
	const absolute = resolve(cwd, file);
	try { return join(realpathSync(dirname(absolute)), basename(absolute)); }
	catch (error) {
		if (!unavailableSessionFile(error)) throw error;
		return absolute;
	}
}
function unavailableSessionFile(error: unknown): boolean {
	return ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "");
}
export function captureTaskSession(ctx: {cwd: string; sessionManager: {getSessionId(): string; getSessionFile(): string | undefined}}): TaskSession {
	const cwd = canonicalCwd(ctx.cwd);
	const sessionId = ctx.sessionManager.getSessionId();
	const sessionFile = ctx.sessionManager.getSessionFile();
	return trackOwner(Object.freeze({
		cwd, sessionId, ephemeral: sessionFile === undefined,
		...(sessionFile === undefined ? {} : {sessionFile: sessionLocator(cwd, sessionFile), filePath: sessionArtifactPath(cwd, sessionId)}),
	}));
}
export function snapshotSession(session: TaskSession): TaskSession {
	const owner = captureTaskSession({
		cwd: session.cwd,
		sessionManager: {getSessionId: () => session.sessionId, getSessionFile: () => session.sessionFile},
	});
	if (owner.ephemeral !== session.ephemeral || owner.filePath !== session.filePath) throw new Error("Invalid session owner path");
	if (owner.ephemeral) {
		const generation = lifecycle.owners.get(session) ?? lifecycle.owners.get(owner)!;
		lifecycle.owners.set(session, generation);
		lifecycle.owners.set(owner, generation);
	}
	return owner;
}
function key(owner: TaskSession): string { return JSON.stringify([owner.cwd, owner.sessionId]); }
/**
 * Release an outgoing owner's memory only (no persisted files are changed).
 * Call on shutdown except reload; reload intentionally retains memory. Invalidation
 * is immediate, then this promise drains pending operations. Captured old owners
 * reject future operations; a new capture of the same ID starts a fresh generation.
 * Releasing the old owner again cannot clear that replacement generation.
 */
export async function releaseSessionTasks(session: TaskSession): Promise<void> {
	const owner = snapshotSession(session);
	if (!owner.ephemeral || lifecycle.owners.get(owner) !== lifecycle.generations.get(key(owner))) return;
	lifecycle.generations.delete(key(owner));
	memory.delete(key(owner));
	await withFileMutationQueue(key(owner), async () => {});
}
export async function loadSessionTasks(session: TaskSession): Promise<ArtifactLoad> {
	const owner = snapshotSession(session);
	if (!owner.ephemeral) return (await readOwnedArtifact(owner)).load;
	assertLive(owner);
	const artifact = memory.get(key(owner));
	return {artifact: artifact ? validateArtifact(artifact) : createEmptyArtifact(), existed: artifact !== undefined};
}
export async function runSessionOperation(session: TaskSession, operation: TaskOperation): Promise<TaskOperationResult> {
	const owner = snapshotSession(session);
	assertLive(owner);
	return withFileMutationQueue(owner.filePath ?? key(owner), async () => {
		const before = await loadSessionTasks(owner);
		const result = applyTaskOperation(before.artifact, operation);
		if (!result.rejected && isMutatingOperation(operation)) {
			if (owner.ephemeral) {
				assertLive(owner);
				memory.set(key(owner), validateArtifact(result.artifact));
			} else {
				const previous = await readOwnedArtifact(owner);
				const observed = await observeSessionFile(owner) ?? (previous.owner?.sessionFile === owner.sessionFile ? previous.owner.observed : undefined);
				if (previous.owner && previous.owner.sessionFile !== owner.sessionFile && !observed) throw new Error("Artifact owner mismatch: unverified session location");
				const metadata: OwnerMetadata = {
					version: 1, cwd: owner.cwd, sessionId: owner.sessionId, sessionFile: owner.sessionFile!,
					...(observed ? {observed} : {}),
				};
				await atomicWriteText(owner.filePath!, serializeOwnedArtifact(result.artifact, metadata));
			}
		}
		return result;
	});
}

export type FileIdentity = {dev: number; ino: number};
export type OwnerMetadata = {
	version: 1;
	cwd: string;
	sessionId: string;
	sessionFile: string;
	observed?: {file: FileIdentity; parent: FileIdentity; headerHash: string; header: string};
};
export function identity(info: FileIdentity): FileIdentity { return {dev: info.dev, ino: info.ino}; }
export function sameIdentity(a: FileIdentity, b: FileIdentity): boolean { return a.dev === b.dev && a.ino === b.ino; }
export function contentHash(text: string): string { return createHash("sha256").update(text).digest("hex"); }
function validIdentity(value: unknown): value is FileIdentity {
	if (typeof value !== "object" || value === null) return false;
	const item = value as FileIdentity;
	return Number.isSafeInteger(item.dev) && item.dev >= 0 && Number.isSafeInteger(item.ino) && item.ino > 0;
}
export function parseOwnedArtifact(text: string, filePath: string, cwd: string): {load: ArtifactLoad; owner: OwnerMetadata} {
	const load = {artifact: parseArtifactText(text), existed: true};
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)!;
	const owner = parse(match[1])?.telos_owner as OwnerMetadata;
	if (!owner || owner.version !== 1 || owner.cwd !== cwd || typeof owner.sessionId !== "string" || !owner.sessionId ||
		typeof owner.sessionFile !== "string" || !isAbsolute(owner.sessionFile) || resolve(owner.sessionFile) !== owner.sessionFile ||
		sessionArtifactPath(cwd, owner.sessionId) !== filePath || owner.sessionFile === filePath) {
		throw new Error("Invalid artifact owner metadata");
	}
	if (owner.observed) {
		if (!validIdentity(owner.observed.file) || !validIdentity(owner.observed.parent) || !/^[a-f0-9]{64}$/.test(owner.observed.headerHash)) {
			throw new Error("Invalid observed owner identity");
		}
		const header = JSON.parse(owner.observed.header);
		if (contentHash(owner.observed.header) !== owner.observed.headerHash || header.type !== "session" || header.id !== owner.sessionId || header.cwd !== owner.cwd) {
			throw new Error("Invalid observed owner header");
		}
	}
	return {load, owner};
}
function serializeOwnedArtifact(artifact: TaskArtifact, owner: OwnerMetadata): string {
	return serializeArtifact(artifact).replace(/^---\n/, `---\n${stringify({telos_owner: owner}, {lineWidth: 0})}`);
}
export async function readOwnedArtifact(owner: TaskSession): Promise<{load: ArtifactLoad; owner?: OwnerMetadata}> {
	await assertSafePath(owner.filePath!);
	let text: string;
	try {
		text = await readFile(owner.filePath!, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return {load: {artifact: createEmptyArtifact(), existed: false}};
	}
	const parsed = parseOwnedArtifact(text, owner.filePath!, owner.cwd);
	if (parsed.owner.sessionId !== owner.sessionId || (parsed.owner.sessionFile !== owner.sessionFile && !await observeSessionFile(owner))) throw new Error("Artifact owner mismatch");
	return parsed;
}
async function observeSessionFile(owner: TaskSession): Promise<OwnerMetadata["observed"]> {
	const file = owner.sessionFile!;
	try {
		// Observation is optional; never follow a leaf symlink or bind a noncanonical parent.
		if (await realpath(dirname(file)) !== dirname(file)) return undefined;
		const info = await lstat(file);
		if (!info.isFile()) return undefined;
		const parent = await lstat(dirname(file));
		const headerText = (await readFile(file, "utf8")).split("\n")[0];
		let header;
		try { header = JSON.parse(headerText); }
		catch (error) { if (error instanceof SyntaxError) return undefined; throw error; }
		if (!header || header.type !== "session" || header.id !== owner.sessionId || typeof header.cwd !== "string" || canonicalCwd(header.cwd) !== owner.cwd) return undefined;
		const after = await lstat(file);
		if (!sameIdentity(info, after) || info.size !== after.size || info.mtimeMs !== after.mtimeMs) return undefined;
		const normalizedHeader = JSON.stringify({...header, cwd: owner.cwd});
		return {file: identity(info), parent: identity(parent), headerHash: contentHash(normalizedHeader), header: normalizedHeader};
	} catch (error) {
		if (unavailableSessionFile(error)) return undefined;
		throw error;
	}
}
