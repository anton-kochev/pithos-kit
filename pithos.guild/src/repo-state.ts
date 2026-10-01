import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// Records the repository state a traced handover starts from, so the same task can later be
// replayed from identical files. Read-only for the repository: no index, ref or stash changes.
// Ignored files are not captured. Snapshots are private local files next to the trace.

const DEFAULT_MAX_PATCH_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_UNTRACKED_BYTES = 32 * 1024 * 1024;
const GIT_TIMEOUT_MS = 10_000;

export interface RepoStateSummary {
	/** Snapshot directory name, relative to the trace directory. */
	state?: string;
	root?: string;
	head?: string;
	branch?: string;
	dirty?: boolean;
	/** False when any part of the working tree could not be captured. */
	complete?: boolean;
	error?: string;
}

export interface CaptureRepoStateOptions {
	cwd: string;
	directory: string;
	maxPatchBytes?: number;
	maxUntrackedBytes?: number;
	now?: () => number;
}

interface UntrackedEntry {
	path: string;
	bytes?: number;
	mode?: number;
	symlink?: string;
}

export async function captureRepoState(options: CaptureRepoStateOptions): Promise<RepoStateSummary> {
	try {
		return await capture(options);
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

async function capture(options: CaptureRepoStateOptions): Promise<RepoStateSummary> {
	const maxPatchBytes = options.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES;
	const maxUntrackedBytes = options.maxUntrackedBytes ?? DEFAULT_MAX_UNTRACKED_BYTES;
	const inside = await git(options.cwd, ["rev-parse", "--is-inside-work-tree"]).catch(() => undefined);
	if (inside?.toString("utf8").trim() !== "true") return { error: "not a git repository" };
	const root = (await git(options.cwd, ["rev-parse", "--show-toplevel"])).toString("utf8").trim();
	const head = (await git(root, ["rev-parse", "--verify", "-q", "HEAD"]).catch(() => undefined))?.toString("utf8").trim() || undefined;
	const branch = (await git(root, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => undefined))?.toString("utf8").trim() || undefined;
	const skipped: Array<{ path: string; reason: string }> = [];

	let patch: Buffer | undefined;
	if (head) {
		patch = await git(root, ["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD"], maxPatchBytes).catch(() => undefined);
		if (!patch) skipped.push({ path: ".", reason: "tracked patch unavailable or over byte cap" });
	}

	const listed = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
	const untrackedPaths = listed.toString("utf8").split("\0").filter(Boolean).sort();

	fs.mkdirSync(options.directory, { recursive: true, mode: 0o700 });
	fs.chmodSync(options.directory, 0o700);
	const hasPatch = patch !== undefined && patch.length > 0;
	if (hasPatch) fs.writeFileSync(path.join(options.directory, "tracked.patch"), patch!, { mode: 0o600, flag: "wx" });

	const untracked: UntrackedEntry[] = [];
	let untrackedBytes = 0;
	for (const relative of untrackedPaths) {
		const source = path.join(root, relative);
		const stat = fs.lstatSync(source, { throwIfNoEntry: false });
		if (!stat) continue;
		if (stat.isSymbolicLink()) {
			untracked.push({ path: relative, symlink: fs.readlinkSync(source) });
			continue;
		}
		if (!stat.isFile()) {
			skipped.push({ path: relative, reason: "not a regular file" });
			continue;
		}
		if (untrackedBytes + stat.size > maxUntrackedBytes) {
			skipped.push({ path: relative, reason: "untracked byte cap" });
			continue;
		}
		const target = path.join(options.directory, "untracked", relative);
		fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
		fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
		fs.chmodSync(target, 0o600);
		untrackedBytes += stat.size;
		untracked.push({ path: relative, bytes: stat.size, mode: stat.mode & 0o777 });
	}

	const complete = skipped.length === 0;
	const manifest = {
		version: 1,
		capturedAt: (options.now ?? Date.now)(),
		cwd: options.cwd,
		root,
		...(head ? { head } : {}),
		...(branch ? { branch } : {}),
		trackedPatch: hasPatch ? "tracked.patch" : null,
		untracked,
		skipped,
		complete,
	};
	fs.writeFileSync(path.join(options.directory, "state.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
	return {
		state: path.basename(options.directory),
		root,
		...(head ? { head } : {}),
		...(branch ? { branch } : {}),
		dirty: hasPatch || untracked.length > 0 || skipped.length > 0,
		complete,
	};
}

/** Filesystem-safe snapshot name for a provider tool-call or direct run ID. */
export function repoStateName(runId: string): string {
	const safe = runId.replace(/[^A-Za-z0-9._-]/g, "_");
	return `${safe === "" || safe === "." || safe === ".." ? `run-${safe}` : safe}.state`;
}

function git(cwd: string, args: string[], maxBuffer = 16 * 1024 * 1024): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		execFile("git", ["-c", "core.quotepath=off", ...args], { cwd, encoding: "buffer", maxBuffer, timeout: GIT_TIMEOUT_MS, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }, (error, stdout) => {
			if (error) reject(error);
			else resolve(stdout);
		});
	});
}
