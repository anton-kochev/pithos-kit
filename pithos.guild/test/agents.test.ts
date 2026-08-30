import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  GUILD_MEMBER_NAMES,
  GUILD_MEMBER_POLICIES,
  discoverGuildMembers,
  findNearestProjectAgentsDir,
} from "../src/agents";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-guild-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeAgent(
  directory: string,
  name: string,
  description = `${name} description`,
  tools = GUILD_MEMBER_POLICIES[name as keyof typeof GUILD_MEMBER_POLICIES]?.tools ?? ["read"],
  body = `System prompt for ${name}.`,
): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `${name}.md`),
    `---\nname: ${name}\ndescription: ${description}\ntools: ${tools.join(", ")}\n---\n\n${body}\n`,
  );
}

function writeRawAgent(directory: string, fileName: string, content: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, fileName), content);
}

function markdownSection(content: string, heading: RegExp): string {
  const section = content
    .split(/(?=^## )/m)
    .find((candidate) => heading.test(candidate.split("\n", 1)[0] ?? ""));
  assert.ok(section, `Missing Markdown section matching ${heading}`);
  return section;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("Guild member policies", () => {
  it("defines the approved narrow roster and hard role tool boundaries", () => {
    assert.deepEqual(GUILD_MEMBER_NAMES, [
      "dotnet-architect",
      "frontend-architect",
      "typescript-architect",
      "csharp-coder",
      "angular-coder",
      "typescript-coder",
      "rust-coder",
      "rust-architect",
      "code-reviewer",
    ]);
    assert.deepEqual(GUILD_MEMBER_POLICIES["dotnet-architect"].tools, ["read", "grep", "find", "ls"]);
    assert.deepEqual(GUILD_MEMBER_POLICIES["frontend-architect"].tools, ["read", "grep", "find", "ls"]);
    assert.deepEqual(GUILD_MEMBER_POLICIES["typescript-architect"].tools, ["read", "grep", "find", "ls"]);
    assert.equal(GUILD_MEMBER_POLICIES["typescript-architect"].role, "architect");
    assert.deepEqual(GUILD_MEMBER_POLICIES["csharp-coder"].tools, ["read", "grep", "find", "ls", "edit", "write", "bash"]);
    assert.deepEqual(GUILD_MEMBER_POLICIES["angular-coder"].tools, ["read", "grep", "find", "ls", "edit", "write", "bash"]);
    assert.deepEqual(GUILD_MEMBER_POLICIES["typescript-coder"].tools, ["read", "grep", "find", "ls", "edit", "write", "bash"]);
    assert.deepEqual(GUILD_MEMBER_POLICIES["rust-coder"].tools, ["read", "grep", "find", "ls", "edit", "write", "bash"]);
    assert.deepEqual(GUILD_MEMBER_POLICIES["rust-architect"].tools, ["read", "grep", "find", "ls"]);
    assert.equal(GUILD_MEMBER_POLICIES["rust-architect"].role, "architect");
    assert.deepEqual(GUILD_MEMBER_POLICIES["code-reviewer"].tools, ["read", "grep", "find", "ls", "bash"]);
    assert.equal(GUILD_MEMBER_POLICIES["code-reviewer"].role, "reviewer");
  });

  it("pins reviewer bash access as a known temporary legacy limitation", () => {
    assert.deepEqual(GUILD_MEMBER_POLICIES["code-reviewer"].tools, ["read", "grep", "find", "ls", "bash"]);
    assert.ok(GUILD_MEMBER_POLICIES["code-reviewer"].tools.includes("bash"));
  });

  it("ships one valid built-in definition for every approved Guild member", () => {
    const builtInDir = resolve(import.meta.dirname, "../agents");
    const result = discoverGuildMembers({ builtInDir });

    assert.deepEqual(result.members.map((agent) => agent.name), GUILD_MEMBER_NAMES);
    assert.ok(result.members.every((agent) => agent.source === "builtin"));
    assert.deepEqual(result.warnings, []);
  });

  it("keeps the .NET architect read-only, repository-aware, and at architecture altitude", () => {
    const builtInDir = resolve(import.meta.dirname, "../agents");
    const member = discoverGuildMembers({ builtInDir }).members.find(({ name }) => name === "dotnet-architect");

    assert.ok(member);
    assert.deepEqual(member.tools, ["read", "grep", "find", "ls"]);
    const prompt = member.systemPrompt;
    assert.match(prompt, /read-only[\s\S]*Never create, edit, or delete files, run shell commands/i);
    assert.match(prompt, /eligibility gate[\s\S]*verify[\s\S]*(?:\.sln|\.csproj)[\s\S]*refuse/i);
    assert.match(prompt, /refuse[\s\S]{0,240}(?:outside|does not belong to)[\s\S]{0,120}\.NET/i);
    assert.match(prompt, /refuse[\s\S]{0,300}repository[\s\S]{0,200}(?:no relevant|does not contain)[\s\S]{0,120}(?:\.NET|C#)/i);
    assert.match(prompt, /explain[\s\S]{0,120}(?:why|reason|evidence)/i);
    assert.match(prompt, /architecture altitude[\s\S]*contract snippet declares members; it does not implement them/i);
    assert.match(prompt, /Read before designing[\s\S]*target frameworks[\s\S]*language and package versions/i);
    assert.match(prompt, /Apply principles as tools, not rituals/i);
    assert.match(prompt, /Clean Architecture[\s\S]*Domain-Driven Design/i);
    assert.match(prompt, /red-green-refactor/i);
    assert.match(prompt, /nullable annotations[^\n]*(?:supported|enabled|configuration|settings)/i);
    assert.match(prompt, /Entity Framework Core/i);
    assert.match(prompt, /Azure Functions/i);
    assert.match(prompt, /Failure, security, and operations[\s\S]*Performance/i);
    assert.match(prompt, /Quality checklist/i);
    assert.match(prompt, /Test Plan[\s\S]*Handoff[\s\S]*(?:affected paths or areas)[\s\S]*implementation order[\s\S]*acceptance criteria[\s\S]*constraints/i);
    assert.match(prompt, /Never[\s\S]{0,100}claim(?:ed)? to have implemented/i);
    assert.doesNotMatch(prompt, /csharp-coder/i);
    assert.doesNotMatch(prompt, /grimoire\.dotnet-architect|CLAUDE\.md|\bBash\b|\bSkill\b/i);
    assert.doesNotMatch(prompt, /(?:\.NET|C#)\s*(?:8|9|10|11|12)(?:\+|\.0|\s+or\s+(?:later|newer)|\s+and\s+(?:later|newer))/i);
  });

  it("keeps the front-end architect read-only, framework-aware, and at architecture altitude", () => {
    const builtInDir = resolve(import.meta.dirname, "../agents");
    const member = discoverGuildMembers({ builtInDir }).members.find(({ name }) => name === "frontend-architect");

    assert.ok(member);
    assert.deepEqual(member.tools, ["read", "grep", "find", "ls"]);
    const prompt = member.systemPrompt;
    assert.match(prompt, /read-only[\s\S]*Never create, edit, or delete files, run shell commands/i);
    assert.match(prompt, /architecture altitude[\s\S]*contract snippet declares members; it does not implement them/i);
    assert.match(prompt, /package manifests[\s\S]*lockfiles[\s\S]*framework[\s\S]*version/i);
    assert.match(prompt, /component[\s\S]*state ownership[\s\S]*data flow[\s\S]*routing[\s\S]*rendering/i);
    assert.match(prompt, /server state[\s\S]*client state/i);
    assert.match(prompt, /Angular[\s\S]*Vue/i);
    assert.match(prompt, /version-sensitive[\s\S]*(?:verify|evidence|repository)/i);
    assert.match(prompt, /accessibility[\s\S]*performance/i);
    assert.match(prompt, /loading, empty, and error states/i);
    assert.match(prompt, /red-green-refactor/i);
    assert.match(prompt, /Apply principles as tools, not rituals/i);
    assert.match(prompt, /Project best practice[\s\S]*Local convention[\s\S]*Questionable pattern[\s\S]*Anti-pattern/i);
    assert.match(prompt, /repository conventions and explicit user direction[\s\S]{0,240}(?:constraints|follow)[\s\S]{0,240}correctness[\s\S]{0,160}security[\s\S]{0,160}accessibility/i);
    assert.match(prompt, /When either conflicts[\s\S]{0,240}explain[\s\S]{0,160}smallest safer alternative/i);
    assert.match(prompt, /Test Plan[\s\S]*Handoff[\s\S]*(?:affected paths or areas)[\s\S]*implementation order[\s\S]*acceptance criteria[\s\S]*constraints/i);
    assert.match(prompt, /Quality checklist/i);
    assert.doesNotMatch(prompt, /angular-coder|vue-coder/i);
    assert.doesNotMatch(prompt, /grimoire\.frontend-architect|CLAUDE\.md|\bBash\b|\bSkill\b|WebSearch|WebFetch|context7/i);
  });

  it("keeps the TypeScript architect general, read-only, and runtime-aware", () => {
    const builtInDir = resolve(import.meta.dirname, "../agents");
    const member = discoverGuildMembers({ builtInDir }).members.find(({ name }) => name === "typescript-architect");

    assert.ok(member);
    assert.deepEqual(member.tools, ["read", "grep", "find", "ls"]);
    const prompt = member.systemPrompt;

    const eligibility = markdownSection(prompt, /eligibility gate/i);
    assert.match(eligibility, /TypeScript/i);
    assert.match(eligibility, /JavaScript/i);
    assert.match(eligibility, /Node\.js/i);
    assert.match(eligibility, /tsconfig|package manifest/i);
    assert.match(eligibility, /substantive, relevant/i);
    assert.match(eligibility, /refuse/i);

    const boundary = markdownSection(prompt, /hard boundary/i);
    assert.match(boundary, /read-only/i);
    assert.match(boundary, /Never create, edit, or delete files, run shell commands/i);
    assert.match(boundary, /architecture altitude/i);
    assert.match(boundary, /load-bearing contracts/i);
    assert.match(boundary, /Never include function bodies/i);

    const workingMethod = markdownSection(prompt, /working method/i);
    for (const capability of [/package manifests/i, /lockfiles/i, /tsconfig/i, /Node\.js runtime/i, /module format/i, /strictness/i]) {
      assert.match(workingMethod, capability);
    }

    const guidance = markdownSection(prompt, /TypeScript and Node\.js architecture guidance/i);
    for (const responsibility of [
      /services/i,
      /libraries/i,
      /command-line/i,
      /workers/i,
      /developer tooling/i,
      /module boundaries/i,
      /package boundaries/i,
      /workspace/i,
      /dependency direction/i,
      /public API/i,
      /ESM/i,
      /CommonJS/i,
      /package `exports`/i,
      /runtime validation/i,
      /TypeScript types are erased/i,
      /event ordering/i,
      /AbortSignal/i,
      /backpressure/i,
      /startup or shutdown/i,
      /state owner/i,
      /schema ownership/i,
      /migration/i,
      /context isolation/i,
    ]) {
      assert.match(guidance, responsibility);
    }

    const piGuidance = markdownSection(prompt, /Pi extension and runtime architecture/i);
    assert.match(piGuidance, /only when repository evidence/i);
    for (const contract of [
      /ExtensionAPI/i,
      /lifecycle event ordering/i,
      /session_start/i,
      /session_shutdown/i,
      /session replacement/i,
      /stale/i,
      /appendEntry/i,
      /sendMessage/i,
      /model context/i,
      /TUI/i,
      /Markdown transformer/i,
      /streaming updates/i,
      /available width/i,
      /invalidate/i,
    ]) {
      assert.match(piGuidance, contract);
    }

    const existingCode = markdownSection(prompt, /existing-code judgment/i);
    for (const classification of [/Project best practice/i, /Local convention/i, /Questionable pattern/i, /Anti-pattern/i]) {
      assert.match(existingCode, classification);
    }

    const testDesign = markdownSection(prompt, /refactoring and test-driven design/i);
    assert.match(testDesign, /red-green-refactor/i);
    assert.match(testDesign, /does not write or run tests/i);

    const output = markdownSection(prompt, /required output/i);
    for (const deliverable of [/Summary/i, /Design or Findings/i, /Test Plan/i, /Trade-offs and Risks/i, /Handoff/i]) {
      assert.match(output, deliverable);
    }
    assert.match(output, /recipient-neutral/i);
    assert.match(output, /affected paths or areas/i);
    assert.match(output, /implementation order/i);
    assert.match(output, /acceptance criteria/i);
    assert.match(output, /constraints/i);

    assert.doesNotMatch(prompt, /typescript-coder/i);
    assert.doesNotMatch(prompt, /TypeScript(?:\s+version)?\s+\d+(?:\.\d+)?|Node(?:\.js)?(?:\s+version)?\s+\d+(?:\.\d+)?|Pi(?:\s+version)?\s+\d+(?:\.\d+)?/i);
  });

  it("keeps the C# coder repository-aware, test-driven, and implementation-focused", () => {
    const builtInDir = resolve(import.meta.dirname, "../agents");
    const member = discoverGuildMembers({ builtInDir }).members.find(({ name }) => name === "csharp-coder");

    assert.ok(member);
    assert.deepEqual(member.tools, ["read", "grep", "find", "ls", "edit", "write", "bash"]);
    const prompt = member.systemPrompt;
    assert.match(prompt, /eligibility gate[\s\S]*C#[\s\S]*(?:\.sln|\.csproj)[\s\S]*refuse/i);
    assert.match(prompt, /refuse[\s\S]{0,300}(?:outside|does not belong to)[\s\S]{0,120}(?:C#|\.NET)/i);
    assert.match(prompt, /refuse[\s\S]{0,360}repository[\s\S]{0,220}(?:no relevant|does not contain)[\s\S]{0,120}(?:C#|\.NET)/i);
    assert.match(prompt, /edit[^\n]*write[^\n]*file changes[\s\S]*bash[^\n]*(?:build|test|verification)/i);
    assert.match(prompt, /target frameworks[\s\S]*language version[\s\S]*nullable/i);
    assert.match(prompt, /repository-supported[\s\S]*(?:language|framework) features/i);
    assert.match(prompt, /red-green-refactor/i);
    assert.match(prompt, /CancellationToken[\s\S]*\.Result[\s\S]*\.Wait\(\)/i);
    assert.match(prompt, /repository conventions and explicit user direction[\s\S]{0,260}(?:constraints|follow)[\s\S]{0,260}correctness[\s\S]{0,180}security[\s\S]{0,180}maintainability/i);
    assert.match(prompt, /conflicts[\s\S]{0,300}(?:explain|document)[\s\S]{0,180}smallest safer alternative/i);
    assert.match(prompt, /Never report success[\s\S]{0,220}(?:compilation|tests)[\s\S]{0,220}(?:fail|blocked)/i);
    assert.match(prompt, /Status[\s\S]*Summary[\s\S]*Files Changed[\s\S]*Verification/i);
    assert.doesNotMatch(prompt, /grimoire\.csharp-coder|CLAUDE\.md|\bSkill\b|WebSearch|WebFetch|context7|TaskCreate|TaskUpdate|TaskList|TaskOutput|TaskStop/i);
    assert.doesNotMatch(prompt, /(?:\.NET|C#)\s*(?:8|9|10|11|12|13)(?:\+|\.0|\s+or\s+(?:later|newer)|\s+and\s+(?:later|newer))/i);
    assert.doesNotMatch(prompt, /No primary constructors/i);
  });

  it("keeps the Angular coder repository-aware, version-aware, and implementation-focused", () => {
    const builtInDir = resolve(import.meta.dirname, "../agents");
    const member = discoverGuildMembers({ builtInDir }).members.find(({ name }) => name === "angular-coder");

    assert.ok(member);
    assert.deepEqual(member.tools, ["read", "grep", "find", "ls", "edit", "write", "bash"]);
    const prompt = member.systemPrompt;
    assert.match(prompt, /eligibility gate[\s\S]*Angular[\s\S]*(?:angular\.json|@angular\/core)[\s\S]*refuse/i);
    assert.match(prompt, /refuse[\s\S]{0,300}(?:outside|does not belong to)[\s\S]{0,120}Angular/i);
    assert.match(prompt, /refuse[\s\S]{0,360}repository[\s\S]{0,220}(?:no relevant|does not contain)[\s\S]{0,120}Angular/i);
    assert.match(prompt, /edit[^\n]*write[^\n]*file changes[\s\S]*bash[^\n]*(?:build|test|verification)/i);
    assert.match(prompt, /Angular[\s\S]*TypeScript[\s\S]*RxJS[\s\S]*(?:versions|version)/i);
    assert.match(prompt, /repository-supported[\s\S]*(?:Angular|framework)[\s\S]*(?:APIs|features)/i);
    assert.match(prompt, /red-green-refactor/i);
    assert.match(prompt, /latest Angular-recommended[\s\S]{0,240}(?:default|prefer)[\s\S]{0,180}new code/i);
    assert.match(prompt, /standalone[\s\S]*OnPush[\s\S]*(?:built-in|modern) (?:template )?control flow[\s\S]*signal-based[\s\S]*inject\(\)[\s\S]*functional/i);
    assert.match(prompt, /repository version[\s\S]{0,220}(?:does not support|unsupported)[\s\S]{0,220}(?:compatible|upgrade)/i);
    assert.match(prompt, /RxJS[\s\S]*nested subscriptions[\s\S]*takeUntilDestroyed/i);
    assert.match(prompt, /typed reactive forms/i);
    assert.match(prompt, /semantic HTML[\s\S]*keyboard[\s\S]*focus[\s\S]*(?:announcements|screen reader)/i);
    assert.match(prompt, /repository conventions and explicit user direction[\s\S]{0,260}(?:constraints|follow)[\s\S]{0,260}correctness[\s\S]{0,180}security[\s\S]{0,180}accessibility/i);
    assert.match(prompt, /conflicts[\s\S]{0,300}(?:explain|document)[\s\S]{0,180}smallest safer alternative/i);
    assert.match(prompt, /Never report success[\s\S]{0,240}(?:type-checking|tests|build)[\s\S]{0,220}(?:fail|blocked)/i);
    assert.match(prompt, /Status[\s\S]*Summary[\s\S]*Files Changed[\s\S]*Verification/i);
    assert.doesNotMatch(prompt, /grimoire\.angular-coder|CLAUDE\.md|\bSkill\b|WebSearch|WebFetch|context7|TaskCreate|TaskUpdate|TaskList|TaskOutput|TaskStop|Persistent Agent Memory/i);
    assert.doesNotMatch(prompt, /Angular\s*(?:1[5-9]|2\d)(?:\+|\.0|\s+or\s+(?:later|newer)|\s+and\s+(?:later|newer))/i);
    assert.doesNotMatch(prompt, /(?:standalone components|ChangeDetectionStrategy\.OnPush|inject\(\)|functional guards)[^\n]*(?:Never|always)/i);
  });

  it("keeps the TypeScript coder repository-aware, type-safe, and runtime-aware", () => {
    const builtInDir = resolve(import.meta.dirname, "../agents");
    const member = discoverGuildMembers({ builtInDir }).members.find(({ name }) => name === "typescript-coder");

    assert.ok(member);
    assert.deepEqual(member.tools, ["read", "grep", "find", "ls", "edit", "write", "bash"]);
    const prompt = member.systemPrompt;
    assert.match(prompt, /eligibility gate[\s\S]*TypeScript[\s\S]*JavaScript[\s\S]*(?:tsconfig|package manifest)[\s\S]*refuse/i);
    assert.match(prompt, /refuse[\s\S]{0,320}(?:outside|does not belong to)[\s\S]{0,160}(?:TypeScript|JavaScript)/i);
    assert.match(prompt, /refuse[\s\S]{0,400}repository[\s\S]{0,260}(?:no relevant|does not contain)[\s\S]{0,160}(?:TypeScript|JavaScript)/i);
    assert.match(prompt, /edit[^\n]*write[^\n]*file changes[\s\S]*bash[^\n]*(?:build|test|verification)/i);
    assert.match(prompt, /TypeScript[\s\S]*runtime[\s\S]*module[\s\S]*(?:target|lib)[\s\S]*strict/i);
    assert.match(prompt, /repository-supported[\s\S]*(?:TypeScript|language)[\s\S]*(?:features|syntax)/i);
    assert.match(prompt, /red-green-refactor/i);
    assert.match(prompt, /strict[\s\S]*\bany\b[\s\S]*unknown[\s\S]*narrowing[\s\S]*(?:assertions|assertion)/i);
    assert.match(prompt, /discriminated unions[\s\S]*satisfies/i);
    assert.match(prompt, /generic[\s\S]*inference[\s\S]*(?:utility types|conditional types|mapped types)/i);
    assert.match(prompt, /expected failures[\s\S]*(?:Result|discriminated union)[\s\S]*exceptional/i);
    assert.match(prompt, /ESM[\s\S]*CommonJS[\s\S]*(?:Node\.js|browser)/i);
    assert.match(prompt, /AbortSignal[\s\S]*(?:floating|unhandled) (?:promises|rejections)/i);
    assert.match(prompt, /untrusted[\s\S]*(?:validate|validation)[\s\S]*(?:boundary|boundaries)/i);
    assert.match(prompt, /framework[\s\S]*version[\s\S]*repository-supported/i);
    assert.match(prompt, /JavaScript[\s\S]*(?:migration|migrate)[\s\S]*(?:incremental|compatibility)/i);
    assert.match(prompt, /repository conventions and explicit user direction[\s\S]{0,280}(?:constraints|follow)[\s\S]{0,280}correctness[\s\S]{0,180}security[\s\S]{0,180}maintainability/i);
    assert.match(prompt, /conflicts[\s\S]{0,320}(?:explain|document)[\s\S]{0,200}smallest safer alternative/i);
    assert.match(prompt, /Never report success[\s\S]{0,260}(?:type-checking|tests|build)[\s\S]{0,240}(?:fail|blocked)/i);
    assert.match(prompt, /Status[\s\S]*Summary[\s\S]*Files Changed[\s\S]*Verification/i);
    assert.doesNotMatch(prompt, /grimoire\.typescript-coder|CLAUDE\.md|\bSkill\b|WebSearch|WebFetch|context7|TaskCreate|TaskUpdate|TaskList|TaskOutput|TaskStop|Persistent Agent Memory|\bLSP\b/i);
    assert.doesNotMatch(prompt, /TypeScript(?:\s+version)?\s+\d+(?:\.\d+)?/i);
  });

  it("keeps the Rust coder repository-aware, safe, and compiler-driven", () => {
    const builtInDir = resolve(import.meta.dirname, "../agents");
    const member = discoverGuildMembers({ builtInDir }).members.find(({ name }) => name === "rust-coder");

    assert.ok(member);
    assert.deepEqual(member.tools, ["read", "grep", "find", "ls", "edit", "write", "bash"]);
    const prompt = member.systemPrompt;
    assert.match(prompt, /eligibility gate[\s\S]*Rust[\s\S]*(?:\.rs|Cargo\.toml)[\s\S]*refuse/i);
    assert.match(prompt, /refuse[\s\S]{0,300}(?:outside|does not belong to)[\s\S]{0,120}Rust/i);
    assert.match(prompt, /refuse[\s\S]{0,380}repository[\s\S]{0,240}(?:no relevant|does not contain)[\s\S]{0,120}Rust/i);
    assert.match(prompt, /edit[^\n]*write[^\n]*file changes[\s\S]*bash[^\n]*(?:build|test|verification)/i);
    assert.match(prompt, /Cargo\.toml[\s\S]*Cargo\.lock[\s\S]*(?:rust-toolchain|toolchain)[\s\S]*edition[\s\S]*(?:MSRV|minimum supported Rust version)[\s\S]*(?:features|target)/i);
    assert.match(prompt, /repository-supported[\s\S]*(?:Rust|language|standard library)[\s\S]*(?:features|APIs)/i);
    assert.match(prompt, /red-green-refactor/i);
    assert.match(prompt, /ownership[\s\S]*borrowing[\s\S]*lifetimes[\s\S]*(?:clone|\.clone\(\))/i);
    assert.match(prompt, /unsafe[\s\S]{0,320}(?:safety invariant|SAFETY)[\s\S]{0,260}(?:smallest|narrow|minimi)/i);
    assert.match(prompt, /Result[\s\S]*panic![\s\S]*thiserror[\s\S]*anyhow[\s\S]*(?:repository|Cargo\.toml|existing)/i);
    assert.match(prompt, /compiler[\s\S]*full (?:diagnostic|message)[\s\S]*(?:dependency order|root cause)[\s\S]*cargo check/i);
    assert.match(prompt, /clippy[\s\S]*guidance[\s\S]*#\[allow[\s\S]*(?:reason|justif)/i);
    assert.match(prompt, /Send[\s\S]*Sync[\s\S]*(?:async|await)[\s\S]*(?:lock|mutex)/i);
    assert.match(prompt, /FFI[\s\S]*(?:repr\(C\)|ABI)[\s\S]*(?:ownership|lifetime)[\s\S]*(?:panic|unwind)/i);
    assert.match(prompt, /untrusted[\s\S]*(?:validate|validation)[\s\S]*(?:boundary|boundaries)/i);
    assert.match(prompt, /repository conventions and explicit user direction[\s\S]{0,280}(?:constraints|follow)[\s\S]{0,280}correctness[\s\S]{0,180}safety[\s\S]{0,180}maintainability/i);
    assert.match(prompt, /conflicts[\s\S]{0,320}(?:explain|document)[\s\S]{0,200}smallest safer alternative/i);
    assert.match(prompt, /Never report success[\s\S]{0,260}(?:cargo check|tests|build)[\s\S]{0,240}(?:fail|blocked)/i);
    assert.match(prompt, /Status[\s\S]*Summary[\s\S]*Files Changed[\s\S]*Verification/i);
    assert.doesNotMatch(prompt, /grimoire\.rust-coder|CLAUDE\.md|\bSkill\b|WebSearch|WebFetch|context7|TaskCreate|TaskUpdate|TaskList|TaskOutput|TaskStop|Persistent Agent Memory|\bLSP\b/i);
    assert.doesNotMatch(prompt, /Rust(?:\s+version)?\s+\d+(?:\.\d+)?/i);
    assert.doesNotMatch(prompt, /edition\s*=\s*["']?20\d{2}/i);
  });

  it("keeps the Rust architect read-only, repository-aware, and at architecture altitude", () => {
    const builtInDir = resolve(import.meta.dirname, "../agents");
    const member = discoverGuildMembers({ builtInDir }).members.find(({ name }) => name === "rust-architect");

    assert.ok(member);
    assert.deepEqual(member.tools, ["read", "grep", "find", "ls"]);
    const prompt = member.systemPrompt;
    assert.match(prompt, /read-only[\s\S]*Never create, edit, or delete files, run shell commands/i);
    assert.match(prompt, /eligibility gate[\s\S]*Rust[\s\S]*(?:\.rs|Cargo\.toml)[\s\S]*refuse/i);
    assert.match(prompt, /refuse[\s\S]{0,320}(?:outside|does not belong to)[\s\S]{0,140}Rust/i);
    assert.match(prompt, /refuse[\s\S]{0,420}repository[\s\S]{0,280}(?:no relevant|does not contain)[\s\S]{0,140}Rust/i);
    assert.match(prompt, /architecture altitude[\s\S]*contract snippet declares members; it does not implement them/i);
    assert.match(prompt, /Cargo\.toml[\s\S]*Cargo\.lock[\s\S]*(?:rust-toolchain|toolchain)[\s\S]*edition[\s\S]*(?:MSRV|minimum supported Rust version)[\s\S]*(?:features|targets|crate types)/i);
    assert.match(prompt, /module boundaries[\s\S]*dependency direction[\s\S]*public API/i);
    assert.match(prompt, /trait[\s\S]*associated types[\s\S]*generics[\s\S]*trait objects[\s\S]*(?:coherence|object safety)/i);
    assert.match(prompt, /ownership[\s\S]*borrowing[\s\S]*lifetimes[\s\S]*Arc[\s\S]*Rc[\s\S]*interior mutability[\s\S]*(?:Clone|cloning)/i);
    assert.match(prompt, /custom error enums[\s\S]*thiserror[\s\S]*anyhow[\s\S]*(?:library|application)/i);
    assert.match(prompt, /workspace[\s\S]*crate boundaries[\s\S]*feature flags[\s\S]*(?:dependency|compile time)/i);
    assert.match(prompt, /unsafe[\s\S]*(?:safety invariant|SAFETY)[\s\S]*(?:encapsulat|smallest)[\s\S]*FFI/i);
    assert.match(prompt, /refactor[\s\S]*(?:intermediate|sequence)[\s\S]*(?:compile|cargo check)[\s\S]*tests/i);
    assert.match(prompt, /red-green-refactor/i);
    assert.match(prompt, /Project best practice[\s\S]*Local convention[\s\S]*Questionable pattern[\s\S]*Anti-pattern/i);
    assert.match(prompt, /repository conventions and explicit user direction[\s\S]{0,280}(?:constraints|follow)[\s\S]{0,280}correctness[\s\S]{0,180}safety[\s\S]{0,180}maintainability/i);
    assert.match(prompt, /When either conflicts[\s\S]{0,280}explain[\s\S]{0,180}smallest safer alternative/i);
    assert.match(prompt, /Summary[\s\S]*Findings[\s\S]*Recommendations[\s\S]*Trade-offs[\s\S]*Test Plan[\s\S]*Handoff/i);
    assert.match(prompt, /affected paths or areas[\s\S]*implementation order[\s\S]*acceptance criteria[\s\S]*constraints/i);
    assert.match(prompt, /Never[\s\S]{0,120}claim(?:ed)? to have implemented/i);
    assert.doesNotMatch(prompt, /rust-coder/i);
    assert.doesNotMatch(prompt, /grimoire\.rust-architect|CLAUDE\.md|\bBash\b|\bSkill\b|WebSearch|WebFetch|context7|TaskCreate|TaskUpdate|TaskList|TaskOutput|TaskStop|Persistent Agent Memory|\bLSP\b/i);
    assert.doesNotMatch(prompt, /Rust(?:\s+version)?\s+\d+(?:\.\d+)?/i);
    assert.doesNotMatch(prompt, /edition\s*=\s*["']?20\d{2}/i);
  });

  it("keeps the code reviewer read-only, language-aware, and findings-first", () => {
    const builtInDir = resolve(import.meta.dirname, "../agents");
    const member = discoverGuildMembers({ builtInDir }).members.find(({ name }) => name === "code-reviewer");

    assert.ok(member);
    assert.deepEqual(member.tools, ["read", "grep", "find", "ls", "bash"]);
    const prompt = member.systemPrompt;
    assert.match(prompt, /eligibility gate[\s\S]*code review[\s\S]*repository[\s\S]*refuse/i);
    assert.match(prompt, /read-only[\s\S]{0,260}Never create, edit, or delete files/i);
    assert.match(prompt, /bash[\s\S]{0,260}(?:read-only|non-mutating)[\s\S]{0,260}(?:git status|git diff)/i);
    assert.match(prompt, /review scope[\s\S]*(?:git status|working tree)[\s\S]*git diff[\s\S]*(?:staged|cached|base)/i);
    assert.match(prompt, /language[\s\S]*(?:file extensions|extensions)[\s\S]*(?:manifest|configuration)[\s\S]*framework[\s\S]*runtime[\s\S]*version/i);
    assert.match(prompt, /Critical[\s\S]*High[\s\S]*Medium[\s\S]*Low/i);
    assert.match(prompt, /findings-first[\s\S]*(?:severity|highest)[\s\S]*(?:path|file)[\s\S]*line[\s\S]*evidence[\s\S]*impact[\s\S]*(?:remediation|fix)/i);
    assert.match(prompt, /correctness[\s\S]*security[\s\S]*(?:data loss|data integrity)[\s\S]*compatibility[\s\S]*(?:maintainability|performance|tests|style)/i);
    assert.match(prompt, /high-confidence[\s\S]*(?:hypothetical|speculative|uncertain)/i);
    assert.match(prompt, /changed code[\s\S]*affected context[\s\S]*(?:pre-existing|unrelated)/i);
    assert.match(prompt, /untrusted[\s\S]*(?:authorization|authentication)[\s\S]*injection[\s\S]*secrets/i);
    assert.match(prompt, /concurrency[\s\S]*async[\s\S]*(?:resource|cleanup)/i);
    assert.match(prompt, /API[\s\S]*(?:schema|migration)[\s\S]*compatibility/i);
    assert.match(prompt, /tests[\s\S]*(?:observable behavior|regression)[\s\S]*(?:missing|gap)/i);
    assert.match(prompt, /performance[\s\S]*(?:evidence|measure)[\s\S]*(?:speculative|micro-optimization)/i);
    assert.match(prompt, /Language\(s\)[\s\S]*Review Scope[\s\S]*Findings[\s\S]*Decision/i);
    assert.match(prompt, /Request changes[\s\S]*Comment[\s\S]*Approve/i);
    assert.match(prompt, /no findings[\s\S]*(?:residual|verification|limitations)/i);
    assert.doesNotMatch(prompt, /grimoire\.code-reviewer|CLAUDE\.md|\bSkill\b|WebSearch|WebFetch|context7|TaskCreate|TaskUpdate|TaskList|TaskOutput|TaskStop|Persistent Agent Memory|\bLSP\b/i);
  });
});

describe("agent discovery", () => {
  it("selects a user definition over the built-in when no project definition is present", () => {
    const root = temporaryDirectory();
    const builtInDir = join(root, "builtin");
    const userDir = join(root, "user");
    writeAgent(builtInDir, "csharp-coder", "Built-in C# coder", undefined, "Built-in prompt");
    writeAgent(userDir, "csharp-coder", "User C# coder", undefined, "User prompt");

    const result = discoverGuildMembers({ builtInDir, userDir });

    assert.equal(result.members[0]?.source, "user");
    assert.equal(result.members[0]?.description, "User C# coder");
    assert.equal(result.members[0]?.systemPrompt, "User prompt");
    assert.deepEqual(result.warnings, []);
  });

  it("applies project then user then built-in precedence", () => {
    const root = temporaryDirectory();
    const builtInDir = join(root, "builtin");
    const userDir = join(root, "user");
    const projectDir = join(root, "project");

    for (const name of GUILD_MEMBER_NAMES) writeAgent(builtInDir, name, undefined, undefined, `Built-in ${name}`);
    writeAgent(userDir, "csharp-coder", "User C# coder", undefined, "User prompt");
    writeAgent(projectDir, "csharp-coder", "Project C# coder", undefined, "Project prompt");

    const result = discoverGuildMembers({ builtInDir, userDir, projectDir, includeProject: true });
    const selected = result.members.find((agent) => agent.name === "csharp-coder");

    assert.equal(selected?.source, "project");
    assert.equal(selected?.description, "Project C# coder");
    assert.equal(selected?.systemPrompt, "Project prompt");
  });

  it("does not let an untrusted project displace a user definition", () => {
    const root = temporaryDirectory();
    const builtInDir = join(root, "builtin");
    const userDir = join(root, "user");
    const projectDir = join(root, "project");
    writeAgent(builtInDir, "dotnet-architect", "Built in");
    writeAgent(userDir, "dotnet-architect", "User override");
    writeAgent(projectDir, "dotnet-architect", "Project override");

    const result = discoverGuildMembers({ builtInDir, userDir, projectDir, includeProject: false });

    assert.equal(result.members[0]?.source, "user");
    assert.equal(result.members[0]?.description, "User override");
    assert.deepEqual(result.warnings, []);
  });

  it("falls back from malformed, empty, and tool-changing user definitions with deterministic warnings", () => {
    const root = temporaryDirectory();
    const builtInDir = join(root, "builtin");
    const userDir = join(root, "user");
    writeAgent(builtInDir, "dotnet-architect", "Built-in .NET architect");
    writeAgent(builtInDir, "frontend-architect", "Built-in front-end architect");
    writeAgent(builtInDir, "typescript-architect", "Built-in TypeScript architect");
    writeRawAgent(
      userDir,
      "00-malformed.md",
      "---\nname: typescript-architect\ndescription: [\ntools: read, grep, find, ls\n---\nMalformed prompt\n",
    );
    writeAgent(userDir, "dotnet-architect", "", undefined, "User prompt");
    writeAgent(userDir, "frontend-architect", "Unsafe override", ["read", "bash"]);

    const result = discoverGuildMembers({ builtInDir, userDir });

    assert.deepEqual(
      result.members.map(({ name, source }) => [name, source]),
      [
        ["dotnet-architect", "builtin"],
        ["frontend-architect", "builtin"],
        ["typescript-architect", "builtin"],
      ],
    );
    assert.equal(result.warnings.length, 3);
    assert.match(result.warnings[0] ?? "", /Could not parse user Guild member .*00-malformed\.md/i);
    assert.match(result.warnings[1] ?? "", /dotnet-architect.*description and prompt body are required/i);
    assert.match(result.warnings[2] ?? "", /frontend-architect.*tool boundary/i);
  });

  it("accepts the alphabetically first duplicate definition and warns about the rest", () => {
    const root = temporaryDirectory();
    const builtInDir = join(root, "builtin");
    const userDir = join(root, "user");
    writeAgent(builtInDir, "code-reviewer", "Built-in reviewer");
    writeRawAgent(
      userDir,
      "00-reviewer.md",
      "---\nname: code-reviewer\ndescription: First reviewer\ntools: read, grep, find, ls, bash\n---\n\nFirst prompt\n",
    );
    writeRawAgent(
      userDir,
      "01-reviewer.md",
      "---\nname: code-reviewer\ndescription: Second reviewer\ntools: read, grep, find, ls, bash\n---\n\nSecond prompt\n",
    );

    const result = discoverGuildMembers({ builtInDir, userDir });

    assert.equal(result.members[0]?.source, "user");
    assert.equal(result.members[0]?.description, "First reviewer");
    assert.equal(result.members[0]?.systemPrompt, "First prompt");
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0] ?? "", /duplicate user definition for code-reviewer.*01-reviewer\.md/i);
  });

  it("accepts reordered exact tools and restores their canonical order", () => {
    const root = temporaryDirectory();
    const builtInDir = join(root, "builtin");
    const userDir = join(root, "user");
    writeAgent(builtInDir, "csharp-coder", "Built-in coder");
    writeAgent(
      userDir,
      "csharp-coder",
      "User coder",
      [...GUILD_MEMBER_POLICIES["csharp-coder"].tools].reverse(),
      "User prompt",
    );

    const result = discoverGuildMembers({ builtInDir, userDir });

    assert.equal(result.members[0]?.source, "user");
    assert.deepEqual(result.members[0]?.tools, GUILD_MEMBER_POLICIES["csharp-coder"].tools);
    assert.deepEqual(result.warnings, []);
  });

  it("silently ignores unknown definitions without changing the approved roster (legacy behavior)", () => {
    const root = temporaryDirectory();
    const builtInDir = join(root, "builtin");
    writeAgent(builtInDir, "csharp-coder");
    writeAgent(builtInDir, "unapproved-agent", "Not part of this package", ["read"]);

    const result = discoverGuildMembers({ builtInDir });

    assert.deepEqual(result.members.map((agent) => agent.name), ["csharp-coder"]);
    assert.deepEqual(result.warnings, []);
  });

  it("finds the nearest project agent directory while walking ancestors", () => {
    const root = temporaryDirectory();
    const projectAgents = join(root, ".pi", "agents");
    const nested = join(root, "src", "features", "orders");
    mkdirSync(projectAgents, { recursive: true });
    mkdirSync(nested, { recursive: true });

    assert.equal(findNearestProjectAgentsDir(nested), projectAgents);
  });
});
