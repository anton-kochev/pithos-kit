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
 mkdirSync(join(root, "skills", "code-review-standards"), {recursive: true});
 return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}); });

it("selects exact package cores by role and required practice, with raw-byte receipts", async () => {
 const root = fixture();
 const tdd = "# TDD\nπ\n";
 writeFileSync(join(root, "skills/tdd/SKILL.md"), tdd);
 writeFileSync(join(root, "skills/code-review-standards/SKILL.md"), "# Review\n");
 for (const role of ["explorer", "architect", "coder", "reviewer"] as const) {
  const selected = await loadGuildSkillCores(root, role, []);
  assert.deepEqual(selected.map(s => s.receipt.id), role === "reviewer" ? ["code-review-standards"] : []);
 }
 const [selected] = await loadGuildSkillCores(root, "coder", [{id: "tdd", policy: "required"}]);
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
