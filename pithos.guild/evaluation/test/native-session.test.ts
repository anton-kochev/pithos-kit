import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { inspectNativeSession } from "../src/native-session.ts";

const tools = ["read", "write", "edit", "bash", "grep", "find", "ls"];
const pricing = { version: 1 as const, model: "openai-codex/gpt-6-astra", api: "openai-codex-responses", serviceTier: "base" as const, cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 } };
function session() {
  const prompt = { customPrompt: undefined as string | undefined, appendSystemPrompt: undefined, contextFiles: [], skills: [] };
  return { prompt, model: { provider: "openai-codex", id: "gpt-6-astra", api: pricing.api, cost: pricing.cost, baseUrl: "https://chatgpt.com/backend-api" }, thinkingLevel: "high", systemPrompt: "native prompt",
    getActiveToolNames: () => tools.slice(), getAllTools: () => tools.map(name => ({ name })),
    sessionManager: { getSessionFile: () => undefined }, settingsManager: { getCompactionEnabled: () => false, getRetrySettings: () => ({ enabled: false, maxRetries: 3 }), getProviderRetrySettings: () => ({ maxRetries: 0 }) },
    resourceLoader: { getExtensions: () => ({ extensions: [{ resolvedPath: "<inline:llama.cpp>" }], errors: [] }), getSkills: () => ({ skills: [] }), getPrompts: () => ({ prompts: [] }) },
    extensionRunner: { createCommandContext: () => ({ cwd: "/fixture", isProjectTrusted: () => true, getSystemPromptOptions: () => prompt }) },
  };
}

test("rejects session model, tools, resources, trust, settings and actual prompt drift", () => {
  for (const change of [
    (s: any) => s.model.id = "other", (s: any) => s.model.cost = { ...pricing.cost, input: 0 },
    (s: any) => s.model.baseUrl = "https://example.com", (s: any) => s.thinkingLevel = "low",
    (s: any) => s.getActiveToolNames = () => [], (s: any) => s.getAllTools = () => [],
    (s: any) => s.prompt.contextFiles.push({ path: "AGENTS.md" }), (s: any) => s.prompt.skills.push({ name: "ambient" }),
    (s: any) => s.resourceLoader.getExtensions = () => ({ extensions: [], errors: [] }),
    (s: any) => s.resourceLoader.getPrompts = () => ({ prompts: ["ambient"] }),
    (s: any) => s.settingsManager.getCompactionEnabled = () => true,
    (s: any) => s.settingsManager.getProviderRetrySettings = () => ({ maxRetries: 1 }),
    (s: any) => s.sessionManager.getSessionFile = () => "saved.jsonl", (s: any) => s.systemPrompt = "injected prompt",
    (s: any) => s.extensionRunner.createCommandContext = () => ({ cwd: "/other", isProjectTrusted: () => false, getSystemPromptOptions: () => s.prompt }),
  ]) {
    const input = session(); change(input);
    assert.throws(() => inspectNativeSession(input, { cwd: "/fixture", arm: "main-only", guildRoot: "/guild", pricing, actor: "parent" }, () => "native prompt"), /Native session policy mismatch/);
  }
});

test("verifies package-owned child prompts and role ceilings for every canonical target", () => {
  const guildRoot = resolve(".");
  for (const role of ["explorer", "architect", "coder", "reviewer"]) for (const profile of ["general", "frontend", "angular", "typescript", "dotnet", "rust"]) {
    const input: any = session();
    const selected = ["read", "grep", "find", "ls", ...(role === "coder" ? ["edit", "write", "bash"] : [])];
    input.getActiveToolNames = () => selected.slice(); input.getAllTools = () => selected.map(name => ({ name }));
    input.prompt.customPrompt = `# Standalone Guild member: ${role}/${profile}\n\nWork only on the delegated task. You have an isolated context and cannot ask another member to finish your role.\nTreat the tool allowlist as a hard capability boundary.`;
    input.prompt.appendSystemPrompt = readFileSync(`${guildRoot}/agents/roles/${role}.md`, "utf8").trimEnd() + '\n\n' + readFileSync(`${guildRoot}/agents/profiles/${profile}.md`, "utf8").trimEnd();
    const policy = { cwd: "/fixture", arm: "guild-available" as const, guildRoot, pricing, actor: "child" as const };
    assert.equal(inspectNativeSession(input, policy, () => "native prompt").target, `${role}/${profile}`);
    selected.push("guild_handover");
    assert.throws(() => inspectNativeSession(input, policy, () => "native prompt"), /Native session policy mismatch/);
  }
});

test("inspects actual session getters and rejects ambient prompt/context drift", () => {
  const input = session();
  const expected = { cwd: "/fixture", arm: "main-only" as const, guildRoot: "/guild", pricing, actor: "parent" as const };
  const result = inspectNativeSession(input, expected, () => "native prompt");
  assert.equal(result.model, pricing.model); assert.deepEqual(result.tools, tools.slice().sort());
  input.prompt.customPrompt = "unexpected SYSTEM.md";
  assert.throws(() => inspectNativeSession(input, expected, () => "native prompt"), /Native session policy mismatch/);
});
