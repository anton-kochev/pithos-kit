import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { captureRepoState } from "../src/repo-state.ts";

function git(cwd: string, ...args: string[]) {
	return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
}

function dirtyRepository() {
	const repo = mkdtempSync(join(tmpdir(), "guild-repo-"));
	git(repo, "init", "-q", "-b", "main");
	writeFileSync(join(repo, "a.txt"), "one\n");
	writeFileSync(join(repo, ".gitignore"), "*.log\n");
	git(repo, "add", ".");
	git(repo, "commit", "-q", "-m", "init");
	writeFileSync(join(repo, "a.txt"), "two\n");
	writeFileSync(join(repo, "staged.txt"), "staged\n");
	git(repo, "add", "staged.txt");
	mkdirSync(join(repo, "sub"));
	writeFileSync(join(repo, "sub", "c.bin"), Buffer.from([0, 1, 2, 255, 10, 0]));
	writeFileSync(join(repo, "debug.log"), "ignored\n");
	return repo;
}

it("captures HEAD, tracked changes and untracked files without touching the index", async () => {
	const repo = dirtyRepository();
	const indexBefore = readFileSync(join(repo, ".git", "index"));
	const directory = join(mkdtempSync(join(tmpdir(), "guild-state-")), "run-1.state");
	const summary = await captureRepoState({ cwd: join(repo, "sub"), directory, now: () => 42 });
	const head = git(repo, "rev-parse", "HEAD");
	assert.deepEqual(summary, { state: "run-1.state", root: repo, head, branch: "main", dirty: true, complete: true });
	const manifest = JSON.parse(readFileSync(join(directory, "state.json"), "utf8"));
	assert.equal(manifest.version, 1);
	assert.equal(manifest.capturedAt, 42);
	assert.equal(manifest.cwd, join(repo, "sub"));
	assert.equal(manifest.trackedPatch, "tracked.patch");
	assert.deepEqual(manifest.untracked.map((file: { path: string }) => file.path), ["sub/c.bin"]);
	assert.deepEqual(manifest.skipped, []);
	assert.deepEqual(readFileSync(join(repo, ".git", "index")), indexBefore);
	assert.equal(statSync(directory).mode & 0o777, 0o700);
	assert.equal(statSync(join(directory, "tracked.patch")).mode & 0o777, 0o600);
	assert.equal(existsSync(join(directory, "untracked", "debug.log")), false);

	const restored = mkdtempSync(join(tmpdir(), "guild-restore-"));
	git(restored, "clone", "-q", repo, ".");
	git(restored, "checkout", "-q", manifest.head);
	git(restored, "apply", "--binary", join(directory, "tracked.patch"));
	cpSync(join(directory, "untracked"), restored, { recursive: true });
	for (const file of ["a.txt", "staged.txt", "sub/c.bin"]) {
		assert.deepEqual(readFileSync(join(restored, file)), readFileSync(join(repo, file)), file);
	}
});

it("reports a clean repository as not dirty with no patch", async () => {
	const repo = mkdtempSync(join(tmpdir(), "guild-repo-"));
	git(repo, "init", "-q", "-b", "main");
	writeFileSync(join(repo, "a.txt"), "one\n");
	git(repo, "add", ".");
	git(repo, "commit", "-q", "-m", "init");
	const directory = join(mkdtempSync(join(tmpdir(), "guild-state-")), "clean.state");
	const summary = await captureRepoState({ cwd: repo, directory });
	assert.equal(summary.dirty, false);
	assert.equal(summary.complete, true);
	const manifest = JSON.parse(readFileSync(join(directory, "state.json"), "utf8"));
	assert.equal(manifest.trackedPatch, null);
	assert.equal(existsSync(join(directory, "tracked.patch")), false);
});

it("marks the state incomplete when untracked files exceed the byte cap", async () => {
	const repo = dirtyRepository();
	writeFileSync(join(repo, "large.txt"), "x".repeat(200));
	const directory = join(mkdtempSync(join(tmpdir(), "guild-state-")), "cap.state");
	const summary = await captureRepoState({ cwd: repo, directory, maxUntrackedBytes: 100 });
	assert.equal(summary.complete, false);
	const manifest = JSON.parse(readFileSync(join(directory, "state.json"), "utf8"));
	assert.deepEqual(manifest.skipped, [{ path: "large.txt", reason: "untracked byte cap" }]);
	assert.deepEqual(manifest.untracked.map((file: { path: string }) => file.path), ["sub/c.bin"]);
});

it("returns an error summary outside a git repository without throwing or writing", async () => {
	const plain = mkdtempSync(join(tmpdir(), "guild-plain-"));
	const directory = join(mkdtempSync(join(tmpdir(), "guild-state-")), "none.state");
	const summary = await captureRepoState({ cwd: plain, directory });
	assert.equal(summary.state, undefined);
	assert.match(summary.error ?? "", /not a git repository/);
	assert.equal(existsSync(directory), false);
});
