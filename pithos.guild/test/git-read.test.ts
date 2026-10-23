import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { registerChildProtocol } from "../src/child-protocol.ts";
import { buildGitReadArguments, capGitOutput, GIT_READ_LIMITS, GIT_READ_TOOL, runGitRead } from "../src/git-read.ts";
import { childTools } from "../src/protocol.ts";
import { GUILD_ROLES } from "../src/agents.ts";
import { buildTask } from "./protocol-fixtures.ts";

function repository(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "guild-git-read-"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
	git("init", "-q");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "Test");
	fs.writeFileSync(path.join(root, "a.txt"), "one\n");
	git("add", "a.txt");
	git("commit", "-qm", "initial");
	return root;
}

describe("git_read", () => {
	it("accepts common read-only options and forces safe settings before them", () => {
		assert.deepEqual(buildGitReadArguments("diff", ["--stat", "--cached", "-U5", "HEAD~1", "--", "src/--output=x"]), [
			"--no-pager", "-c", "core.fsmonitor=false", "-c", "log.showSignature=false", "-c", "core.quotepath=off", "-c", "color.ui=never",
			"diff", "--no-ext-diff", "--no-textconv", "--no-color", "--stat", "--cached", "-U5", "HEAD~1", "--", "src/--output=x",
		]);
		assert.doesNotThrow(() => buildGitReadArguments("log", ["--oneline", "-n20", "--format=%h %s", "--since=2.weeks", "main..HEAD"]));
		assert.doesNotThrow(() => buildGitReadArguments("status", ["--porcelain=v1", "-uall", "--branch"]));
		assert.doesNotThrow(() => buildGitReadArguments("blame", ["-L10,20", "-w", "src/a.ts"]));
		assert.doesNotThrow(() => buildGitReadArguments("ls-files", ["--others", "--exclude-standard"]));
	});

	it("rejects writing, executing, abbreviated and unknown options", () => {
		for (const [subcommand, arg] of [
			["diff", "--output=/tmp/x"], ["diff", "--out=/tmp/x"], ["log", "--output=/tmp/x"], ["diff", "--ext-diff"], ["diff", "--textconv"],
			["log", "--show-signature"], ["log", "--format=%G?"], ["show", "--pretty=%GS"], ["diff", "-O/tmp/order"], ["status", "--porc"],
		] as const) {
			assert.throws(() => buildGitReadArguments(subcommand, [arg]), /git_read/, `${subcommand} ${arg}`);
		}
		assert.throws(() => buildGitReadArguments("diff", ["--stat", "x\0"]), /Invalid/);
		assert.throws(() => buildGitReadArguments("checkout" as any, []), /Unsupported/);
		assert.throws(() => buildGitReadArguments("diff", Array(GIT_READ_LIMITS.args + 1).fill("HEAD")), /Too many/);
	});

	it("shows uncommitted changes without taking the index lock", async () => {
		const root = repository();
		try {
			fs.writeFileSync(path.join(root, "clean.txt"), "clean\n");
			execFileSync("git", ["add", "clean.txt"], { cwd: root });
			execFileSync("git", ["commit", "-qm", "clean"], { cwd: root });
			// A stat-only change is what a plain `git status` would refresh into the index.
			const later = new Date(Date.now() + 5000);
			fs.utimesSync(path.join(root, "clean.txt"), later, later);
			fs.writeFileSync(path.join(root, "a.txt"), "one\ntwo\n");
			fs.writeFileSync(path.join(root, "new.txt"), "new\n");
			const index = path.join(root, ".git", "index");
			const staged = () => execFileSync("git", ["ls-files", "--stage"], { cwd: root, encoding: "utf8" });
			const stagedBefore = staged();
			const indexBefore = fs.statSync(index).mtimeMs;
			assert.match(await runGitRead(root, { subcommand: "status", args: ["--short"] }), /^ M a\.txt\n\?\? new\.txt/);
			assert.equal(fs.statSync(index).mtimeMs, indexBefore);
			assert.match(await runGitRead(root, { subcommand: "diff", args: [] }), /\+two/);
			assert.match(await runGitRead(root, { subcommand: "log", args: ["--oneline"] }), /initial/);
			// Plain `git diff` may refresh the stat cache; what is staged never changes.
			assert.equal(staged(), stagedBefore);
			assert.equal(await runGitRead(root, { subcommand: "diff", args: ["--cached"] }), "(no output)");
			await assert.rejects(runGitRead(root, { subcommand: "show", args: ["missing-revision"] }), /git show failed with exit/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps whole lines within the output cap and names the truncation", async () => {
		const line = Buffer.from(`${"x".repeat(99)}\n`);
		const text = capGitOutput(Buffer.concat(Array(1000).fill(line)), false);
		assert.ok(Buffer.byteLength(text) < GIT_READ_LIMITS.output + 200);
		assert.match(text, /x\n\n\[git_read output truncated at 51200 bytes/);
		assert.equal(capGitOutput(Buffer.from("small\n"), false), "small\n");
		const root = repository();
		try {
			fs.writeFileSync(path.join(root, "a.txt"), Buffer.concat(Array(2000).fill(line)));
			assert.match(await runGitRead(root, { subcommand: "diff", args: [] }), /truncated at 51200 bytes/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("is registered only for read-only roles", () => {
		for (const role of GUILD_ROLES) {
			const names: string[] = [];
			const pi = { on: () => undefined, registerTool: (tool: any) => names.push(tool.name), getActiveTools: () => [] };
			registerChildProtocol(pi as any, buildTask({ role, profile: "general", task: "Work" }));
			assert.equal(names.includes(GIT_READ_TOOL), role !== "coder", role);
			assert.equal(childTools(role).includes(GIT_READ_TOOL), role !== "coder", role);
		}
	});
});
