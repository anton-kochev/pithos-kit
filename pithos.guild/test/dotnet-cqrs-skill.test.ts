import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const guildRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(guildRoot, "..");
const skillRoot = resolve(guildRoot, "skills/dotnet-cqrs");
const skillPath = resolve(skillRoot, "SKILL.md");

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function section(markdown: string, heading: string): string {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = `${markdown}\n## `.match(new RegExp(`^## ${escapedHeading}\\n([\\s\\S]*?)(?=^## )`, "mu"));
  assert.ok(match, `Expected section: ${heading}`);
  return match[1];
}

type Capability = { name: string };
type CapabilityMetadata = { commands: Capability[]; skills: Capability[] };
type GuildManifest = {
  files: string[];
  pi: { skills: string[] };
  pithosKit: CapabilityMetadata;
};
type Catalog = { packages: Array<{ name: string; pithosKit: CapabilityMetadata }> };

const referenceFiles = [
  "reference/maturity-and-decision.md",
  "reference/dispatch-and-vertical-slices.md",
  "reference/read-models-and-projections.md",
  "reference/consistency-and-reliability.md",
  "reference/event-sourcing-marten.md",
];

describe("Guild dotnet-cqrs skill", () => {
  it("is a Pi-native Guild skill with complete discovery metadata and references", () => {
    const skill = readFileSync(skillPath, "utf8");
    const guild = readJson<GuildManifest>(resolve(guildRoot, "package.json"));
    const catalog = readJson<Catalog>(resolve(repositoryRoot, "pithos.atlas/src/generated/catalog.json"));
    const catalogGuild = catalog.packages.find(({ name }) => name === "@pithos-kit/guild");
    const readme = readFileSync(resolve(guildRoot, "README.md"), "utf8");

    assert.match(skill, /^---\nname: dotnet-cqrs\ndescription: [\s\S]+?\n---\n/u);
    assert.ok(guild.pi.skills.includes("./skills"));
    assert.ok(guild.files.includes("skills"));
    assert.ok(guild.pithosKit.commands.some(({ name }) => name === "skill:dotnet-cqrs"));
    assert.ok(guild.pithosKit.skills.some(({ name }) => name === "dotnet-cqrs"));
    assert.ok(catalogGuild?.pithosKit.commands.some(({ name }) => name === "skill:dotnet-cqrs"));
    assert.ok(catalogGuild?.pithosKit.skills.some(({ name }) => name === "dotnet-cqrs"));
    assert.match(readme, /dotnet-cqrs[\s\S]*\/skill:dotnet-cqrs/iu);

    const links = [...skill.matchAll(/\]\((reference\/[^)]+\.md)\)/gu)].map((match) => match[1]);
    assert.deepEqual([...new Set(links)].sort(), [...referenceFiles].sort());
    for (const link of links) assert.equal(existsSync(resolve(skillRoot, link)), true, `Missing reference: ${link}`);
  });

  it("requires connected .NET relevance and discovers the actual CQRS capabilities", () => {
    const skill = readFileSync(skillPath, "utf8");
    const eligibility = section(skill, "Eligibility and repository discovery");

    assert.match(eligibility, /substantive[\s\S]*(?:\.NET|C#)[\s\S]*(?:connected|relevant)[\s\S]*(?:stop|refuse)/iu);
    for (const evidence of [".sln", ".slnx", ".csproj", "Directory.Build", "Directory.Packages", "global.json"]) {
      assert.match(eligibility, new RegExp(evidence.replaceAll(".", "\\."), "iu"));
    }
    assert.match(eligibility, /TargetFramework[\s\S]*LangVersion[\s\S]*Nullable/iu);
    assert.match(eligibility, /package[\s\S]*(?:persistence|database)[\s\S]*(?:messag|broker)[\s\S]*(?:deploy|host)[\s\S]*(?:test|CI)/iu);
    assert.match(eligibility, /trace[\s\S]*(?:command|query)[\s\S]*(?:handler|endpoint)[\s\S]*(?:transaction|store)/iu);
    assert.match(eligibility, /preserve[\s\S]*(?:healthy|working|sound)[\s\S]*(?:unless|without)[\s\S]*(?:asks?|authorized)/iu);
  });

  it("selects CQRS proportionally per bounded context instead of treating levels as maturity", () => {
    const skill = readFileSync(skillPath, "utf8");
    const decision = section(skill, "Choose the smallest CQRS shape that earns its cost");

    assert.match(decision, /bounded context/iu);
    assert.match(decision, /CRUD[\s\S]*(?:direct|simple|skip|without CQRS)/iu);
    assert.match(decision, /(?:command|query)[\s-]*split[\s\S]*(?:same|one)[\s\S]*(?:process|database)/iu);
    assert.match(decision, /separate read (?:model|shape)[\s\S]*(?:same|one)[\s\S]*(?:transaction|database)/iu);
    assert.match(decision, /separate (?:read )?store[\s\S]*(?:async|eventual)[\s\S]*(?:outbox|change feed|delivery|durable change)/iu);
    assert.match(decision, /event sourcing[\s\S]*(?:separate|orthogonal|not)[\s\S]*(?:decision|level|require)/iu);
    assert.match(decision, /(?:measured|demonstrated|evidence)[\s\S]*(?:pain|need|requirement)/iu);
    assert.match(decision, /not[\s\S]*(?:maturity|better|goal)|(?:maturity|better)[\s\S]*not/iu);
  });

  it("defines secure command, query, projection, and async consistency contracts", () => {
    const skill = readFileSync(skillPath, "utf8");
    const commands = section(skill, "Commands and queries");
    const reads = section(skill, "Read models and projections");
    const reliability = section(skill, "Consistency and reliable delivery");

    assert.match(commands, /command[\s\S]*(?:intent|state)[\s\S]*(?:invariant|authorization)[\s\S]*(?:transaction|concurrency)/iu);
    assert.match(commands, /quer(?:y|ies)[\s\S]*(?:read-only|project)[\s\S]*(?:tenant|ownership|authorization)[\s\S]*(?:page|bound)/iu);
    assert.match(commands, /return[\s\S]*(?:identifier|ID|result|version)[\s\S]*(?:display|query payload|DTO)/iu);

    assert.match(reads, /consumer[\s\S]*(?:contract|question|need)[\s\S]*(?:write model|aggregate)/iu);
    assert.match(reads, /rebuild[\s\S]*(?:source of truth|write side|event)/iu);
    assert.match(reads, /(?:must-be-current|current)[\s\S]*(?:may-be-stale|stale)[\s\S]*(?:read-your-own-writes|lag)/iu);
    assert.match(reads, /migration[\s\S]*(?:backfill|rebuild|rollout)/iu);

    assert.match(reliability, /outbox[\s\S]*(?:local|same)[\s\S]*transaction[\s\S]*(?:at-least-once|duplicate)/iu);
    assert.match(reliability, /inbox[\s\S]*idempoten/iu);
    assert.match(reliability, /external effect[\s\S]*(?:downstream idempoten|reconcil)/iu);
    assert.match(reliability, /order[\s\S]*(?:partition|stream|aggregate)[\s\S]*(?:retry|poison|dead-letter)/iu);
    assert.match(reliability, /version[\s\S]*(?:message|event|contract)[\s\S]*(?:mixed-version|rollout|compatib)/iu);
    assert.match(reliability, /correlation[\s\S]*(?:lag|depth|age)[\s\S]*(?:alert|owner|runbook|recovery)/iu);
    assert.match(reliability, /(?:secret|sensitive|personal)[\s\S]*(?:log|message|event|telemetry)/iu);
  });

  it("keeps event sourcing and package choices conditional on repository evidence", () => {
    const skill = readFileSync(skillPath, "utf8");
    const eventSourcing = section(skill, "Event sourcing is a separate decision");
    const packages = section(skill, "Package and dispatch choices");

    assert.match(eventSourcing, /event histor[\s\S]*(?:business|product|regulatory)[\s\S]*(?:audit log|temporal table|state-stored)/iu);
    assert.match(eventSourcing, /Marten[\s\S]*(?:detected|present|selected)[\s\S]*(?:version|provider|PostgreSQL)/iu);
    assert.match(eventSourcing, /optimistic[- ]concurrenc[\s\S]*(?:projection|rebuild)[\s\S]*(?:historical|version)/iu);

    assert.match(packages, /direct (?:injection|call)|plain handler/iu);
    assert.match(packages, /mediator[\s\S]*(?:message bus|broker)[\s\S]*(?:different|durab|semantics)/iu);
    assert.match(packages, /existing[\s\S]*(?:package|dependency)[\s\S]*version[\s\S]*(?:license|support)[\s\S]*(?:authoritative|current)/iu);
    assert.match(packages, /(?:approval|authorization)[\s\S]*(?:add|replace|upgrade|pin)/iu);
  });

  it("preserves role boundaries, test-first verification, and time-neutral examples", () => {
    const files = [skillPath, ...referenceFiles.map((path) => resolve(skillRoot, path))];
    const combined = files.map((path) => readFileSync(path, "utf8")).join("\n");
    const skill = readFileSync(skillPath, "utf8");
    const reads = readFileSync(resolve(skillRoot, "reference/read-models-and-projections.md"), "utf8");
    const testing = section(skill, "Test-first implementation and verification");

    assert.match(skill, /architect[\s\S]*read-only[\s\S]*(?:contracts|handoff)[\s\S]*coder[\s\S]*(?:implement|edit)[\s\S]*(?:test|verify)/iu);
    assert.match(testing, /repository[\s\S]*(?:test framework|test runner|test command)/iu);
    assert.match(testing, /red[\s-]*green[\s-]*refactor/iu);
    assert.match(testing, /domain[\s\S]*(?:handler|application)[\s\S]*(?:provider|persistence)[\s\S]*(?:contract|message)[\s\S]*(?:projection|rebuild)/iu);
    assert.match(testing, /never\s+claim[\s\S]*(?:test|build|verification)[\s\S]*(?:pass|success)[\s\S]*(?:unless|without)[\s\S]*(?:run|execut)/iu);

    assert.doesNotMatch(combined, /Grimoire|Claude|CLAUDE\.md|WebSearch|WebFetch|TaskCreate|TaskUpdate|context7/u);
    assert.doesNotMatch(combined, /(?:\.NET|C#)\s+\d+(?:\.\d+)?/u);
    assert.doesNotMatch(combined, /\b(?:Marten|Wolverine|MediatR|EF Core|Dapper|Cortex\.Mediator|Brighter|FastEndpoints)\s+v?\d+(?:\.\d+)*/u);
    assert.doesNotMatch(combined, /\b(?:latest|current)\s+(?:Marten|Wolverine|MediatR|EF Core|Dapper|Cortex\.Mediator|Brighter|FastEndpoints)\b/iu);
    assert.doesNotMatch(combined, /current\s*:\s*\.NET|current \(20\d{2}\)|\bas of\s+20\d{2}\b|commercial since|unmaintained since/iu);
    assert.doesNotMatch(combined, /(?:Marten|Wolverine|MediatR|Cortex\.Mediator|Brighter|FastEndpoints)[^\n]{0,80}\b(?:commercial|unmaintained|abandoned|unsupported)\b/iu);
    assert.match(reads, /authoritative state[\s\S]{0,120}\bor\b[\s\S]{0,120}(?:event|change log)/iu);
    assert.match(combined, /examples?[\s\S]*(?:adapt|illustrative|supported|detected)[\s\S]*(?:language|framework|package|repository)/iu);
  });
});
