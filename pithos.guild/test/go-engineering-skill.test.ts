import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

const guildRoot = resolve(import.meta.dirname, "..");
const skillRoot = resolve(guildRoot, "skills/go-engineering");
const references = ["concurrency.md", "design-and-domain.md", "testing.md", "workloads.md"];
const read = (file: string) => readFileSync(resolve(skillRoot, file), "utf8");
const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));

describe("Guild go-engineering skill", () => {
  it("is discovered by Pi as one parent-invocable skill, not five standalone resources", () => {
    const result = loadSkillsFromDir({dir: skillRoot, source: "test"});
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.skills.length, 1);
    const skill = result.skills[0];
    assert.equal(skill.name, "go-engineering");
    assert.equal(skill.filePath, resolve(skillRoot, "SKILL.md"));
    assert.equal(skill.disableModelInvocation, false);
    assert.ok(skill.description.length > 0 && skill.description.length <= 1024);
    assert.match(skill.description, /repository[\s\S]*Go[\s\S]*versions/i);
  });

  it("publishes matching native discovery, command, catalog, and README metadata", () => {
    const manifest = json(resolve(guildRoot, "package.json"));
    const catalog = json(resolve(guildRoot, "../pithos.atlas/src/generated/catalog.json"));
    const catalogGuild = catalog.packages.find((entry: any) => entry.name === manifest.name);
    assert.ok(manifest.pi.skills.includes("./skills"));
    assert.ok(manifest.files.includes("skills"));
    assert.ok(manifest.files.includes("agents"));
    for (const metadata of [manifest.pithosKit, catalogGuild?.pithosKit]) {
      assert.ok(metadata);
      assert.equal(metadata.skills.filter((entry: any) => entry.name === "go-engineering").length, 1);
      assert.equal(metadata.commands.filter((entry: any) => entry.name === "skill:go-engineering").length, 1);
    }
    const readme = readFileSync(resolve(guildRoot, "README.md"), "utf8");
    assert.match(readme, /\/skill:go-engineering/);
    assert.match(readme, /\/guild-handover coder\/go/);
    assert.match(readme, /profile: "go"[\s\S]*id: "tdd"/);
  });

  it("ships exactly four selectively linked references with no broken local links", () => {
    const skill = read("SKILL.md");
    const links = [...skill.matchAll(/\]\((references\/[^)]+\.md)\)/g)].map(match => match[1]);
    assert.deepEqual(links.sort(), references.map(file => `references/${file}`));
    assert.deepEqual(readdirSync(resolve(skillRoot, "references")).sort(), references);
    assert.match(skill, /Load only the references needed/i);
    for (const file of ["SKILL.md", ...references.map(file => `references/${file}`)]) {
      for (const [, link] of read(file).matchAll(/\]\(([^)]+)\)/g)) {
        if (/^https:\/\//.test(link)) continue;
        assert.ok(existsSync(resolve(skillRoot, file, "..", link)), `${file}: ${link}`);
      }
    }
  });

  it("grounds work in Go versions and build evidence without granting upgrades or broader tools", () => {
    const skill = read("SKILL.md");
    for (const token of ["go.mod", "go.work", "go.sum", "GOTOOLCHAIN", "GOOS", "GOARCH", "cgo", "build tags"]) {
      assert.ok(skill.includes(token), `Missing discovery evidence: ${token}`);
    }
    assert.match(skill, /go\.sum[\s\S]*not an exact dependency lockfile/i);
    assert.match(skill, /stray snippet[\s\S]*does not establish scope/i);
    assert.match(skill, /Do not install tools[\s\S]*upgrade Go or dependencies[\s\S]*global Go/i);
    assert.match(skill, /Architect[\s\S]*read-only/);
    assert.match(skill, /children disable ambient skill discovery/);
    assert.match(skill, /Reuse the language-neutral `tdd`/);
    assert.match(skill, /Never claim a check passed unless it ran/i);
  });

  it("keeps domain modeling proportional and protects Go-specific public contracts", () => {
    const design = read("references/design-and-domain.md");
    assert.match(design, /simple CRUD[\s\S]*direct functions and structs/i);
    assert.match(design, /not a[\s\S]*mandatory `cmd\/`/);
    assert.match(design, /Constructors[\s\S]*cannot prevent all zero-value/i);
    assert.match(design, /Value copying is not deep copying/);
    assert.match(design, /bounded contexts[\s\S]*need not correspond[\s\S]*microservices/i);
    assert.match(design, /%w[\s\S]*errors\.Is[\s\S]*errors\.As/);
    assert.match(design, /wrapping[\s\S]*API commitment/i);
    assert.match(design, /Neither always-wrap nor never-wrap is sound/);
  });

  it("keeps test and concurrency guidance version-aware and honest about verification limits", () => {
    const testing = read("references/testing.md");
    const concurrency = read("references/concurrency.md");
    assert.match(testing, /Reuse `tdd`/);
    assert.match(testing, /table-driven tests when cases share/i);
    assert.match(testing, /synctest[\s\S]*only if[\s\S]*supports/);
    assert.match(testing, /Go 1\.25[\s\S]*Go 1\.24[\s\S]*Do not[\s\S]*upgrade/);
    assert.match(testing, /executed paths, not all races/);
    assert.match(testing, /Machine-readable modes may return success despite findings/);
    assert.match(testing, /tests actually executed/);
    assert.match(concurrency, /Cancellation does not roll back/);
    assert.match(concurrency, /Signal stop,[\s\S]*join owned workers/);
    assert.match(concurrency, /worker limit alone does not bound queued inputs/i);
    assert.match(concurrency, /Fake time is not synchronization/);
    assert.match(concurrency, /does not prove freedom from deadlocks/);
  });

  it("covers services, CLIs, and libraries without choosing a framework", () => {
    const workloads = read("references/workloads.md");
    for (const heading of ["Services and workers", "CLIs and repository tools", "Reusable libraries", "Security and performance across workloads"]) {
      assert.ok(workloads.includes(`## ${heading}`));
    }
    assert.match(workloads, /authorization[\s\S]*tenant and object ownership/i);
    assert.match(workloads, /exit status, output schema/);
    assert.match(workloads, /workspace replacement can hide/i);
    assert.match(workloads, /Profile representative workloads/);
  });
});
