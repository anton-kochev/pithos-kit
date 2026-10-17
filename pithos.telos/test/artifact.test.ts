import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, stat, readdir, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
	loadTaskArtifact,
	mutateTaskArtifact,
	parseArtifactText,
	serializeArtifact,
	taskFilePath,
	writeTaskArtifact,
} from "../src/artifact";
import { createEmptyArtifact } from "../src/tasks";

const tempDirs: string[] = [];
const now = () => new Date("2026-06-02T12:00:00.000Z");

async function tempFile() {
	const dir = await mkdtemp(join(tmpdir(), "telos-test-"));
	tempDirs.push(dir);
	return join(dir, "telos-tasks.md");
}

after(async () => {
	for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

describe("Telos task artifact", () => {
	it("stores the task artifact under the .pi directory", () => {
		assert.equal(taskFilePath("/repo"), join("/repo", ".pi", "telos-tasks.md"));
	});

	it("serializes and parses YAML frontmatter as the canonical task data", () => {
		const artifact = createEmptyArtifact();
		const created = {
			...artifact,
			tasks: [
				{
					id: "TSK-abc123ef",
					title: "Write tests",
					status: "todo" as const,
					priority: "medium" as const,
					notes: "",
					dependencies: [],
					created: "2026-06-02T12:00:00.000Z",
					updated: "2026-06-02T12:00:00.000Z",
				},
			],
		};

		const text = serializeArtifact(created);
		assert.match(text, /^---\n/);
		assert.match(text, /telos_version: 1/);
		assert.match(text, /# Tasks/);
		assert.deepEqual(parseArtifactText(text), created);
	});

	it("rejects files without Telos frontmatter", () => {
		assert.throws(() => parseArtifactText("# Tasks\n\nNo frontmatter"), /Telos YAML frontmatter/);
	});

	it("creates a missing task artifact on successful mutation", async () => {
		const file = await tempFile();
		const result = await mutateTaskArtifact(file, { action: "create", title: "Write tests" }, now, () => "abc123ef");
		const written = await readFile(file, "utf8");

		assert.equal(result.task?.id, "TSK-abc123ef");
		assert.match(written, /telos_version: 1/);
		assert.match(written, /title: Write tests/);
		assert.match(written, /dependencies:\s*\[\]/);
	});

	it("leaves malformed artifacts unchanged when mutation validation fails", async () => {
		const file = await tempFile();
		const malformed = "---\ntelos_version: nope\ntasks: []\n---\n\n# Tasks\n";
		await writeFile(file, malformed, "utf8");

		await assert.rejects(
			() => mutateTaskArtifact(file, { action: "create", title: "Should not write" }, now),
			/telos_version/,
		);
		assert.equal(await readFile(file, "utf8"), malformed);
	});

	it("loads a missing artifact as an empty task list without creating a file", async () => {
		const file = await tempFile();
		const loaded = await loadTaskArtifact(file);

		assert.equal(loaded.existed, false);
		assert.deepEqual(loaded.artifact, createEmptyArtifact());
	});
});

 it("validates before creating directories and atomically preserves permissions", async () => {
 const file = await tempFile();
 const invalid = join(file, "nested", "tasks.md");
 await assert.rejects(() => writeTaskArtifact(invalid, {telos_version: 2, tasks: []} as any));
 await assert.rejects(() => stat(file), {code: "ENOENT"});
 await writeFile(file, "old", {mode: 0o640});
 const before = await stat(file);
 await writeTaskArtifact(file, createEmptyArtifact());
 const after = await stat(file);
 assert.notEqual(after.ino, before.ino);
 assert.equal(after.mode & 0o777, 0o640);
 assert.deepEqual(await readdir(join(file, "..")), ["telos-tasks.md"]);
 });

it("propagates non-missing read errors and rejects symlink write ancestors", async () => {
 const file = await tempFile();
 await writeFile(file, "not a directory");
 await assert.rejects(() => loadTaskArtifact(join(file, "child.md")), {code: "ENOTDIR"});
 const root = join(file, "..");
 const target = join(root, "target");
 const link = join(root, "link");
 await mkdir(target);
 await symlink(target, link);
 await assert.rejects(() => writeTaskArtifact(join(link, "tasks.md"), createEmptyArtifact()), /symlink/);
 assert.deepEqual(await readdir(target), []);
});

it("cleans the exclusive temporary file when atomic rename fails without changing the destination", async (t) => {
 const fs = (await import("node:fs/promises")).default;
 const {syncBuiltinESMExports} = await import("node:module");
 const file = await tempFile();
 await writeFile(file, "original");
 const renameMock = t.mock.method(fs, "rename", async () => { throw Object.assign(new Error("injected rename failure"), {code: "EIO"}); });
 syncBuiltinESMExports();
 try {
 await assert.rejects(() => writeTaskArtifact(file, createEmptyArtifact()), /injected rename failure/);
 assert.equal(await readFile(file, "utf8"), "original");
 assert.deepEqual(await readdir(join(file, "..")), ["telos-tasks.md"]);
 } finally { renameMock.mock.restore(); syncBuiltinESMExports(); }
});

it("walks every native path ancestor including Windows backslashes", async () => {
 const {pathAncestors} = await import("../src/artifact.ts");
 const {win32, posix} = await import("node:path");
 assert.deepEqual(pathAncestors("C:\\repo\\link\\tasks.md", win32), ["C:\\repo", "C:\\repo\\link", "C:\\repo\\link\\tasks.md"]);
 assert.deepEqual(pathAncestors("/repo/link/tasks.md", posix), ["/repo", "/repo/link", "/repo/link/tasks.md"]);
});
