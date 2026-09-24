import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { promises as fsPromises, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  GUILD_PROFILES,
  GUILD_ROLE_DEFINITIONS,
  GUILD_ROLES,
} from "../src/agents";
import {
  applyJsonEvent,
  createEmptyGuildRoleRunResult,
  getRunFailure,
  runGuildRole,
  runGuildRoleWithPackageRootForTest,
  truncateUtf8,
} from "../src/runner";

interface CapturedCanonicalRun {
  args: string[];
  basePromptPath: string;
  basePrompt: string;
  basePromptMode: number;
  roleProfilePromptPath: string;
  roleProfilePrompt: string;
  roleProfilePromptMode: number;
  nativeBinding?: Record<string, string | undefined>;
  envelope: unknown;
}

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-guild-runner-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function waitForFile(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (existsSync(filePath)) return;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function captureCanonicalRun(
  options: Parameters<typeof runGuildRole>[0],
  protocol = true,
  tail = "",
): Promise<{ capture: CapturedCanonicalRun; result: Awaited<ReturnType<typeof runGuildRole>> }> {
  const directory = temporaryDirectory();
  const childPath = join(directory, "capture-child.mjs");
  const capturePath = join(directory, "capture.json");
  writeFileSync(childPath, `
import { readFileSync, statSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const basePromptPath = option("--system-prompt");
const roleProfilePromptPath = option("--append-system-prompt");
writeFileSync(process.env.GUILD_RUNNER_CAPTURE_PATH, JSON.stringify({
  args,
  envelope: JSON.parse(readFileSync(process.env.GUILD_TASK_FILE, "utf8")),
  basePromptPath,
  basePrompt: readFileSync(basePromptPath, "utf8"),
  basePromptMode: statSync(basePromptPath).mode & 0o777,
  roleProfilePromptPath,
  roleProfilePrompt: readFileSync(roleProfilePromptPath, "utf8"),
  roleProfilePromptMode: statSync(roleProfilePromptPath).mode & 0o777,
  nativeBinding: Object.fromEntries(["GUILD_EVAL_CHILD_ID", "GUILD_EVAL_CHILD_RUN_ID", "GUILD_EVAL_CHILD_ROLE", "GUILD_EVAL_CHILD_PROFILE", "GUILD_EVAL_CHILD_TASK_DIGEST"].map(key => [key, process.env[key]])),
}));
const emit = event => process.stdout.write(JSON.stringify(event) + "\\n");
const task = JSON.parse(readFileSync(process.env.GUILD_TASK_FILE, "utf8"));
const {task: text, practices, ...header} = task;
const payloads = {explorer: {observations: [], unknowns: []}, architect: {decisions: [], contracts: [], handoff: []}, coder: {changes: [], verification: []}, reviewer: {scope: [], findings: [], verdict: "Approve"}};
const required = task.practices.length > 0;
const report = {...header, taskOutcome: required ? "blocked" : "succeeded", compliance: required ? [{id: "tdd", policy: "required", status: "blocked", reason: "No test execution", cycles: [], limitations: ["No red"]}] : [], summary: "Captured", blockers: required ? ["Tests unavailable"] : [], limitations: [], payload: payloads[task.role]};
if (${protocol}) emit({type: "message_end", message: {role: "custom", customType: "guild-protocol-ready", details: {protocol: task.protocol, version: 2, runId: task.runId, taskId: task.taskId, tools: option("--tools").split(",")}}});
process.stdout.write(JSON.stringify({ type: "tool_execution_start", toolName: "read" }) + "\\n");
process.stdout.write(JSON.stringify({
  type: "message_update",
  assistantMessageEvent: { type: "text_delta", delta: "Streamed" },
}) + "\\n");
process.stdout.write(JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    model: "captured-model",
    stopReason: "stop",
    content: [{ type: "text", text: "Captured" }],
    usage: { input: 3, output: 2, totalTokens: 5 },
  },
}) + "\\n");
if (${protocol}) {
 emit({type: "message_end", message: {role: "assistant", content: [{type: "toolCall", name: "guild_submit_result", id: "submit", arguments: report}]}});
 emit({type: "tool_execution_start", toolName: "guild_submit_result", toolCallId: "submit", args: report});
 emit({type: "tool_execution_end", toolName: "guild_submit_result", toolCallId: "submit", isError: false, result: {details: report}});
}
${tail}
emit({type: "agent_settled"});
`);

  const previousScript = process.argv[1];
  const previousCapturePath = process.env.GUILD_RUNNER_CAPTURE_PATH;
  process.argv[1] = childPath;
  process.env.GUILD_RUNNER_CAPTURE_PATH = capturePath;
  try {
    const result = await runGuildRole(options);
    return {
      capture: JSON.parse(readFileSync(capturePath, "utf8")) as CapturedCanonicalRun,
      result,
    };
  } finally {
    if (previousScript === undefined) process.argv.splice(1, 1);
    else process.argv[1] = previousScript;
    if (previousCapturePath === undefined) delete process.env.GUILD_RUNNER_CAPTURE_PATH;
    else process.env.GUILD_RUNNER_CAPTURE_PATH = previousCapturePath;
  }
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("canonical role/profile child invocation", () => {
  it("projects only requested practices into the host envelope and retains blocked reports", async () => {
    const practices = [{id: "tdd" as const, policy: "required" as const}];
    const {capture, result} = await captureCanonicalRun({role: "coder", profile: "typescript", task: " Preserve ", practices, cwd: process.cwd(), projectTrusted: false});
    assert.deepEqual((capture.envelope as any).practices, practices);
    assert.equal((capture.envelope as any).task, " Preserve ");
    assert.equal(result.status, "completed");
    assert.equal(result.report?.taskOutcome, "blocked");
    assert.deepEqual(result.report?.compliance[0]?.cycles, []);
  });

  it("optionally observes raw child transport with correlated lifecycle without changing the report", async () => {
    const observations: any[] = [];
    const telemetry = channel("pithos.guild.child");
    const collect = (event: unknown) => { observations.push(event); };
    telemetry.subscribe(collect);
    try {
      const { result } = await captureCanonicalRun({
        role: "reviewer", profile: "typescript", task: "Inspect", cwd: process.cwd(),
        projectTrusted: true, runId: "parent-tool-1",
      });
      assert.equal(observations[0]?.type, "start");
      assert.equal(observations.at(-1)?.type, "end");
      assert.equal(observations.at(-1)?.exitCode, 0);
      assert.equal(observations.at(-1)?.aborted, false);
      assert.ok(observations.every(e => e.runId === "parent-tool-1" && e.role === "reviewer" && e.profile === "typescript"));
      assert.equal(new Set(observations.map(e => e.childId)).size, 1);
      assert.deepEqual(observations.map(e => e.sequence), observations.map((_, i) => i));
      const stdout = Buffer.concat(observations.filter(e => e.type === "stdout").map(e => Buffer.from(e.base64, "base64"))).toString("utf8");
      assert.match(stdout, /guild-protocol-ready/);
      assert.match(stdout, /tool_execution_start/);
      assert.match(stdout, /"input":3/);
      assert.match(result.output, /Captured/);
      assert.equal(result.status, "completed");
      assert.equal("observations" in result, false);
    } finally { telemetry.unsubscribe(collect); }
  });

  it("passes candidate child identity to the inherited native preload without exposing the raw task", async () => {
    const observations: any[] = [], telemetry = channel("pithos.guild.child"), collect = (event: unknown) => observations.push(event);
    const prior = process.env.GUILD_EVAL_NATIVE_CONFIG; process.env.GUILD_EVAL_NATIVE_CONFIG = "/retained/native-config.json";
    telemetry.subscribe(collect);
    try {
      const task = "Inspect private child scope", { capture } = await captureCanonicalRun({ role: "architect", profile: "dotnet", task,
        cwd: process.cwd(), projectTrusted: true, runId: "handover-7" });
      const taskDigest = createHash("sha256").update(JSON.stringify(task)).digest("hex"), childId = observations[0].childId;
      assert.deepEqual(capture.nativeBinding, { GUILD_EVAL_CHILD_ID: childId, GUILD_EVAL_CHILD_RUN_ID: "handover-7",
        GUILD_EVAL_CHILD_ROLE: "architect", GUILD_EVAL_CHILD_PROFILE: "dotnet", GUILD_EVAL_CHILD_TASK_DIGEST: taskDigest });
      assert.ok(observations.every(event => event.taskDigest === taskDigest));
      assert.doesNotMatch(JSON.stringify(capture.nativeBinding), /Inspect private child scope/);
    } finally {
      telemetry.unsubscribe(collect);
      if (prior === undefined) delete process.env.GUILD_EVAL_NATIVE_CONFIG; else process.env.GUILD_EVAL_NATIVE_CONFIG = prior;
    }
  });

  it("closes an observed setup failure without inventing a process exit or usage", async () => {
    const events: any[] = [];
    const telemetry = channel("pithos.guild.child");
    const collect = (event: unknown) => { events.push(event); };
    telemetry.subscribe(collect);
    try {
      const result = await runGuildRole({
        role: "missing-role" as any, profile: "general", task: "Cannot load prompt", cwd: process.cwd(), projectTrusted: true,
      });
      assert.equal(result.status, "failed");
      assert.deepEqual(events.map(e => e.type), ["start", "end"]);
      assert.equal(events[1].exitCode, null);
      assert.equal("usage" in events[1], false);
    } finally { telemetry.unsubscribe(collect); }
  });

  it("enforces isolation and role-owned tools without runtime source, tool, or prompt overrides", async () => {
    const task = "Review --tools ownership without rewriting this free-form task";
    const overrideSentinel = "CALLER_OVERRIDE_MUST_NOT_APPEAR";
    const callerOptions = {
      role: "reviewer",
      profile: "typescript",
      task,
      cwd: process.cwd(),
      model: "openai-codex/gpt-5.6-sol",
      thinkingLevel: "xhigh",
      projectTrusted: true,
      source: "project",
      tools: ["write", "bash"],
      systemPrompt: overrideSentinel,
      rolePrompt: overrideSentinel,
      profilePrompt: overrideSentinel,
    } as const;
    const { capture, result } = await captureCanonicalRun(callerOptions);

    assert.deepEqual(capture.args, [
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--approve",
      "--tools",
      [...GUILD_ROLE_DEFINITIONS.reviewer.tools, "guild_submit_result"].join(","),
      "--extension",
      resolve(import.meta.dirname, "../src/child-protocol.ts"),
      "--model",
      "openai-codex/gpt-5.6-sol",
      "--thinking",
      "xhigh",
      "--system-prompt",
      capture.basePromptPath,
      "--append-system-prompt",
      capture.roleProfilePromptPath,
      `Task: ${task}`,
    ]);
    assert.deepEqual(GUILD_ROLE_DEFINITIONS.reviewer.tools, ["read", "grep", "find", "ls"]);
    assert.equal(GUILD_ROLE_DEFINITIONS.reviewer.tools.includes("bash"), false);
    assert.equal(capture.basePrompt.includes(overrideSentinel), false);
    assert.equal(capture.roleProfilePrompt.includes(overrideSentinel), false);
    assert.equal("source" in result, false);
    assert.equal("memberSource" in result, false);
    assert.match(result.output, /Captured/);
      assert.equal(result.status, "completed");
    assert.equal(result.usage.contextTokens, 5);
  });

  it("gives coders write tools while omitting model settings and denying untrusted approval", async () => {
    const { capture } = await captureCanonicalRun({
      role: "coder",
      profile: "angular",
      task: "Implement the focused change",
      cwd: process.cwd(),
      projectTrusted: false,
    });
    const toolsFlag = capture.args.indexOf("--tools");

    assert.equal(capture.args[toolsFlag + 1], "read,grep,find,ls,edit,write,bash,guild_submit_result");
    assert.deepEqual(GUILD_ROLE_DEFINITIONS.coder.tools, ["read", "grep", "find", "ls", "edit", "write", "bash"]);
    assert.ok(capture.args.includes("--no-approve"));
    assert.equal(capture.args.includes("--approve"), false);
    assert.equal(capture.args.includes("--model"), false);
    assert.equal(capture.args.includes("--thinking"), false);
  });

  it("injects only the selected complete package core after role/profile guidance with receipts and unchanged ceilings", async () => {
    const required = [{id: "tdd" as const, policy: "required" as const}];
    for (const [role, practices, id] of [["coder", required, "tdd"], ["reviewer", [], "code-review-standards"], ["coder", [], undefined]] as const) {
      const events: any[] = [], telemetry = channel("pithos.guild.child"), collect = (e: unknown) => events.push(e);
      telemetry.subscribe(collect);
      try {
        const {capture, result} = await captureCanonicalRun({role, profile: "rust", task: "Work", practices: [...practices], cwd: process.cwd(), projectTrusted: false});
        assert.ok(capture.args.includes("--no-skills"));
        assert.equal(capture.args[capture.args.indexOf("--tools") + 1], [...GUILD_ROLE_DEFINITIONS[role].tools, "guild_submit_result"].join(","));
        assert.deepEqual(result.selectedSkills?.map(s => s.id), id ? [id] : []);
        assert.deepEqual(events.at(-1)?.selectedSkills, result.selectedSkills);
        if (id) {
          const relative = `skills/${id}/SKILL.md`, source = resolve(import.meta.dirname, `../${relative}`);
          const content = readFileSync(source);
          assert.deepEqual(result.selectedSkills, [{id, source: "package", path: relative, bytes: content.length, sha256: createHash("sha256").update(content).digest("hex")}]);
          const prefix = `# Package skill core: ${id}\nSource: ${source}\nReferences: ${dirname(source)}/references/\n\n`;
          const start = capture.roleProfilePrompt.indexOf(prefix);
          assert.ok(start > 0);
          assert.equal(capture.roleProfilePrompt.slice(start + prefix.length, start + prefix.length + content.length), content.toString("utf8"));
          assert.match(capture.roleProfilePrompt.slice(0, start), /# (?:Coder|Reviewer)/);
        } else assert.doesNotMatch(capture.roleProfilePrompt, /# Package skill core:/);
        assert.doesNotMatch(capture.roleProfilePrompt, /# Package skill core: (?:dotnet-cqrs|conventional-commit)/);
        assert.doesNotMatch(result.output, /# Package skill core:/);
      } finally {telemetry.unsubscribe(collect);}
    }
  });

  it("loads and composes every fixed package role/profile prompt in private temporary files", async () => {
    for (const role of GUILD_ROLES) {
      const rolePrompt = readFileSync(resolve(import.meta.dirname, `../agents/roles/${role}.md`), "utf8");
      for (const profile of GUILD_PROFILES) {
        const profilePrompt = readFileSync(resolve(import.meta.dirname, `../agents/profiles/${profile}.md`), "utf8");
        const { capture } = await captureCanonicalRun({
          role,
          profile,
          task: `Exercise ${role}/${profile}`,
          cwd: process.cwd(),
          projectTrusted: true,
        });

        assert.equal(
          capture.basePrompt,
          [
            `# Standalone Guild member: ${role}/${profile}`,
            "",
            "Work only on the delegated task. You have an isolated context and cannot ask another member to finish your role.",
            "Treat the tool allowlist as a hard capability boundary.",
          ].join("\n"),
          `${role}/${profile} base prompt`,
        );
        assert.ok(capture.roleProfilePrompt.startsWith(`${rolePrompt.trimEnd()}\n\n${profilePrompt.trimEnd()}`), `${role}/${profile} appended prompt`);
        assert.deepEqual((capture.envelope as any).practices, []);
        assert.equal(capture.roleProfilePrompt.includes("# Package skill core:"), role === "reviewer", `${role}/${profile} selected core`);
        if (role === "coder") assert.deepEqual((await captureCanonicalRun({role, profile, task: "Required", practices: [{id: "tdd", policy: "required"}], cwd: process.cwd(), projectTrusted: true})).result.selectedSkills?.map(s => s.id), ["tdd"], `${profile} required TDD`);
        const toolsFlag = capture.args.indexOf("--tools");
        assert.equal(
          capture.args[toolsFlag + 1],
          [...GUILD_ROLE_DEFINITIONS[role].tools, "guild_submit_result"].join(","),
          `${role}/${profile} tools`,
        );
        assert.equal(capture.basePromptMode, 0o600, `${role}/${profile} base prompt mode`);
        assert.equal(capture.roleProfilePromptMode, 0o600, `${role}/${profile} appended prompt mode`);
        assert.equal(existsSync(capture.basePromptPath), false, `${role}/${profile} base prompt cleanup`);
        assert.equal(existsSync(capture.roleProfilePromptPath), false, `${role}/${profile} appended prompt cleanup`);
      }
    }
  });

  it("fails setup before spawn for missing, oversized and substituted fixture package cores", async () => {
    const root = temporaryDirectory(), skills = join(root, "skills", "tdd"), core = join(skills, "SKILL.md");
    mkdirSync(skills, {recursive: true});
    const child = join(root, "child.mjs"), marker = join(root, "spawned");
    writeFileSync(child, `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "spawned");`);
    const previous = process.argv[1]; process.argv[1] = child;
    const telemetry = channel("pithos.guild.child"), events: any[] = [], collect = (e: unknown) => events.push(e);
    telemetry.subscribe(collect);
    try {
      for (const variant of ["missing", "oversize", "symlink"]) {
        if (variant === "oversize") writeFileSync(core, Buffer.alloc(32769, 65));
        if (variant === "symlink") {rmSync(core); const outside = join(root, "outside.md"); writeFileSync(outside, "substituted"); symlinkSync(outside, core);}
        const result = await runGuildRoleWithPackageRootForTest({role: "coder", profile: "general", task: "Work", practices: [{id: "tdd", policy: "required"}], cwd: process.cwd(), projectTrusted: true}, root);
        assert.equal(result.status, "failed", variant);
        assert.match(getRunFailure(result) ?? "", /ENOENT|limit|regular|canonical|symlink/i, variant);
        assert.equal(existsSync(marker), false, variant);
        assert.deepEqual(events.slice(-2).map(e => e.type), ["start", "end"]);
        assert.equal(events.at(-1).exitCode, null);
      }
    } finally {telemetry.unsubscribe(collect); if (previous === undefined) process.argv.splice(1, 1); else process.argv[1] = previous;}
  });

  it("waits for an aborted child to stop before cleaning both prompt files", async () => {
    const directory = temporaryDirectory();
    const childPath = join(directory, "abort-child.mjs");
    const capturePath = join(directory, "abort-capture.json");
    const markerPath = join(directory, "abort-complete.txt");
    writeFileSync(childPath, `
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const basePromptPath = option("--system-prompt");
const roleProfilePromptPath = option("--append-system-prompt");
process.on("SIGTERM", () => {
  setTimeout(() => {
    writeFileSync(process.env.GUILD_RUNNER_ABORT_MARKER_PATH, "child cleanup complete");
    process.exit(0);
  }, 40);
});
writeFileSync(process.env.GUILD_RUNNER_CAPTURE_PATH, JSON.stringify({ basePromptPath, roleProfilePromptPath }));
setInterval(() => undefined, 1000);
`);

    const previousScript = process.argv[1];
    const previousCapturePath = process.env.GUILD_RUNNER_CAPTURE_PATH;
    const previousMarkerPath = process.env.GUILD_RUNNER_ABORT_MARKER_PATH;
    const controller = new AbortController();
    process.argv[1] = childPath;
    process.env.GUILD_RUNNER_CAPTURE_PATH = capturePath;
    process.env.GUILD_RUNNER_ABORT_MARKER_PATH = markerPath;
    let runPromise: ReturnType<typeof runGuildRole> | undefined;
    try {
      runPromise = runGuildRole({
        role: "reviewer",
        profile: "general",
        task: "Wait for child cleanup",
        cwd: process.cwd(),
        projectTrusted: true,
        signal: controller.signal,
      });
      await waitForFile(capturePath);
      const capture = JSON.parse(readFileSync(capturePath, "utf8")) as Pick<
        CapturedCanonicalRun,
        "basePromptPath" | "roleProfilePromptPath"
      >;

      controller.abort();
      assert.equal((await runPromise).status, "cancelled");

      assert.equal(readFileSync(markerPath, "utf8"), "child cleanup complete");
      assert.equal(existsSync(capture.basePromptPath), false);
      assert.equal(existsSync(capture.roleProfilePromptPath), false);
    } finally {
      controller.abort();
      await runPromise?.catch(() => undefined);
      if (previousScript === undefined) process.argv.splice(1, 1);
      else process.argv[1] = previousScript;
      if (previousCapturePath === undefined) delete process.env.GUILD_RUNNER_CAPTURE_PATH;
      else process.env.GUILD_RUNNER_CAPTURE_PATH = previousCapturePath;
      if (previousMarkerPath === undefined) delete process.env.GUILD_RUNNER_ABORT_MARKER_PATH;
      else process.env.GUILD_RUNNER_ABORT_MARKER_PATH = previousMarkerPath;
    }
  });
});

describe("canonical role/profile run results and JSON events", () => {
  it("exposes only canonical identity in a new run result", () => {
    const result = createEmptyGuildRoleRunResult("reviewer", "typescript", "Review the runner");

    assert.deepEqual(result, {
      role: "reviewer",
      profile: "typescript",
      task: "Review the runner",
      output: "",
      exitCode: 0,
      stderr: "",
      activity: "Starting handover",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
      },
    });
    assert.equal("member" in result, false);
    assert.equal("memberSource" in result, false);
    assert.equal("source" in result, false);
  });

  it("reports truthful live activity from child tool events", () => {
    const result = createEmptyGuildRoleRunResult("explorer", "general", "Inspect repository");
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
    const result = createEmptyGuildRoleRunResult("coder", "typescript", "Do work");
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
    const result = createEmptyGuildRoleRunResult("architect", "dotnet", "Do work");
    applyJsonEvent(result, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "Final answer" }] },
    });

    assert.equal(result.output, "Final answer");
  });

  it("keeps only the latest finalized assistant output across tool-use turns", () => {
    const result = createEmptyGuildRoleRunResult("coder", "rust", "Do work");
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
    const result = createEmptyGuildRoleRunResult("reviewer", "general", "Do work");
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

it("fails closed on prose-only child output rather than reporting success", async () => {
 const {result} = await captureCanonicalRun({role: "coder", profile: "general", task: "Work", cwd: process.cwd(), projectTrusted: true}, false);
 assert.ok(getRunFailure(result));
 assert.equal(result.status, "failed");
 assert.equal(result.output, "");
});

it("marks only finite reported usage fields as known instead of certifying absent zeroes", () => {
 const result = createEmptyGuildRoleRunResult("coder", "general", "Work");
 applyJsonEvent(result, {type: "message_end", message: {role: "assistant", content: [], usage: {input: 3, output: "bad", cost: {total: -1}}}});
 assert.deepEqual(result.usageFields, ["input"]);
 assert.equal(result.usage.input, 3);
 assert.equal(result.usage.output, 0);
 assert.equal(result.usage.cost, 0);
});

it("does not let a valid submission mask process/provider/extension/transport failure", async () => {
 for (const tail of [
  'process.exitCode = 3;',
  'emit({type: "message_end", message: {role: "assistant", stopReason: "error", errorMessage: "Provider failed", content: []}});',
  'process.stderr.write("Extension error (child-protocol.ts): hook failed");',
  'process.stderr.write("x".repeat(65537));',
  'process.stdout.write("x".repeat(1048577));',
 ]) {
  const {result} = await captureCanonicalRun({role: "coder", profile: "general", task: "Work", cwd: process.cwd(), projectTrusted: true}, true, tail);
  assert.equal(result.status, "failed", tail);
  assert.equal(result.output, "");
  assert.equal(result.usage.input, 3);
  assert.ok(result.usageFields?.includes("input"));
  assert.ok(Buffer.byteLength(result.stderr) < 66 * 1024);
 }
});
it("isolates throwing update callbacks and honors reentrant cancellation before terminal publication", async () => {
 const options = {role: "coder" as const, profile: "general" as const, task: "Work", cwd: process.cwd(), projectTrusted: true};
 const complete = await captureCanonicalRun({...options, onUpdate() {throw new Error("observer");}});
 assert.equal(complete.result.status, "completed");
 const controller = new AbortController();
 const cancelled = await captureCanonicalRun({...options, signal: controller.signal, onUpdate() {controller.abort();}});
 assert.equal(cancelled.result.status, "cancelled");
 assert.equal(cancelled.result.output, "");
});
it("waits for cleanup and refuses completion when owned cleanup fails", async () => {
 const original = fsPromises.rm;
 fsPromises.rm = async () => {throw new Error("fixture cleanup failure");};
 try {
  const {capture, result} = await captureCanonicalRun({role: "coder", profile: "general", task: "Work", cwd: process.cwd(), projectTrusted: true});
  temporaryDirectories.push(dirname(capture.basePromptPath));
  assert.equal(result.status, "failed");
  assert.match(getRunFailure(result) ?? "", /cleanup failed/);
  assert.equal(result.usage.input, 3);
 } finally {fsPromises.rm = original;}
});
it("retains host run/task identity on failed terminals without a child report", async () => {
 const {result} = await captureCanonicalRun({runId: "host-run", role: "coder", profile: "general", task: "Work", cwd: process.cwd(), projectTrusted: true}, false);
 assert.equal(result.runId, "host-run");
 assert.match(result.taskId ?? "", /^[0-9a-f-]{36}$/);
 assert.equal(result.report, undefined);
});
