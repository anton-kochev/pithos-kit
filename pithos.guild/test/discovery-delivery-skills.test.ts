import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

const guildRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(guildRoot, "..");
const definitions = [
  {
    name: "technical-discovery",
    references: ["discovery-and-evidence.md", "requirements.md", "design-and-decisions.md", "artifact-review.md"],
    templates: ["brief.md", "specification.md", "adr.md"],
  },
  {
    name: "delivery-planning",
    references: ["slicing-and-sequencing.md", "agent-handoffs.md"],
    templates: ["delivery-slice.md"],
  },
];

type Capability = { name: string; summary: string; usage?: string };
type Metadata = { skills: Capability[]; commands: Capability[] };
type Manifest = { name: string; files: string[]; pi: { skills: string[] }; pithosKit: Metadata };
type Catalog = { packages: Array<{ name: string; pithosKit: Metadata }> };
const json = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const links = (text: string): string[] => [...text.matchAll(/\]\(([^)]+)\)/gu)].map(match => match[1]);

for (const definition of definitions) {
  const skillRoot = resolve(guildRoot, "skills", definition.name);
  const read = (path: string) => readFileSync(resolve(skillRoot, path), "utf8");

  describe(`Guild ${definition.name} skill packaging`, () => {
    it("loads as one parent-discoverable skill, not separate reference or template skills", () => {
      const result = loadSkillsFromDir({ dir: skillRoot, source: "test" });
      assert.deepEqual(result.diagnostics, []);
      assert.equal(result.skills.length, 1);
      assert.equal(result.skills[0].name, definition.name);
      assert.equal(result.skills[0].filePath, resolve(skillRoot, "SKILL.md"));
      assert.equal(result.skills[0].disableModelInvocation, false);
      assert.ok(result.skills[0].description.length > 0);
      assert.ok(result.skills[0].description.length <= 1024);
    });

    it("advertises matching commands and capabilities in the manifest, catalog, and README", () => {
      const manifest = json<Manifest>(resolve(guildRoot, "package.json"));
      const catalog = json<Catalog>(resolve(repositoryRoot, "pithos.atlas/src/generated/catalog.json"));
      const catalogGuild = catalog.packages.find(entry => entry.name === manifest.name);
      assert.ok(catalogGuild);
      assert.ok(manifest.pi.skills.includes("./skills"));
      assert.ok(manifest.files.includes("skills"));
      for (const metadata of [manifest.pithosKit, catalogGuild.pithosKit]) {
        const skills = metadata.skills.filter(entry => entry.name === definition.name);
        const commands = metadata.commands.filter(entry => entry.name === `skill:${definition.name}`);
        assert.equal(skills.length, 1);
        assert.equal(commands.length, 1);
        assert.ok(skills[0].summary.trim());
        assert.ok(commands[0].summary.trim());
        assert.ok(commands[0].usage?.startsWith(`/skill:${definition.name}`));
      }
      assert.deepEqual(catalogGuild.pithosKit.skills, manifest.pithosKit.skills);
      const readme = readFileSync(resolve(guildRoot, "README.md"), "utf8");
      assert.ok(readme.includes(`/skill:${definition.name}`));
    });

    it("links all bundled references and optional templates from its core", () => {
      const coreLinks = links(read("SKILL.md"));
      for (const [directory, files] of [["references", definition.references], ["templates", definition.templates]] as const) {
        assert.deepEqual(readdirSync(resolve(skillRoot, directory)).sort(), [...files].sort());
        const expected = files.map(file => `${directory}/${file}`).sort();
        assert.deepEqual([...new Set(coreLinks.filter(link => link.startsWith(`${directory}/`)))].sort(), expected);
      }
    });

    it("resolves local links relative to each document and ships nonempty Markdown assets", () => {
      const files = ["SKILL.md", ...definition.references.map(file => `references/${file}`), ...definition.templates.map(file => `templates/${file}`)];
      for (const file of files) {
        const text = read(file);
        assert.match(text, /^# /mu, `Missing title: ${file}`);
        for (const link of links(text)) {
          if (/^https?:\/\//u.test(link) || link.startsWith("#")) continue;
          const path = decodeURIComponent(link.split("#")[0]);
          assert.ok(existsSync(resolve(skillRoot, dirname(file), path)), `${file}: missing ${link}`);
        }
      }
    });
  });
}
