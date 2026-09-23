import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const guildRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(guildRoot, "..");
const atlasRoot = resolve(repositoryRoot, "pithos.atlas");
const skillPath = resolve(guildRoot, "skills/tdd/SKILL.md");
const retiredPackagePath = resolve(repositoryRoot, "pithos.skills");

function section(markdown: string, heading: string): string {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = `${markdown}\n## `.match(new RegExp(`^#{2,3} ${escapedHeading}\\n([\\s\\S]*?)(?=^#{2,3} )`, "mu"));
  assert.ok(match, `Expected section: ${heading}`);
  return match[1];
}

function activePackageDirectories(): string[] {
  return readdirSync(repositoryRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("pithos."))
    .map((entry) => resolve(repositoryRoot, entry.name));
}

function bundlesTddSkill(packageDirectory: string): boolean {
  const skillsRoot = resolve(packageDirectory, "skills");
  if (!existsSync(skillsRoot)) return false;

  const visit = (directory: string): boolean => readdirSync(directory, { withFileTypes: true }).some((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return visit(path);
    return entry.name === "SKILL.md" && /^name:\s*tdd\s*$/mu.test(readFileSync(path, "utf8"));
  });

  return visit(skillsRoot);
}

describe("Guild TDD skill", () => {
  it("preserves the TDD workflow under Guild native skill discovery", () => {
    const skill = readFileSync(skillPath, "utf8");
    const guild = JSON.parse(readFileSync(resolve(guildRoot, "package.json"), "utf8"));

    assert.match(skill, /^---\nname: tdd\n/mu);
    assert.ok(guild.pi.skills.includes("./skills"));
    assert.ok(guild.pithosKit.commands.some(({ name }: { name: string }) => name === "skill:tdd"));
    assert.ok(guild.pithosKit.skills.some(({ name }: { name: string }) => name === "tdd"));
    assert.ok(guild.files.includes("skills"));
    assert.equal(existsSync(retiredPackagePath), false);
  });

  it("proactively drives non-trivial logic while adapting to repository capabilities", () => {
    const skill = readFileSync(skillPath, "utf8");
    const posture = section(skill, "When to use TDD");
    const workflow = section(skill, "Repository and tool discovery");

    assert.match(posture, /proactive(?:ly)?[\s\S]*non-trivial logic/iu);
    assert.match(workflow, /inspect[\s\S]*(?:test runner|test command)[\s\S]*(?:repository|project)/iu);
    assert.match(workflow, /(?:available|supported) tools?[\s\S]*(?:adapt|capabilit)/iu);
  });

  it("preserves the core red-green-refactor design loop", () => {
    const skill = readFileSync(skillPath, "utf8");
    const testList = section(skill, "Phase 0 — Write the test list (before you touch code)");
    const red = section(skill, "Phase 1 — Red: write one failing test");
    const green = section(skill, "Phase 2 — Green: make it pass with the least code possible");
    const refactor = section(skill, "Phase 3 — Refactor: improve structure, change no behavior");
    const behavior = section(skill, "Test behavior, not implementation");

    assert.match(testList, /behaviors[\s\S]*Do \*\*not\*\* turn the whole list into tests at once/iu);
    assert.match(red, /exactly \*\*one\*\*[\s\S]*observable result/iu);
    assert.match(green, /simplest[\s\S]*(?:green|pass)[\s\S]*(?:Obvious Implementation|Fake It|Triangulate)/iu);
    assert.match(refactor, /structure without changing behavior[\s\S]*existing green tests/iu);
    assert.match(behavior, /observable behavior[\s\S]*Mock at the boundaries, not inside them/iu);
  });

  it("defines a valid red phase and requires truthful verification", () => {
    const skill = readFileSync(skillPath, "utf8");
    const red = section(skill, "Phase 1 — Red: write one failing test");
    const verification = section(skill, "Verification and reporting");

    assert.match(red, /expected[\s\S]*(?:missing[- ]symbol|compile|import)[\s\S]*(?:valid failure|is red)/iu);
    assert.match(red, /(?:unrelated|unexpected)[\s\S]*(?:harness|setup|configuration)[\s\S]*(?:does\s+not\s+count|is\s+not\s+red)/iu);
    assert.match(verification, /(?:never|do not|don't)[\s\S]*(?:claim|report)[\s\S]*(?:pass|green|success)[\s\S]*(?:unless|without)[\s\S]*(?:run|ran|execut)/iu);
    assert.match(verification, /report[\s\S]*(?:failure|unable|could not|not run)/iu);
  });

  it("documents pragmatic exceptions and distinguishes pinning from driving", () => {
    const skill = readFileSync(skillPath, "utf8");
    const exceptions = section(skill, "When to flex (and when to skip)");
    const pinning = section(skill, "Tests that pin instead of drive");

    for (const kind of ["metadata", "declarations", "configuration", "generated", "compiler-only"]) {
      assert.match(exceptions, new RegExp(kind, "iu"));
    }

    assert.match(pinning, /(?:written|added) after[\s\S]*(?:pin|describe|mirror)[\s\S]*(?:existing|implementation|code)/iu);
    assert.match(pinning, /(?:desired|required) behavior[\s\S]*(?:before|first)[\s\S]*(?:implementation|production code)/iu);
    assert.match(pinning, /characterization[\s\S]*legacy[\s\S]*(?:observable|current) behavior/iu);
    assert.match(pinning, /(?:invariant|deny-list|policy|configuration)[\s\S]*(?:already works|existing state|currently true)/iu);
    assert.match(pinning, /(?:manufacture|controlled)[\s\S]*(?:failure|mutation)[\s\S]*(?:revert|restore)/iu);
    assert.match(pinning, /mutation[\s\S]*test[\s\S]*(?:red|fail)[\s\S]*(?:message|diagnostic)/iu);
    assert.match(pinning, /(?:regenerat|isolated|uncommitted)[\s\S]*(?:never|do not)[\s\S]*(?:disable|weaken)[\s\S]*(?:control|protection)/iu);
    assert.match(pinning, /(?:do not|never)[\s\S]*(?:alter|modify)[\s\S]*user-authored[\s\S]*(?:unrelated )?changes/iu);
    assert.match(pinning, /(?:new(?:\s+or\s+changed)?|changed)\s+behavior[\s\S]*test-first/iu);

    const rules = section(skill, "The two rules that matter most");
    const antiPatterns = section(skill, "Anti-patterns to avoid");
    assert.match(rules, /(?:intentional|existing-state) pin[\s\S]*pass(?:es|ing)?[\s\S]*controlled red/iu);
    assert.match(antiPatterns, /(?:intentional|existing-state) pin[\s\S]*pass(?:es|ing)?[\s\S]*controlled red/iu);
  });

  it("removes the TDD capability and bundled definition from Atlas", () => {
    const atlas = JSON.parse(readFileSync(resolve(atlasRoot, "package.json"), "utf8"));

    assert.equal(atlas.pithosKit.commands.some(({ name }: { name: string }) => name === "skill:tdd"), false);
    assert.equal(atlas.pithosKit.skills.some(({ name }: { name: string }) => name === "tdd"), false);
    assert.equal(existsSync(resolve(atlasRoot, "skills/tdd/SKILL.md")), false);
  });

  it("points active migration guidance at Guild without creating duplicate owners", () => {
    const rootReadme = readFileSync(resolve(repositoryRoot, "README.md"), "utf8");
    const planReadme = readFileSync(resolve(repositoryRoot, "pithos.plan/README.md"), "utf8");
    const cutover = readFileSync(resolve(repositoryRoot, "CUTOVER.md"), "utf8");

    assert.match(rootReadme, /TDD workflow now ships with Guild/u);
    assert.match(rootReadme, /Coordinate Guild and Atlas releases[\s\S]*Guild 0\.3\.0 owns TDD[\s\S]*Atlas 0\.6\.0/u);
    assert.match(rootReadme, /completed Skills retirement baseline is Guild 0\.3\.0 with Atlas 0\.6\.0 or later/u);
    assert.doesNotMatch(rootReadme, /publish and verify Atlas 0\.5\.0 first/u);
    assert.match(planReadme, /Guild 0\.3\.0 for the relocated TDD skill[\s\S]*Atlas 0\.6\.0[\s\S]*no longer bundles it/u);
    assert.match(cutover, /pairs Guild 0\.3\.0 with Atlas 0\.6\.0 so Guild owns TDD[\s\S]*after Atlas stops registering them/u);
    assert.match(cutover, /TDD moved to @pithos-kit\/guild and SRS was removed/u);
  });

  it("has a single active metadata and bundled owner for the TDD skill", () => {
    const packageDirectories = activePackageDirectories();
    const metadataOwners = packageDirectories.filter((directory) => {
      const manifestPath = resolve(directory, "package.json");
      if (!existsSync(manifestPath)) return false;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      return manifest.pithosKit?.skills?.some(({ name }: { name: string }) => name === "tdd");
    });
    const bundledOwners = packageDirectories.filter(bundlesTddSkill);

    assert.deepEqual(metadataOwners, [guildRoot]);
    assert.deepEqual(bundledOwners, [guildRoot]);
  });
});
