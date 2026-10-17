import { access, lstat, readFile, readdir, unlink, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { assertSafePath } from "./artifact.ts";
import {
	canonicalCwd, snapshotSession, parseOwnedArtifact, sameIdentity, identity, contentHash,
	type TaskSession, type OwnerMetadata, type FileIdentity,
} from "./session-store.ts";

export type CleanupCandidate = Readonly<{filePath: string; sessionFile: string; token: string}>;
type Binding = {
	candidate: CleanupCandidate;
	cwd: string;
	owner: OwnerMetadata;
	hash: string;
	identity: FileIdentity;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
};
const registryKey = Symbol.for("pithos.telos.cleanup-confirmations.v1");
const shared = globalThis as typeof globalThis & {[registryKey]?: Map<string, Binding>};
const bindings = shared[registryKey] ??= new Map<string, Binding>();

async function validRoot(cwd: string): Promise<string> {
	const root = join(cwd, ".pi", "telos", "sessions");
	await assertSafePath(root);
	if (!(await lstat(root)).isDirectory() || await realpath(root) !== root) throw new Error("Unsafe cleanup directory");
	return root;
}
async function sessionAbsent(owner: OwnerMetadata): Promise<boolean> {
	if (!owner.observed) return false;
	const parentPath = dirname(owner.sessionFile);
	await assertSafePath(owner.sessionFile);
	if (await realpath(parentPath) !== parentPath) return false;
	const parent = await lstat(parentPath);
	if (!parent.isDirectory() || !sameIdentity(parent, owner.observed.parent)) return false;
	await access(parentPath, constants.R_OK | constants.X_OK);
	// A missing/inaccessible ancestor is not proof of session absence.
	if ((await readdir(parentPath)).includes(owner.sessionFile.slice(parentPath.length + 1))) return false;
	try {
		await lstat(owner.sessionFile);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
}
async function inspect(filePath: string, cwd: string, current: TaskSession): Promise<Omit<Binding, "candidate"> | undefined> {
	await assertSafePath(filePath);
	const before = await lstat(filePath);
	if (!before.isFile() || before.isSymbolicLink()) return;
	const text = await readFile(filePath, "utf8");
	const {owner} = parseOwnedArtifact(text, filePath, cwd);
	if (owner.sessionId === current.sessionId || owner.sessionFile === current.sessionFile || !owner.observed) return;
	const after = await lstat(filePath);
	if (!sameIdentity(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return;
	if (!await sessionAbsent(owner)) return;
	return {cwd, owner, hash: contentHash(text), identity: identity(after), size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs};
}
function captureCurrent(cwd: string, current: TaskSession): TaskSession {
	const owner = snapshotSession(current);
	if (owner.cwd !== cwd) throw new Error("Cleanup current owner does not belong to cwd");
	return owner;
}
export async function discoverCleanupCandidates(cwd: string, current: TaskSession): Promise<CleanupCandidate[]> {
	const canonical = canonicalCwd(cwd);
	const active = captureCurrent(canonical, current);
	const candidates: CleanupCandidate[] = [];
	let root: string;
	try { root = await validRoot(canonical); } catch { return []; }
	for (const name of await readdir(root)) {
		if (!/^[a-f0-9]{64}\.md$/.test(name)) continue;
		const filePath = join(root, name);
		try {
			const binding = await withFileMutationQueue(filePath, () => inspect(filePath, canonical, active));
			if (!binding) continue;
			const candidate = Object.freeze({filePath, sessionFile: binding.owner.sessionFile, token: randomUUID()});
			bindings.set(candidate.token, {...binding, candidate});
			candidates.push(candidate);
		} catch { /* Unknown, malformed, inaccessible, or racing files are never eligible. */ }
	}
	return candidates;
}
export function discardCleanupCandidates(candidates: CleanupCandidate[]): void {
	for (const candidate of candidates) bindings.delete(candidate.token);
}

export async function deleteCleanupCandidates(cwd: string, current: TaskSession, candidates: CleanupCandidate[]): Promise<{deleted: number; skipped: number; failed: number}> {
	const canonical = canonicalCwd(cwd);
	const active = captureCurrent(canonical, current);
	const selected = candidates.map(candidate => ({...candidate}));
	const result = {deleted: 0, skipped: 0, failed: 0};
	for (const candidate of selected) {
		const binding = bindings.get(candidate.token);
		if (!binding || binding.cwd !== canonical || binding.candidate.filePath !== candidate.filePath || binding.candidate.sessionFile !== candidate.sessionFile) {
			result.skipped++;
			continue;
		}
		bindings.delete(candidate.token);
		await withFileMutationQueue(candidate.filePath, async () => {
			try {
				const root = await validRoot(canonical);
				if (dirname(candidate.filePath) !== root) { result.skipped++; return; }
				const fresh = await inspect(candidate.filePath, canonical, active);
				if (!fresh || fresh.hash !== binding.hash || !sameIdentity(fresh.identity, binding.identity) || fresh.size !== binding.size || fresh.mtimeMs !== binding.mtimeMs || fresh.ctimeMs !== binding.ctimeMs) {
					result.skipped++;
					return;
				}
				// Recheck absence last, immediately before unlink, under the cooperating-writer queue.
				if (!await sessionAbsent(fresh.owner)) { result.skipped++; return; }
			} catch { result.skipped++; return; }
			try { await unlink(candidate.filePath); result.deleted++; }
			catch { result.failed++; }
		});
	}
	return result;
}
