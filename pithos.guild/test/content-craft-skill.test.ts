import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { it } from "node:test";

const skillPath = new URL("../skills/content-craft/SKILL.md", import.meta.url);

it("exposes content-craft through parent discovery, package metadata and the generated catalog", async () => {
 const root = new URL("../", import.meta.url);
 const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
 const catalog = JSON.parse(await readFile(new URL("../pithos.atlas/src/generated/catalog.json", root), "utf8"));
 const catalogGuild = catalog.packages.find((entry: any) => entry.name === "@pithos-kit/guild");
 assert.ok(manifest.pi.skills.includes("./skills"));
 assert.ok(manifest.files.includes("skills"));
 for (const metadata of [manifest.pithosKit, catalogGuild.pithosKit]) {
  assert.ok(metadata.skills.some((entry: any) => entry.name === "content-craft"));
  assert.ok(metadata.commands.some((entry: any) => entry.name === "skill:content-craft"));
  assert.ok(metadata.agents.some((entry: any) => entry.name === "writer"));
 }
 const notice = await readFile(new URL("NOTICE.md", root), "utf8");
 assert.match(notice, /content-craft[\s\S]*Grimoire/);
 const skill = await readFile(skillPath, "utf8");
 assert.ok(Buffer.byteLength(skill) <= 32 * 1024);
 assert.doesNotMatch(skill, /Skill\(|AskUserQuestion|WebSearch|WebFetch|TaskCreate|grimoire\./);
});

it("publishes content-craft metadata and practical, grounded format guidance", async () => {
 const skill = await readFile(skillPath, "utf8");
 assert.match(skill, /^---\nname: content-craft\n/m);
 assert.match(skill, /description:[\s\S]*?audience-focused articles/);
 for (const format of ["article or blog", "tutorial", "story", "Podcast and video", "screenplay", "documentary"]) {
  assert.ok(skill.toLowerCase().includes(format.toLowerCase()), `missing guidance for ${format}`);
 }
 assert.match(skill, /Do not invent citations, quotations, statistics/);
 assert.match(skill, /Fiction may invent/);
 assert.match(skill, /clear safe destination/);
 assert.match(skill, /report only checks truly performed/);
 assert.match(skill, /publication readiness, reception, or publication outcomes/);
});
