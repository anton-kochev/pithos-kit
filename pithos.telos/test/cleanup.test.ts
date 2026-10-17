import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, mkdir, symlink, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { it } from "node:test";
import { captureTaskSession, runSessionOperation, type TaskSession } from "../src/session-store.ts";
import { discoverCleanupCandidates, deleteCleanupCandidates, discardCleanupCandidates } from "../src/cleanup.ts";

function capture(cwd: string, id: string, file?: string) {
 return captureTaskSession({cwd, sessionManager: {getSessionId: () => id, getSessionFile: () => file}});
}
async function fixture() {
 const cwd = await mkdtemp(join(tmpdir(), "telos-cleanup-"));
 async function create(id: string, saved = true) {
 const file = join(cwd, id + ".jsonl");
 if (saved) await writeFile(file, JSON.stringify({type: "session", id, cwd}) + "\n");
 const owner = capture(cwd, id, file);
 await runSessionOperation(owner, {action: "create", title: id});
 return owner;
 }
 return {cwd, create, current: capture(cwd, "current"), dispose: () => rm(cwd, {recursive: true, force: true})};
}

it("discovers only proven orphan artifacts without deleting anything", async () => {
 const f = await fixture();
 try {
 const orphan = await f.create("orphan");
 await f.create("live");
 await f.create("never-persisted", false);
 const active = await f.create("active");
 await rm(active.sessionFile!);
 await rm(orphan.sessionFile!);
 const root = dirname(orphan.filePath!);
 await writeFile(join(root, "unknown.md"), "legacy or malformed");
 await symlink(orphan.filePath!, join(root, "link.md"));
 const candidates = await discoverCleanupCandidates(f.cwd, active);
 assert.equal(candidates.length, 1);
 assert.equal(candidates[0].filePath, orphan.filePath);
 assert.equal(candidates[0].sessionFile, orphan.sessionFile);
 assert.ok(await readFile(orphan.filePath!, "utf8"));
 const result = await deleteCleanupCandidates(f.cwd, active, candidates);
 assert.deepEqual(result, {deleted: 1, skipped: 0, failed: 0});
 await assert.rejects(() => readFile(orphan.filePath!), {code: "ENOENT"});
 } finally { await f.dispose(); }
});

it("rejects orphan metadata whose observed session header belongs to a different owner", async () => {
 const f = await fixture();
 try {
 const orphan = await f.create("spoof");
 await rm(orphan.sessionFile!);
 const text = await readFile(orphan.filePath!, "utf8");
 // Previously observed identity must include the actual matching session header, not just arbitrary numbers.
 const tampered = text.replace(/headerHash: [a-f0-9]+/, 'headerHash: "' + '0'.repeat(64) + '"');
 await writeFile(orphan.filePath!, tampered);
 assert.deepEqual(await discoverCleanupCandidates(f.cwd, f.current), []);
 } finally { await f.dispose(); }
});

it("rechecks confirmed content, identity, session absence, active owner, and candidate binding", async () => {
 const f = await fixture();
 try {
 const owners: TaskSession[] = [];
 for (const id of ["changed", "replaced", "reappeared", "active", "moved-parent", "spoofed"]) {
 const owner = await f.create(id);
 owners.push(owner);
 await rm(owner.sessionFile!);
 }
 const candidates = await discoverCleanupCandidates(f.cwd, f.current);
 assert.equal(candidates.length, 6);
 await writeFile(owners[0].filePath!, (await readFile(owners[0].filePath!, "utf8")) + "\nchanged");
 const replacement = owners[1].filePath! + ".replacement";
 await writeFile(replacement, await readFile(owners[1].filePath!, "utf8"));
 await rename(replacement, owners[1].filePath!);
 await writeFile(owners[2].sessionFile!, "reappeared");
 const spoofed = candidates.find(c => c.filePath === owners[5].filePath)!;
 assert.deepEqual(await deleteCleanupCandidates(f.cwd, f.current, [{...spoofed, filePath: owners[0].filePath!}]), {deleted: 0, skipped: 1, failed: 0});
 const active = owners[3];
 const selected = candidates.filter(c => c.filePath !== owners[4].filePath);
 const result = await deleteCleanupCandidates(f.cwd, active, selected);
 assert.deepEqual(result, {deleted: 1, skipped: 4, failed: 0});
 for (const owner of owners.slice(0, 5)) assert.ok(await readFile(owner.filePath!, "utf8"));
 // Losing the parent location is not proof the persisted session was removed.
 const parentOwner = owners[4];
 const parent = dirname(parentOwner.sessionFile!);
 const moved = parent + "-moved";
 await rename(parent, moved);
 try {
 await mkdir(parent);
 const remaining = candidates.filter(c => c.filePath === parentOwner.filePath);
 assert.deepEqual(await deleteCleanupCandidates(f.cwd, f.current, remaining), {deleted: 0, skipped: 1, failed: 0});
 } finally { await rm(parent, {recursive: true, force: true}); await rename(moved, parent); }
 } finally { await f.dispose(); }
});

it("discards cancelled preview bindings so they cannot be reused", async () => {
 const f = await fixture();
 try {
 const owner = await f.create("cancelled");
 await rm(owner.sessionFile!);
 const candidates = await discoverCleanupCandidates(f.cwd, f.current);
 assert.equal(candidates.length, 1);
 discardCleanupCandidates(candidates);
 discardCleanupCandidates(candidates);
 assert.deepEqual(await deleteCleanupCandidates(f.cwd, f.current, candidates), {deleted: 0, skipped: 1, failed: 0});
 assert.ok(await readFile(owner.filePath!, "utf8"));
 const fresh = await discoverCleanupCandidates(f.cwd, f.current);
 assert.deepEqual(await deleteCleanupCandidates(f.cwd, f.current, fresh), {deleted: 1, skipped: 0, failed: 0});
 } finally { await f.dispose(); }
});

it("does not traverse a symlinked cleanup directory", async () => {
 const f = await fixture();
 try {
 const owner = await f.create("symlink-root");
 await rm(owner.sessionFile!);
 const root = dirname(owner.filePath!);
 const moved = root + "-real";
 await rename(root, moved);
 await symlink(moved, root);
 assert.deepEqual(await discoverCleanupCandidates(f.cwd, f.current), []);
 } finally { await f.dispose(); }
});
