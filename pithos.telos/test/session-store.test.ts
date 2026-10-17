import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile, readFile, mkdir, symlink, realpath, rename, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { it } from "node:test";
import { captureTaskSession, loadSessionTasks, runSessionOperation, EPHEMERAL_NOTICE } from "../src/session-store.ts";

export function capture(cwd: string, id: string, file?: string) {
 return captureTaskSession({cwd, sessionManager: {getSessionId: () => id, getSessionFile: () => file}});
}

it("keeps unsaved tasks in isolated reload-shared memory without touching disk", async () => {
 const cwd = await mkdtemp(join(tmpdir(), "telos-memory-"));
 try {
 const owner = capture(cwd, "../../unsafe");
 assert.equal(owner.ephemeral, true);
 assert.equal(owner.filePath, undefined);
 assert.ok(EPHEMERAL_NOTICE);
 const pending = runSessionOperation(owner, {action: "create", title: "memory"});
 assert.throws(() => { (owner as any).sessionId = "other"; });
 await pending;
 const reload = await import("../src/session-store.ts?reload-memory");
 assert.equal((await reload.loadSessionTasks(capture(cwd, "../../unsafe"))).artifact.tasks.length, 1);
 assert.equal((await loadSessionTasks(capture(cwd, "fork"))).artifact.tasks.length, 0);
 const other = await mkdtemp(join(tmpdir(), "telos-other-"));
 try { assert.equal((await loadSessionTasks(capture(other, "../../unsafe"))).artifact.tasks.length, 0); }
 finally { await rm(other, {recursive: true, force: true}); }
 assert.deepEqual(await readdir(cwd), []);
 } finally { await rm(cwd, {recursive: true, force: true}); }
});

it("persists complete owner-bound artifacts, isolates new IDs, and leaves legacy data unchanged", async () => {
 const cwd = await mkdtemp(join(tmpdir(), "telos-disk-"));
 try {
 const sessionFile = join(cwd, "session.jsonl");
 const id = "../../unsafe-id";
 await writeFile(sessionFile, JSON.stringify({type: "session", id, cwd}) + "\n");
 const owner = capture(cwd, id, sessionFile);
 assert.equal(owner.ephemeral, false);
 assert.match(owner.filePath!, /[a-f0-9]{64}\.md$/);
 await mkdir(join(cwd, ".pi"));
 const legacy = join(cwd, ".pi", "telos-tasks.md");
 await writeFile(legacy, "legacy untouched");
 await Promise.all(Array.from({length: 8}, (_, i) => runSessionOperation(owner, {action: "create", title: `disk ${i}`})));
 const text = await readFile(owner.filePath!, "utf8");
 assert.match(text, /telos_owner:/);
 const reload = await import("../src/session-store.ts?reload-disk");
 assert.equal((await reload.loadSessionTasks(owner)).artifact.tasks.length, 8);
 assert.equal((await loadSessionTasks(capture(cwd, "fork", sessionFile))).artifact.tasks.length, 0);
 await assert.rejects(() => loadSessionTasks({...owner, sessionId: "spoof"}), /owner/);
 await assert.rejects(() => loadSessionTasks({...owner, sessionFile: join(cwd, "other.jsonl")}), /owner/);
 assert.equal(await readFile(legacy, "utf8"), "legacy untouched");
 } finally { await rm(cwd, {recursive: true, force: true}); }
});

it("loads persisted tasks after a process restart without process-local memory", async () => {
 const {execFile} = await import("node:child_process");
 const {promisify} = await import("node:util");
 const cwd = await mkdtemp(join(tmpdir(), "telos-restart-"));
 try {
 const file = join(cwd, "restart.jsonl");
 await writeFile(file, JSON.stringify({type: "session", id: "restart", cwd}) + "\n");
 const owner = capture(cwd, "restart", file);
 await runSessionOperation(owner, {action: "create", title: "survives restart"});
 const moduleUrl = new URL("../src/session-store.ts", import.meta.url).href;
 const script = `import {loadSessionTasks} from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(await loadSessionTasks(${JSON.stringify(owner)})));`;
 const {stdout} = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script]);
 const loaded = JSON.parse(stdout);
 assert.equal(loaded.existed, true);
 assert.equal(loaded.artifact.tasks[0].title, "survives restart");
 } finally { await rm(cwd, {recursive: true, force: true}); }
});

it("observes a session through a symlink directory alias without blocking task writes", async () => {
 const root = await mkdtemp(join(tmpdir(), "telos-alias-"));
 const cwd = await realpath(root);
 try {
 const target = join(cwd, "sessions");
 const alias = join(cwd, "alias");
 await mkdir(target);
 await symlink(target, alias, "junction");
 await writeFile(join(target, "a.jsonl"), JSON.stringify({type: "session", id: "alias", cwd}) + "\n");
 const owner = capture(cwd, "alias", join(alias, "a.jsonl"));
 await runSessionOperation(owner, {action: "create", title: "alias task"});
 const {parseOwnedArtifact} = await import("../src/session-store.ts");
 const parsed = parseOwnedArtifact(await readFile(owner.filePath!, "utf8"), owner.filePath!, cwd);
 assert.equal(parsed.owner.sessionFile, join(target, "a.jsonl"));
 assert.ok(parsed.owner.observed);
 } finally { await rm(root, {recursive: true, force: true}); }
});

it("skips optional observation for malformed, mismatched, missing and unsafe session inputs", async () => {
 const root = await mkdtemp(join(tmpdir(), "telos-optional-"));
 const cwd = await realpath(root);
 try {
 const malformed = join(cwd, "malformed.jsonl");
 const mismatch = join(cwd, "mismatch.jsonl");
 const unsafe = join(cwd, "unsafe.jsonl");
 await writeFile(malformed, "not json\n");
 await writeFile(mismatch, JSON.stringify({type: "session", id: "someone else", cwd}) + "\n");
 await symlink(malformed, unsafe);
 for (const file of [malformed, mismatch, unsafe, join(cwd, "missing.jsonl"), cwd]) {
 const owner = capture(cwd, file, file);
 await runSessionOperation(owner, {action: "create", title: "still writable"});
 const {parseOwnedArtifact} = await import("../src/session-store.ts");
 assert.equal(parseOwnedArtifact(await readFile(owner.filePath!, "utf8"), owner.filePath!, cwd).owner.observed, undefined);
 }
 } finally { await rm(root, {recursive: true, force: true}); }
});

it("resumes a proven moved session read-only then rebinds observation on mutation", async () => {
 const root = await mkdtemp(join(tmpdir(), "telos-moved-"));
 const cwd = await realpath(root);
 try {
 const a = join(cwd, "a.jsonl");
 const b = join(cwd, "b.jsonl");
 await writeFile(a, JSON.stringify({type: "session", id: "moved", cwd}) + "\n");
 const original = capture(cwd, "moved", a);
 await runSessionOperation(original, {action: "create", title: "survives move"});
 const before = await readFile(original.filePath!, "utf8");
 const info = await stat(original.filePath!);
 await rename(a, b);
 const resumed = capture(cwd, "moved", b);
 assert.equal((await loadSessionTasks(resumed)).artifact.tasks[0].title, "survives move");
 assert.equal(await readFile(original.filePath!, "utf8"), before);
 assert.equal((await stat(original.filePath!)).ino, info.ino);
 assert.equal((await stat(original.filePath!)).mtimeMs, info.mtimeMs);
 await runSessionOperation(resumed, {action: "create", title: "after move"});
 const {parseOwnedArtifact} = await import("../src/session-store.ts");
 const parsed = parseOwnedArtifact(await readFile(original.filePath!, "utf8"), original.filePath!, cwd);
 assert.equal(parsed.load.artifact.tasks.length, 2);
 assert.equal(parsed.owner.sessionFile, b);
 assert.equal(parsed.owner.observed?.file.ino, (await stat(b)).ino);
 const forged = join(cwd, "forged.jsonl");
 for (const text of ["bad json", JSON.stringify({type: "session", id: "other", cwd}), JSON.stringify({type: "session", id: "moved", cwd: dirname(cwd)})]) {
 await writeFile(forged, text);
 await assert.rejects(() => loadSessionTasks(capture(cwd, "moved", forged)), /owner/);
 await assert.rejects(() => runSessionOperation(capture(cwd, "moved", forged), {action: "create", title: "forged"}), /owner/);
 }
 await assert.rejects(() => loadSessionTasks(original), /owner/);
 } finally { await rm(root, {recursive: true, force: true}); }
});

it("releases only ephemeral memory, fences pending work and isolates repeated owner IDs", async () => {
 const root = await mkdtemp(join(tmpdir(), "telos-release-"));
 const cwd = await realpath(root);
 try {
 const {releaseSessionTasks} = await import("../src/session-store.ts");
 assert.equal(typeof releaseSessionTasks, "function");
 const old = capture(cwd, "repeat");
 const other = capture(cwd, "other");
 await runSessionOperation(old, {action: "create", title: "outgoing"});
 await runSessionOperation(other, {action: "create", title: "isolated"});
 const pending = runSessionOperation(old, {action: "create", title: "must not resurrect"});
 const rejected = assert.rejects(pending, /released/);
 await releaseSessionTasks(old);
 await rejected;
 await assert.rejects(() => runSessionOperation(old, {action: "create", title: "stale"}), /released/);
 const fresh = capture(cwd, "repeat");
 assert.equal((await loadSessionTasks(fresh)).artifact.tasks.length, 0);
 await runSessionOperation(fresh, {action: "create", title: "new generation"});
 await releaseSessionTasks(old); // Idempotent: must not release the replacement owner.
 assert.equal((await loadSessionTasks(fresh)).artifact.tasks[0].title, "new generation");
 assert.equal((await loadSessionTasks(other)).artifact.tasks.length, 1);
 const reload = await import("../src/session-store.ts?reload-release");
 assert.equal((await reload.loadSessionTasks(fresh)).artifact.tasks.length, 1);
 await reload.releaseSessionTasks(fresh);
 assert.equal((await loadSessionTasks(capture(cwd, "repeat"))).existed, false);
 const file = join(cwd, "saved.jsonl");
 await writeFile(file, JSON.stringify({type: "session", id: "saved", cwd}) + "\n");
 const saved = capture(cwd, "saved", file);
 await runSessionOperation(saved, {action: "create", title: "persisted"});
 const text = await readFile(saved.filePath!, "utf8");
 await releaseSessionTasks(saved);
 assert.equal(await readFile(saved.filePath!, "utf8"), text);
 assert.equal((await loadSessionTasks(saved)).artifact.tasks.length, 1);
 } finally { await rm(root, {recursive: true, force: true}); }
});

it("does not resurrect memory when release occurs inside an in-flight operation", async () => {
 const root = await mkdtemp(join(tmpdir(), "telos-inflight-"));
 try {
 const {releaseSessionTasks} = await import("../src/session-store.ts");
 const owner = capture(root, "inflight");
 let released: Promise<void> | undefined;
 const operation = {action: "create" as const, get title() {
 released ??= releaseSessionTasks(owner);
 return "must not commit";
 }};
 await assert.rejects(() => runSessionOperation(owner, operation), /released/);
 await released;
 assert.equal((await loadSessionTasks(capture(root, "inflight"))).existed, false);
 } finally { await rm(root, {recursive: true, force: true}); }
});

it("propagates unrelated observation I/O errors rather than silently writing tasks", async (t) => {
 const root = await mkdtemp(join(tmpdir(), "telos-io-"));
 const cwd = await realpath(root);
 const fs = (await import("node:fs/promises")).default;
 const {syncBuiltinESMExports} = await import("node:module");
 try {
 const file = join(cwd, "session.jsonl");
 await writeFile(file, JSON.stringify({type: "session", id: "io", cwd}) + "\n");
 const owner = capture(cwd, "io", file);
 const originalRead = fs.readFile;
 const injected = Object.assign(new Error("injected session I/O failure"), {code: "EIO"});
 const mocked = t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
 if (args[0] === file) throw injected;
 return originalRead(...args);
 });
 syncBuiltinESMExports();
 try {
 await assert.rejects(() => runSessionOperation(owner, {action: "create", title: "not written"}), injected);
 await assert.rejects(() => stat(owner.filePath!), {code: "ENOENT"});
 } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
 } finally { await rm(root, {recursive: true, force: true}); }
});

it("preserves the basename of a session located directly under the filesystem root", async () => {
 const {parse} = await import("node:path");
 const cwd = await realpath(tmpdir());
 const file = join(parse(cwd).root, "telos-root-session.jsonl");
 assert.equal(capture(cwd, "root-locator", file).sessionFile, file);
});
