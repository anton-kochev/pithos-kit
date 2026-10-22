import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import { loadGuildSkillCores } from "../src/resources.ts";

const roots: string[] = [];
function fixture() {
 const root = mkdtempSync(join(tmpdir(), "guild-resource-")); roots.push(root);
 mkdirSync(join(root, "skills", "tdd"), {recursive: true});
 mkdirSync(join(root, "skills", "code-comments"), {recursive: true});
 mkdirSync(join(root, "skills", "code-review-standards"), {recursive: true});
 return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}); });

it("selects exact package cores by role and required practice, with raw-byte receipts", async () => {
 const root = fixture();
 const tdd = "# TDD\nπ\n", comments = "# Comments\n🙂\r\n";
 writeFileSync(join(root, "skills/code-comments/SKILL.md"), comments);
 writeFileSync(join(root, "skills/tdd/SKILL.md"), tdd);
 writeFileSync(join(root, "skills/code-review-standards/SKILL.md"), "# Review\n");
 for (const role of ["explorer", "architect", "coder", "reviewer"] as const) {
  const selected = await loadGuildSkillCores(root, role, []);
  assert.deepEqual(selected.map(s => s.receipt.id), role === "reviewer" ? ["code-review-standards"] : role === "coder" ? ["code-comments"] : []);
 }
 const cores = await loadGuildSkillCores(root, "coder", [{id: "tdd", policy: "required"}]);
 assert.deepEqual(cores.map(core => core.receipt.id), ["tdd", "code-comments"]);
 const [selected, commentCore] = cores;
 assert.equal(commentCore.content, comments);
 assert.equal(commentCore.sourcePath, join(root, "skills/code-comments/SKILL.md"));
 assert.deepEqual(commentCore.receipt, {id: "code-comments", source: "package", path: "skills/code-comments/SKILL.md", bytes: Buffer.byteLength(comments), sha256: createHash("sha256").update(comments).digest("hex")});
 assert.equal(selected.content, tdd);
 assert.deepEqual(selected.receipt, {id: "tdd", source: "package", path: "skills/tdd/SKILL.md", bytes: Buffer.byteLength(tdd), sha256: createHash("sha256").update(tdd).digest("hex")});
 assert.equal(selected.sourcePath, join(root, "skills/tdd/SKILL.md"));
});

it("rejects missing, oversized, invalid UTF-8 and symlink-substituted cores", async () => {
 const root = fixture(), core = join(root, "skills/tdd/SKILL.md");
 await assert.rejects(loadGuildSkillCores(root, "coder", [{id: "tdd", policy: "required"}]), /skill|core|ENOENT/i);
 writeFileSync(core, Buffer.alloc(32 * 1024 + 1, 65));
 await assert.rejects(loadGuildSkillCores(root, "coder", [{id: "tdd", policy: "required"}]), /limit|size|large/i);
 writeFileSync(core, Buffer.from([0xff]));
 await assert.rejects(loadGuildSkillCores(root, "coder", [{id: "tdd", policy: "required"}]), /UTF-8/i);
 rmSync(core);
 const outside = join(root, "outside.md"); writeFileSync(outside, "substituted"); symlinkSync(outside, core);
 await assert.rejects(loadGuildSkillCores(root, "coder", [{id: "tdd", policy: "required"}]), /symlink|regular|canonical|package/i);
});

it("fails closed on invalid comment cores only for coders, with or without required TDD", async () => {
 for (const variant of ["missing", "oversized", "invalid UTF-8", "file symlink", "directory symlink", "directory", "parent file"] as const) {
  const root = fixture(), directory = join(root, "skills/code-comments"), core = join(directory, "SKILL.md");
  writeFileSync(join(root, "skills/tdd/SKILL.md"), "# TDD\n");
  writeFileSync(join(root, "skills/code-review-standards/SKILL.md"), "# Review\n");
  if (variant === "oversized") writeFileSync(core, Buffer.alloc(32 * 1024 + 1, 65));
  if (variant === "invalid UTF-8") writeFileSync(core, Buffer.from([0xff]));
  if (variant === "directory") mkdirSync(core);
  if (variant === "file symlink") {
   const outside = join(root, "outside.md"); writeFileSync(outside, "substitute"); symlinkSync(outside, core);
  }
  if (variant === "directory symlink") {
   const outside = join(root, "outside"); mkdirSync(outside); writeFileSync(join(outside, "SKILL.md"), "substitute");
   rmSync(directory, {recursive: true}); symlinkSync(outside, directory);
  }
  if (variant === "parent file") {rmSync(directory, {recursive: true}); writeFileSync(directory, "not a directory");}
  for (const practices of [[], [{id: "tdd" as const, policy: "required" as const}]]) {
   await assert.rejects(loadGuildSkillCores(root, "coder", practices), /ENOENT|size|limit|UTF-8|regular|canonical/i, variant);
  }
  for (const role of ["explorer", "architect", "reviewer"] as const) {
   assert.deepEqual((await loadGuildSkillCores(root, role, [])).map(core => core.receipt.id), role === "reviewer" ? ["code-review-standards"] : [], `${variant}: ${role}`);
  }
 }
});

it("accepts the comment core at the exact raw-byte limit and rejects a noncanonical package root", async () => {
 const root = fixture(), core = join(root, "skills/code-comments/SKILL.md");
 const raw = Buffer.alloc(32 * 1024, 65); writeFileSync(core, raw);
 const [selected] = await loadGuildSkillCores(root, "coder", []);
 assert.equal(selected.receipt.bytes, raw.length);
 assert.equal(selected.receipt.sha256, createHash("sha256").update(raw).digest("hex"));
 const alias = join(root, "alias"); symlinkSync(root, alias);
 await assert.rejects(loadGuildSkillCores(alias, "coder", []), /canonical/);
});
