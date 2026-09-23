import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import {
  GUILD_MEMBER_ALIASES,
  GUILD_PROFILE_DEFINITIONS,
  GUILD_PROFILES,
  GUILD_ROLE_DEFINITIONS,
  GUILD_ROLES,
  createGuildTarget,
  isGuildMemberAlias,
  isGuildProfile,
  isGuildRole,
  isGuildTarget,
  resolveGuildTarget,
} from "../src/agents";

describe("canonical Guild role/profile registry", () => {
  it("defines the canonical four roles, six profiles, and all 24 pairs", () => {
    assert.deepEqual(GUILD_ROLES, ["explorer", "architect", "coder", "reviewer"]);
    assert.deepEqual(GUILD_PROFILES, ["general", "frontend", "angular", "typescript", "dotnet", "rust"]);

    for (const role of GUILD_ROLES) assert.equal(isGuildRole(role), true);
    for (const profile of GUILD_PROFILES) assert.equal(isGuildProfile(profile), true);
    assert.equal(isGuildRole("researcher"), false);
    assert.equal(isGuildProfile("researcher"), false);

    const targets = GUILD_ROLES.flatMap((role) =>
      GUILD_PROFILES.map((profile) => createGuildTarget(role, profile)),
    );
    assert.equal(new Set(targets).size, 24);
    assert.ok(targets.every((target) => isGuildTarget(target)));
    assert.equal(isGuildTarget("researcher/general"), false);
    assert.equal(isGuildTarget("architect/researcher"), false);
    assert.equal(isGuildTarget("architect/typescript/extra"), false);
  });

  it("keeps immutable tool ownership on roles and no tools on profiles", () => {
    assert.deepEqual(Object.keys(GUILD_ROLE_DEFINITIONS), GUILD_ROLES);
    assert.deepEqual(Object.keys(GUILD_PROFILE_DEFINITIONS), GUILD_PROFILES);

    for (const role of GUILD_ROLES) {
      const definition = GUILD_ROLE_DEFINITIONS[role];
      const expectedTools = role === "coder"
        ? ["read", "grep", "find", "ls", "edit", "write", "bash"]
        : ["read", "grep", "find", "ls"];

      assert.deepEqual(Object.keys(definition).sort(), ["description", "tools"]);
      assert.ok(definition.description.length > 0);
      assert.deepEqual(definition.tools, expectedTools);
      assert.equal(Object.isFrozen(definition), true);
      assert.equal(Object.isFrozen(definition.tools), true);
    }

    for (const profile of GUILD_PROFILES) {
      const definition = GUILD_PROFILE_DEFINITIONS[profile];
      assert.deepEqual(Object.keys(definition).sort(), ["description", "expertise"]);
      assert.ok(definition.description.length > 0);
      assert.ok(definition.expertise.length > 0);
      assert.equal("tools" in definition, false);
      assert.equal(Object.isFrozen(definition), true);
    }

    assert.equal(Object.isFrozen(GUILD_ROLE_DEFINITIONS), true);
    assert.equal(Object.isFrozen(GUILD_PROFILE_DEFINITIONS), true);
  });

  it("ships aliases as code-only names with exactly the fixed nested prompt resources", () => {
    const agentsDirectory = resolve(import.meta.dirname, "../agents");
    const topLevelEntries = readdirSync(agentsDirectory, { withFileTypes: true });

    assert.deepEqual(
      topLevelEntries.map(({ name }) => name).sort(),
      ["profiles", "roles"],
    );
    assert.deepEqual(
      topLevelEntries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map(({ name }) => name),
      [],
    );
    assert.deepEqual(
      [
        ...readdirSync(join(agentsDirectory, "roles")).map((name) => `roles/${name}`),
        ...readdirSync(join(agentsDirectory, "profiles")).map((name) => `profiles/${name}`),
      ].sort(),
      [
        ...GUILD_ROLES.map((role) => `roles/${role}.md`),
        ...GUILD_PROFILES.map((profile) => `profiles/${profile}.md`),
      ].sort(),
    );
    for (const alias of Object.keys(GUILD_MEMBER_ALIASES)) {
      assert.equal(topLevelEntries.some(({ name }) => name === `${alias}.md`), false, alias);
    }
  });

  it("ships plain role contracts with the required role-owned behavior", () => {
    const rolesDirectory = resolve(import.meta.dirname, "../agents/roles");
    const prompts = Object.fromEntries(
      GUILD_ROLES.map((role) => [role, readFileSync(join(rolesDirectory, `${role}.md`), "utf8")]),
    ) as Record<(typeof GUILD_ROLES)[number], string>;

    for (const prompt of Object.values(prompts)) {
      assert.match(prompt, /^# /);
      assert.doesNotMatch(prompt, /^---/);
      assert.match(prompt, /repository evidence/i);
      assert.match(prompt, /package resource is guidance[\s\S]*role owns (?:its )?capability/i);
      assert.doesNotMatch(prompt, /\b(?:skills?|practices?|protocols?|routing)\b/i);
    }

    for (const role of ["explorer", "architect", "reviewer"] as const) {
      assert.match(prompts[role], /strictly read-only/i);
      assert.match(prompts[role], /do not create, edit, or delete files/i);
      assert.match(prompts[role], /cannot run shell commands/i);
    }

    assert.match(prompts.explorer, /facts[\s\S]*assumptions[\s\S]*(?:paths|files)[\s\S]*lines/i);
    assert.match(prompts.architect, /contracts[\s\S]*invariants[\s\S]*test plan[\s\S]*handoff/i);
    assert.match(prompts.coder, /smallest approved change[\s\S]*tests[\s\S]*verification[\s\S]*preserve unrelated changes/i);
    assert.match(prompts.reviewer, /findings-first[\s\S]*severity[\s\S]*evidence[\s\S]*verdict/i);
    assert.match(prompts.reviewer, /Critical[\s\S]*High[\s\S]*Medium[\s\S]*Low/i);
    assert.match(prompts.reviewer, /Request changes[\s\S]*(?:Critical|High|Medium)[\s\S]*Comment[\s\S]*Low[\s\S]*Approve[\s\S]*no actionable findings/i);
    assert.match(prompts.reviewer, /cannot run shell commands[\s\S]*do not claim/i);
  });

  it("ships plain profiles with conditional, version-evidenced expertise only", () => {
    const profilesDirectory = resolve(import.meta.dirname, "../agents/profiles");
    const prompts = Object.fromEntries(
      GUILD_PROFILES.map((profile) => [profile, readFileSync(join(profilesDirectory, `${profile}.md`), "utf8")]),
    ) as Record<(typeof GUILD_PROFILES)[number], string>;

    for (const prompt of Object.values(prompts)) {
      assert.match(prompt, /^# /);
      assert.doesNotMatch(prompt, /^---/);
      assert.match(prompt, /package resource is guidance[\s\S]*role owns capability/i);
      assert.match(prompt, /repository evidence[\s\S]*(?:supported|actual)[\s\S]*versions?/i);
      assert.match(prompt, /only when[\s\S]*relevant/i);
      assert.doesNotMatch(prompt, /\b(?:skills?|practices?|protocols?|routing)\b/i);
      assert.doesNotMatch(prompt, /(?:Angular|TypeScript|Node(?:\.js)?|\.NET|C#|Rust)\s+v?\d/i);
    }

    assert.match(prompts.general, /cross-cutting[\s\S]*boundaries[\s\S]*failure[\s\S]*testing/i);
    assert.match(prompts.frontend, /components[\s\S]*state[\s\S]*rendering[\s\S]*accessibility[\s\S]*performance/i);
    assert.match(prompts.angular, /components[\s\S]*templates[\s\S]*dependency injection[\s\S]*reactivity[\s\S]*forms[\s\S]*testing/i);
    assert.match(prompts.typescript, /type modeling[\s\S]*runtime[\s\S]*modules[\s\S]*asynchronous/i);
    assert.match(prompts.dotnet, /project boundaries[\s\S]*runtime[\s\S]*dependency injection[\s\S]*persistence[\s\S]*asynchronous[\s\S]*testing/i);
    assert.match(prompts.rust, /ownership[\s\S]*errors[\s\S]*concurrency[\s\S]*Cargo[\s\S]*unsafe[\s\S]*testing/i);
  });

  it("resolves only the exact package-owned aliases and canonical targets", () => {
    const expectedAliases = {
      "dotnet-architect": "architect/dotnet",
      "frontend-architect": "architect/frontend",
      "typescript-architect": "architect/typescript",
      "rust-architect": "architect/rust",
      "csharp-coder": "coder/dotnet",
      "angular-coder": "coder/angular",
      "typescript-coder": "coder/typescript",
      "rust-coder": "coder/rust",
      "code-reviewer": "reviewer/general",
    } as const;

    assert.deepEqual(GUILD_MEMBER_ALIASES, expectedAliases);
    assert.equal(Object.isFrozen(GUILD_MEMBER_ALIASES), true);
    for (const [alias, target] of Object.entries(expectedAliases)) {
      assert.equal(isGuildMemberAlias(alias), true);
      assert.equal(resolveGuildTarget(alias), target);

      const role = target.slice(0, target.indexOf("/"));
      assert.ok(isGuildRole(role));
      const expectedTools = role === "coder"
        ? ["read", "grep", "find", "ls", "edit", "write", "bash"]
        : ["read", "grep", "find", "ls"];
      assert.deepEqual(GUILD_ROLE_DEFINITIONS[role].tools, expectedTools);
    }

    for (const role of GUILD_ROLES) {
      for (const profile of GUILD_PROFILES) {
        const target = createGuildTarget(role, profile);
        assert.equal(resolveGuildTarget(target), target);
      }
    }

    assert.equal(isGuildMemberAlias("researcher"), false);
    assert.equal(resolveGuildTarget("researcher/general"), undefined);
    assert.equal(resolveGuildTarget("architect/unknown"), undefined);
    assert.equal(resolveGuildTarget("dotnet-architect/extra"), undefined);
  });
});
