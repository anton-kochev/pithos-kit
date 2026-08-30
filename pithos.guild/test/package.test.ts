import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

describe("Guild package metadata", () => {
  it("publishes under the Guild package identity", () => {
    const packageJson = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"));

    assert.equal(packageJson.name, "@pithos-kit/guild");
    assert.equal(packageJson.repository.directory, "pithos.guild");
    assert.match(packageJson.description, /Guild members/);
    assert.match(packageJson.description, /TypeScript/i);
    assert.match(packageJson.description, /Rust/i);
    assert.match(packageJson.description, /review/i);
    assert.ok(packageJson.pithosKit.agents.some(({ name }: { name: string }) => name === "typescript-architect"));
    assert.ok(packageJson.pithosKit.agents.some(({ name }: { name: string }) => name === "typescript-coder"));
    assert.ok(packageJson.pithosKit.agents.some(({ name }: { name: string }) => name === "rust-coder"));
    assert.ok(packageJson.pithosKit.agents.some(({ name }: { name: string }) => name === "rust-architect"));
    assert.ok(packageJson.pithosKit.agents.some(({ name }: { name: string }) => name === "code-reviewer"));
  });

  it("documents the approved clean-break migration as future behavior", () => {
    const readme = readFileSync(resolve(import.meta.dirname, "../README.md"), "utf8");
    const heading = "## Approved future Guild migration (not current behavior)";
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

    assert.match(migration, /no user\/global Guild layer/i);
    assert.match(migration, /stops reading[\s\S]*`~\/\.pi\/agent\/agents`[\s\S]*`\.pi\/agents`[\s\S]*does not delete/i);
    assert.match(migration, /arbitrary prompt overrides are not auto-converted/i);
    assert.match(migration, /repository facts[\s\S]*`AGENTS\.md`/i);
    assert.match(migration, /repository profile and skill support[\s\S]*later phases/i);
    assert.match(migration, /package-owned compatibility inputs[\s\S]*do not change tools or authorization/i);
    assert.match(migration, /no alias sunset is promised/i);
    assert.match(migration, /documentation only[\s\S]*current Guild behavior/i);
  });
});
