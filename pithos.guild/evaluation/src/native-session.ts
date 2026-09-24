import { readFileSync } from "node:fs";
import { join } from "node:path";
import { digest } from "./manifest.ts";
import type { BasePricing } from "./pricing.ts";
import type { Arm } from "./runner.ts";

export interface SessionPolicy { cwd: string; arm: Arm; guildRoot: string; pricing: BasePricing; actor: "parent" | "child" }
export function inspectNativeSession(session: any, policy: SessionPolicy, buildSystemPrompt: (options: any) => string) {
  try {
    const ctx = session.extensionRunner.createCommandContext(), prompt = ctx.getSystemPromptOptions();
    const tools = session.getActiveToolNames().slice().sort();
    const same = (a: unknown, b: unknown) => { if (digest(a) !== digest(b)) throw Error(); };
    let target: string | null = null;
    let expectedTools = ["read", "write", "edit", "bash", "grep", "find", "ls", ...(policy.arm === "guild-available" ? ["guild_handover"] : [])].sort();
    if (policy.actor === "parent") {
      if (prompt.customPrompt !== undefined || prompt.appendSystemPrompt !== undefined) throw Error();
    } else {
      if (policy.arm !== "guild-available") throw Error();
      const match = /^# Standalone Guild member: (explorer|architect|coder|reviewer)\/(general|frontend|angular|typescript|dotnet|rust)\n/.exec(prompt.customPrompt ?? "");
      if (!match) throw Error();
      const [, role, profile] = match; target = `${role}/${profile}`;
      same(prompt.customPrompt, `# Standalone Guild member: ${target}\n\nWork only on the delegated task. You have an isolated context and cannot ask another member to finish your role.\nTreat the tool allowlist as a hard capability boundary.`);
      same(prompt.appendSystemPrompt, readFileSync(join(policy.guildRoot, `agents/roles/${role}.md`), "utf8").trimEnd() + "\n\n" + readFileSync(join(policy.guildRoot, `agents/profiles/${profile}.md`), "utf8").trimEnd());
      expectedTools = ["read", "grep", "find", "ls", ...(role === "coder" ? ["edit", "write", "bash"] : [])].sort();
    }
    same(tools, expectedTools); same(session.getAllTools().map((t: any) => t.name).sort(), expectedTools);
    same(prompt.contextFiles, []); same(prompt.skills, []);
    same(session.resourceLoader.getSkills().skills, []); same(session.resourceLoader.getPrompts().prompts, []);
    const extensions = session.resourceLoader.getExtensions();
    same(extensions.errors, []);
    same(extensions.extensions.map((e: any) => e.resolvedPath).sort(), ["<inline:llama.cpp>", ...(policy.actor === "parent" && policy.arm === "guild-available" ? [join(policy.guildRoot, "extensions/index.ts")] : [])].sort());
    if (ctx.cwd !== policy.cwd || ctx.isProjectTrusted() !== true || session.sessionManager.getSessionFile() !== undefined
      || session.settingsManager.getCompactionEnabled() !== false || session.settingsManager.getRetrySettings().enabled !== false
      || session.settingsManager.getProviderRetrySettings().maxRetries !== 0 || session.thinkingLevel !== "high"
      || session.model.baseUrl !== "https://chatgpt.com/backend-api" || session.model.api !== policy.pricing.api
      || `${session.model.provider}/${session.model.id}` !== policy.pricing.model || session.systemPrompt !== buildSystemPrompt(prompt)) throw Error();
    same(session.model.cost, policy.pricing.cost);
    return { model: `${session.model.provider}/${session.model.id}`, thinking: session.thinkingLevel, target, tools, systemPromptDigest: digest(session.systemPrompt) };
  } catch { throw new Error("Native session policy mismatch"); }
}
