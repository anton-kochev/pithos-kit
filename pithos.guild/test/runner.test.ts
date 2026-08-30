import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GUILD_MEMBER_NAMES, GUILD_MEMBER_POLICIES, type GuildMember } from "../src/agents";
import {
  applyJsonEvent,
  buildChildArguments,
  createEmptyRunResult,
  getRunFailure,
  truncateUtf8,
} from "../src/runner";

const coder: GuildMember = {
  name: "csharp-coder",
  description: "Implements C# code",
  tools: GUILD_MEMBER_POLICIES["csharp-coder"].tools,
  systemPrompt: "You are a C# coder.",
  source: "builtin",
  filePath: "/package/agents/csharp-coder.md",
};

describe("child pi invocation", () => {
  it("inherits the active model and thinking level while enforcing the member tools", () => {
    const args = buildChildArguments({
      member: coder,
      task: "Implement order validation",
      systemPromptFile: "/tmp/csharp-coder.md",
      model: "openai-codex/gpt-5.6-sol",
      thinkingLevel: "xhigh",
      projectTrusted: true,
    });

    assert.deepEqual(args, [
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--no-extensions",
      "--no-prompt-templates",
      "--approve",
      "--tools",
      "read,grep,find,ls,edit,write,bash",
      "--model",
      "openai-codex/gpt-5.6-sol",
      "--thinking",
      "xhigh",
      "--append-system-prompt",
      "/tmp/csharp-coder.md",
      "Task: Implement order validation",
    ]);
  });

  it("forwards every member's exact hard tool ceiling", () => {
    for (const name of GUILD_MEMBER_NAMES) {
      const member: GuildMember = {
        name,
        description: `${name} description`,
        tools: GUILD_MEMBER_POLICIES[name].tools,
        systemPrompt: `${name} prompt`,
        source: "builtin",
        filePath: `/package/agents/${name}.md`,
      };
      const args = buildChildArguments({
        member,
        task: "Characterize tool forwarding",
        systemPromptFile: `/tmp/${name}.md`,
        projectTrusted: true,
      });
      const toolsFlag = args.indexOf("--tools");

      assert.notEqual(toolsFlag, -1, `${name} must receive --tools`);
      assert.equal(args[toolsFlag + 1], GUILD_MEMBER_POLICIES[name].tools.join(","), name);
    }
  });

  it("pins the current child resource isolation flags without claiming future isolation", () => {
    const args = buildChildArguments({
      member: coder,
      task: "Inspect the project",
      systemPromptFile: "/tmp/prompt.md",
      projectTrusted: true,
    });

    for (const flag of ["--no-session", "--no-extensions", "--no-prompt-templates"]) {
      assert.ok(args.includes(flag), `Expected current child flag ${flag}`);
    }
    for (const futureFlag of ["--no-skills", "--no-context-files"]) {
      assert.equal(args.includes(futureFlag), false, `${futureFlag} is intentionally absent in Phase 0`);
    }
  });

  it("propagates an untrusted project decision and omits unavailable model settings", () => {
    const args = buildChildArguments({
      member: coder,
      task: "Inspect the project",
      systemPromptFile: "/tmp/prompt.md",
      projectTrusted: false,
    });

    assert.ok(args.includes("--no-approve"));
    assert.equal(args.includes("--model"), false);
    assert.equal(args.includes("--thinking"), false);
  });
});

describe("child JSON event aggregation", () => {
  it("reports truthful live activity from child tool events", () => {
    const result = createEmptyRunResult(coder, "Inspect repository");
    assert.equal(result.activity, "Starting handover");

    applyJsonEvent(result, { type: "tool_execution_start", toolName: "find" });
    assert.equal(result.activity, "Scanning repository");
    assert.equal(result.activityTool, "find");

    applyJsonEvent(result, { type: "tool_execution_end", toolName: "find" });
    assert.equal(result.activity, "Thinking");
    assert.equal(result.activityTool, undefined);

    applyJsonEvent(result, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Done" } });
    assert.equal(result.activity, "Preparing report");
  });

  it("streams text deltas and records final usage without duplicating final text", () => {
    const result = createEmptyRunResult(coder, "Do work");
    applyJsonEvent(result, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Done" } });
    applyJsonEvent(result, {
      type: "message_end",
      message: {
        role: "assistant",
        model: "gpt-5.6-sol",
        stopReason: "stop",
        content: [{ type: "text", text: "Done" }],
        usage: {
          input: 10,
          output: 5,
          cacheRead: 2,
          cacheWrite: 1,
          cost: { total: 0.25 },
          totalTokens: 18,
        },
      },
    });

    assert.equal(result.output, "Done");
    assert.equal(result.model, "gpt-5.6-sol");
    assert.equal(result.stopReason, "stop");
    assert.deepEqual(result.usage, {
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 1,
      cost: 0.25,
      contextTokens: 18,
      turns: 1,
    });
  });

  it("falls back to finalized assistant text when no deltas were emitted", () => {
    const result = createEmptyRunResult(coder, "Do work");
    applyJsonEvent(result, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "Final answer" }] },
    });

    assert.equal(result.output, "Final answer");
  });

  it("keeps only the latest finalized assistant output across tool-use turns", () => {
    const result = createEmptyRunResult(coder, "Do work");
    applyJsonEvent(result, {
      type: "message_end",
      message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "I will inspect the code." }] },
    });
    applyJsonEvent(result, { type: "message_start", message: { role: "assistant" } });
    applyJsonEvent(result, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Completed." } });
    applyJsonEvent(result, {
      type: "message_end",
      message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Completed." }] },
    });

    assert.equal(result.output, "Completed.");
    assert.equal(result.usage.turns, 2);
  });

  it("returns useful failure diagnostics for child and model errors", () => {
    const result = createEmptyRunResult(coder, "Do work");
    result.exitCode = 1;
    result.stopReason = "error";
    result.errorMessage = "Provider failed";
    result.stderr = "additional diagnostics";

    assert.equal(getRunFailure(result), "Provider failed");
  });
});

describe("model-visible output truncation", () => {
  it("caps UTF-8 output by bytes and explains the omission", () => {
    const value = "🙂".repeat(20);
    const truncated = truncateUtf8(value, 20);

    assert.ok(Buffer.byteLength(truncated, "utf8") > 20);
    assert.match(truncated, /Output truncated/);
    assert.equal(truncated.includes("�"), false);
  });
});
