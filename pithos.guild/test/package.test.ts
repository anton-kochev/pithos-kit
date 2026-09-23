import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const guildRoot = resolve(import.meta.dirname, "..");

function packageMetadata() {
  return JSON.parse(readFileSync(resolve(guildRoot, "package.json"), "utf8"));
}

describe("Guild package metadata", () => {
  it("publishes the canonical role/profile identity without override configuration", () => {
    const packageJson = packageMetadata();

    assert.equal(packageJson.name, "@pithos-kit/guild");
    assert.equal(packageJson.repository.directory, "pithos.guild");
    assert.match(packageJson.pithosKit.summary, /role\/profile/i);
    assert.deepEqual(
      packageJson.pithosKit.agents.map(({ name }: { name: string }) => name),
      ["explorer", "architect", "coder", "reviewer"],
    );
    assert.deepEqual(packageJson.pithosKit.configuration, []);

    const handover = packageJson.pithosKit.commands.find(
      ({ name }: { name: string }) => name === "guild-handover",
    );
    assert.match(handover?.usage ?? "", /role\/profile/);
    assert.match(
      packageJson.pithosKit.tools.find(({ name }: { name: string }) => name === "guild_handover")?.summary ?? "",
      /role\/profile/i,
    );
    assert.ok(packageJson.files.includes("agents"));
  });

  it("documents the completed clean-break migration and exact Phase 1 isolation", () => {
    const readme = readFileSync(resolve(guildRoot, "README.md"), "utf8");
    const heading = "## Package aliases and configuration migration";
    const start = readme.indexOf(heading);

    assert.notEqual(start, -1, `README must contain ${heading}`);
    const remainder = readme.slice(start + heading.length);
    const nextHeading = remainder.search(/^## /m);
    const migration = nextHeading === -1 ? remainder : remainder.slice(0, nextHeading);

    for (const mapping of [
      "dotnet-architect → architect/dotnet",
      "frontend-architect → architect/frontend",
      "typescript-architect → architect/typescript",
      "rust-architect → architect/rust",
      "csharp-coder → coder/dotnet",
      "angular-coder → coder/angular",
      "typescript-coder → coder/typescript",
      "rust-coder → coder/rust",
      "code-reviewer → reviewer/general",
    ]) {
      assert.ok(migration.includes(mapping), `Missing migration mapping: ${mapping}`);
    }

    assert.match(readme, /guild_handover\(\{ role: "coder", profile: "typescript", task:/);
    assert.match(readme, /only `coder` can edit, write, or invoke shell commands/i);
    assert.match(readme, /researcher.*intentionally unavailable/i);
    assert.match(migration, /no user\/global configuration layer/i);
    assert.match(migration, /no longer reads[\s\S]*`~\/\.pi\/agent\/agents`[\s\S]*`\.pi\/agents`/i);
    assert.match(migration, /does not delete those directories or their files/i);
    assert.match(migration, /arbitrary prompt overrides are not converted/i);
    assert.match(migration, /aliases cannot change prompts, profiles, or role tool ceilings/i);
    assert.match(readme, /`--no-extensions`[\s\S]*`--no-skills`[\s\S]*`--no-prompt-templates`[\s\S]*`--no-context-files`/i);
    assert.match(readme, /accepted handovers are serialized[\s\S]*FIFO/i);
    assert.doesNotMatch(readme, /Approved future Guild migration \(not current behavior\)/);
  });
});
