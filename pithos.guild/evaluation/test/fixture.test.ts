import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFixture, snapshot, git } from "../src/fixture.ts";

test("fixture setup, Git inspection, and snapshots honor an expired deadline before work", async () => {
  const root = await mkdtemp(join(tmpdir(), "guild-fixture-deadline-test-"));
  try {
    const fixture = { files: { "a.txt": "a" }, staged: {}, untracked: {} }, cwd = join(root, "repo");
    const signal = AbortSignal.abort(new Error("deadline expired"));
    await assert.rejects(createFixture(cwd, fixture, signal), /deadline expired/);
    await createFixture(cwd, fixture);
    await assert.rejects(snapshot(cwd, signal), /deadline expired/);
    await assert.rejects(git(cwd, ["status"], {}, signal), /deadline expired/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("creates fresh Git index/worktree/untracked states without committing or copying graders", async () => {
  const root = await mkdtemp(join(tmpdir(), "guild-eval-test-"));
  try {
    const fixture = { files: { "a.txt": "working", "same.txt": "same" }, staged: { "a.txt": "index" }, untracked: { "notes.txt": "mine" } };
    const cwd = join(root, "repo");
    await createFixture(cwd, fixture);
    assert.equal(await git(cwd, ["show", ":a.txt"]), "index");
    assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "working");
    assert.match(await git(cwd, ["status", "--porcelain"]), /AM a.txt/);
    const before = await snapshot(cwd);
    await writeFile(join(cwd, "a.txt"), "new");
    await symlink("/nonexistent", join(cwd, "link"));
    const after = await snapshot(cwd);
    assert.notDeepEqual(after.files, before.files);
    assert.equal(after.files.link.kind, "symlink");
    assert.deepEqual(after.index, before.index);
    await writeFile(join(cwd, "__proto__"), "outside scope");
    assert.ok(Object.hasOwn((await snapshot(cwd)).files, "__proto__"));
    await assert.rejects(createFixture(cwd, fixture), /EEXIST/);
    const second = join(root, "second");
    await createFixture(second, fixture);
    assert.deepEqual((await snapshot(second)).files, before.files);
  } finally { await rm(root, { recursive: true, force: true }); }
});
