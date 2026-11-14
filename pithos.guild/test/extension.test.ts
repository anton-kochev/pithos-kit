import assert from "node:assert/strict";
import {readFileSync, promises as fsPromises, mkdtempSync, writeFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {runGuildRole} from "../src/runner";
import { describe, it } from "node:test";
import { createEventBus, initTheme } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { Check } from "typebox/value";
import {
  GUILD_MEMBER_ALIASES,
  GUILD_PROFILES,
  GUILD_ROLE_DEFINITIONS,
  GUILD_ROLES,
  GUILD_TARGETS,
} from "../src/agents";
import { registerGuild, type GuildDependencies } from "../src/guild";
import type { GuildRoleRunResult, RunGuildRoleOptions } from "../src/runner";
import { LiveTranscriptStore } from "../src/live-transcript.ts";
import { createGuildBackgroundRuntime, type GuildExecutionRuntime } from "../src/background-runtime.ts";
import type { GuildOwner } from "../src/execution-authority.ts";
import type { RunBackgroundGuildRoleOptions } from "../src/background-runner.ts";
import { EventEmitter } from "node:events";
import { buildTask as buildHostTask, renderReport, validateResult } from "../src/protocol.ts";
import { buildTask, report } from "./protocol-fixtures.ts";

function backgroundResult(options: RunBackgroundGuildRoleOptions) {
 const task = buildHostTask({ role: options.role, profile: options.profile, task: options.task, practices: options.practices, runId: options.runId!, taskId: options.taskId! });
 return resultFor(options, { runId: task.runId, taskId: task.taskId, report: validateResult(report(task), task) });
}

function runtimeFixture(runner: (options: RunBackgroundGuildRoleOptions) => Promise<GuildRoleRunResult>) {
 const actual = createGuildBackgroundRuntime({ bus: { emit() {} }, parentEnvironment: { PITHOS_GUILD_PLAN_MODE: "standalone" }, runner });
 let owner!: GuildOwner;
 let activations = 0;
 const runtime: GuildExecutionRuntime = { ...actual, activate() { activations++; owner = actual.activate(); return owner; } };
 return { runtime, get owner() { return owner; }, get activations() { return activations; } };
}
const backgroundContext = () => ({ cwd: process.cwd(), projectTrusted: false, getBranch: () => [] });


initTheme();

it("shares one runtime participant Plan lease across live tool and direct handovers", async (t) => {
 const fixture = runtimeFixture(() => assert.fail("blocking handovers must not start background runs"));
 const pi = fakePi(); const ctx = context();
 const calls: string[] = [];
 let factories = 0;
 registerGuild(pi.api as never, {
  createExecutionRuntime: () => { factories++; return fixture.runtime; },
  run: async options => { calls.push(options.task); return resultFor(options); },
 });
 t.after(async () => { await pi.handlers.get("session_shutdown")({}, ctx); await fixture.runtime.shutdown(); });
 const hold = fixture.runtime.planParticipant.tryAcquire({});
 assert.equal(hold.kind, "held");
 if (hold.kind !== "held") return;
 const tool = () => pi.tool.execute("held-tool", {role: "explorer", profile: "general", task: "tool"}, undefined, undefined, ctx);
 const direct = () => pi.commands.get("guild-handover").handler("architect/general direct", ctx);
 const refused = await tool();
 await direct();
 assert.deepEqual(calls, [], "a real registry lease must prevent either runner path");
 assert.equal(refused.details.status, "failed");
 assert.match(refused.details.error, /Plan hold/i);
 assert.deepEqual(pi.messages.map(({message}) => message.details.status), ["started", "failed"]);
 assert.match(pi.messages[1].message.details.error, /Plan hold/i);
 hold.lease.release();
 assert.equal((await tool()).details.status, "completed");
 await direct();
 assert.deepEqual(calls, ["tool", "direct"]);
 assert.equal(factories, 1);
 assert.equal(fixture.activations, 1);
 assert.deepEqual(fixture.runtime.list(fixture.owner), [], "blocking reports do not become background records");
 assert.deepEqual(pi.messages.map(({message}) => message.details.status), ["started", "failed", "started", "completed"]);
});

it("refuses both handover paths for every nonterminal background state and resumes after cleanup", async () => {
 for (const state of ["queued", "running", "waiting", "stopping"] as const) {
  const gate = deferred<void>(); const cleanup = deferred<void>();
  const fixture = runtimeFixture(async options => {
   const question = new AbortController();
   try { if (state === "waiting") await options.onQuestion("Continue?", question.signal); }
   finally { await cleanup.promise; }
   return backgroundResult(options);
  });
  const pi = fakePi(); const ctx = context(); const calls: string[] = [];
  registerGuild(pi.api as never, {
   createExecutionRuntime: () => fixture.runtime,
   run: async options => { calls.push(options.task); return resultFor(options); },
  });
  let barrier: Promise<void> | undefined;
  try {
   if (state === "queued") barrier = fixture.runtime.runExclusive(fixture.owner, () => gate.promise);
   const background = fixture.runtime.start(fixture.owner, {role: "reviewer", profile: "general", task: "Background fixture"}, backgroundContext());
   if (state === "stopping") void fixture.runtime.cancel(fixture.owner, background.id);
   assert.equal(fixture.runtime.status(fixture.owner, background.id).status, state);
   const tool = () => pi.tool.execute(`background-${state}`, {role: "coder", profile: "general", task: "tool"}, undefined, undefined, ctx);
   const direct = () => pi.commands.get("guild-handover").handler("writer/general direct", ctx);
   const refused = await tool();
   await direct();
   assert.deepEqual(calls, [], `${state} background ownership must veto both paths`);
   assert.equal(refused.details.status, "failed");
   assert.match(refused.details.error, /Background work is still active/);
   assert.deepEqual(pi.messages.map(({message}) => message.details.status), ["started", "failed"]);
   assert.match(pi.messages[1].message.details.error, /Background work is still active/);
   const cancelled = fixture.runtime.cancel(fixture.owner, background.id);
   gate.resolve(); cleanup.resolve();
   await Promise.all([cancelled, barrier]);
   assert.equal(fixture.runtime.status(fixture.owner, background.id).status, "cancelled");
   assert.equal((await tool()).details.status, "completed");
   await direct();
   assert.deepEqual(calls, ["tool", "direct"]);
   assert.deepEqual(pi.messages.map(({message}) => message.details.status), ["started", "failed", "started", "completed"]);
   assert.equal(fixture.runtime.list(fixture.owner).length, 1, "retained terminal background records do not veto blocking work");
  } finally {
   gate.resolve(); cleanup.resolve();
   await pi.handlers.get("session_shutdown")({}, ctx);
   await fixture.runtime.shutdown(); await barrier;
  }
 }
});

it("drains more than eight mixed handovers FIFO before background work with once-only direct terminals", async (t) => {
 const pi = fakePi(); const ctx = context();
 const gates = Array.from({length: 12}, () => deferred<void>());
 const backgroundGate = deferred<void>();
 const starts: string[] = [];
 const runs: Promise<any>[] = [];
 let active = 0; let maximum = 0; let factories = 0;
 const fixture = runtimeFixture(async options => {
  starts.push("background");
  maximum = Math.max(maximum, ++active);
  try { await backgroundGate.promise; return backgroundResult(options); } finally { active--; }
 });
 registerGuild(pi.api as never, {
  createExecutionRuntime: () => { factories++; return fixture.runtime; },
  run: async options => {
   starts.push(options.task);
   maximum = Math.max(maximum, ++active);
   try { await gates[Number(options.task.slice(5))].promise; return resultFor(options); }
   finally { active--; }
  },
 });
 t.after(async () => {
  gates.forEach(gate => gate.resolve()); backgroundGate.resolve();
  await pi.handlers.get("session_shutdown")({}, ctx);
  await fixture.runtime.shutdown(); await Promise.allSettled(runs);
 });
 for (let index = 0; index < gates.length; index++) {
  const role = GUILD_ROLES[index % GUILD_ROLES.length];
  runs.push(index % 2 === 0
   ? pi.tool.execute(`mixed-${index}`, {role, profile: "general", task: `work-${index}`}, undefined, undefined, ctx)
   : pi.commands.get("guild-handover").handler(`${role}/general work-${index}`, ctx));
  // Direct commands await idle before admission; don't let later tool calls overtake that step.
  await new Promise<void>(resolve => setImmediate(resolve));
 }
 assert.deepEqual(starts, ["work-0"]);
 assert.deepEqual(fixture.runtime.planParticipant.tryAcquire({}), {kind: "busy", outstanding: 12});
 assert.deepEqual(fixture.runtime.list(fixture.owner), [], "all roles use exclusive operations, not background records");
 const background = fixture.runtime.start(fixture.owner, {role: "coder", profile: "general", task: "Background fixture"}, backgroundContext());
 assert.equal(background.status, "queued");
 assert.deepEqual(fixture.runtime.planParticipant.tryAcquire({}), {kind: "busy", outstanding: 13});
 for (let index = 0; index < gates.length; index++) {
  gates[index].resolve();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(starts, index === 11
   ? [...Array.from({length: 12}, (_, i) => `work-${i}`), "background"]
   : Array.from({length: index + 2}, (_, i) => `work-${i}`));
 }
 const results = await Promise.all(runs);
 assert.equal(maximum, 1);
 assert.equal(factories, 1);
 assert.equal(fixture.activations, 1);
 for (let index = 0; index < gates.length; index += 2) assert.equal(results[index].details.status, "completed");
 assert.equal(pi.messages.length, 12);
 for (let index = 1; index < gates.length; index += 2) {
  const events = pi.messages.filter(({message}) => message.details.task === `work-${index}`);
  assert.deepEqual(events.map(({message}) => message.details.status), ["started", "completed"]);
  assert.equal(events[0].message.details.runId, events[1].message.details.runId);
  assert.ok(events.every(event => event.options.triggerTurn === false));
 }
 backgroundGate.resolve();
 assert.equal((await fixture.runtime.wait(fixture.owner, background.id, 1000)).reason, "terminal");
 assert.equal(fixture.runtime.status(fixture.owner, background.id).status, "completed", fixture.runtime.status(fixture.owner, background.id).error);
 const hold = fixture.runtime.planParticipant.tryAcquire({});
 assert.equal(hold.kind, "held");
 if (hold.kind === "held") hold.lease.release();
});

it("exposes a provider-compatible strict practices schema", () => {
 const pi = fakePi();
 registerGuild(pi.api as any);
 const schema = pi.tool.parameters;
 assert.doesNotMatch(JSON.stringify(schema), /"(?:anyOf|oneOf|const)"\s*:/);
 const valid = {role: "coder", profile: "general", task: "Work", practices: [{id: "tdd", policy: "required"}]};
 assert.equal(Check(schema, valid), true);
 for (const practices of [[{id: "other", policy: "required"}], [{id: "tdd", policy: "optional"}], [{id: "tdd", policy: "required", extra: true}]]) {
  assert.equal(Check(schema, {...valid, practices}), false);
 }
});

async function assertTerminal(run: Promise<any>, status: string, diagnostic?: RegExp) {
 const result = await run;
 assert.equal(result.details.status, status);
 if (diagnostic) assert.match(result.details.error, diagnostic);
}

function successfulResult(overrides: Partial<GuildRoleRunResult> = {}): GuildRoleRunResult {
  const base: GuildRoleRunResult = {
    role: "coder",
    profile: "dotnet",
    status: "completed",
    report: (() => { const task = buildTask({role: "coder", profile: "dotnet", task: "Work"}); return validateResult(report(task), task); })(),
    task: "Implement validation",
    output: "### Status\nCompleted",
    exitCode: 0,
    stderr: "",
    model: "gpt-5.6-sol",
    stopReason: "stop",
    activity: "Completed",
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 3, turns: 1 },
  };
  return {
    ...base,
    ...overrides,
    usage: overrides.usage ? { ...overrides.usage } : { ...base.usage },
  };
}

function resultFor(options: RunGuildRoleOptions, overrides: Partial<GuildRoleRunResult> = {}): GuildRoleRunResult {
  return successfulResult({
    role: options.role,
    profile: options.profile,
    task: options.task,
    ...overrides,
  });
}

function successfulRunner(options: RunGuildRoleOptions): Promise<GuildRoleRunResult> {
  return Promise.resolve(resultFor(options));
}

function fakePi() {
  const shortcuts = new Map<string, any>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, any>();
  const messages: Array<{ message: any; options: any }> = [];
  const messageRenderers = new Map<string, any>();
  const events = new EventEmitter();
  const entries: any[] = [];
  let activeTools: string[] = [];
  const listeners = new Map<string, Set<any>>();
  return {
    api: {
      events,
      getThinkingLevel: () => "xhigh",
      getActiveTools: () => activeTools.filter(name => tools.get(name)?.exposure !== "hidden"),
      setActiveTools: (names: string[]) => { activeTools = names; },
      appendEntry(customType: string, data: unknown) { entries.push({id: `entry-${entries.length}`, parentId: entries.at(-1)?.id ?? null, type: "custom", customType, data: structuredClone(data)}); },
      registerShortcut(name: string, definition: any) { shortcuts.set(name, definition); },
      registerTool(definition: any) {
        tools.set(definition.name, definition);
      },
      registerCommand(name: string, definition: any) {
        commands.set(name, definition);
      },
      registerMessageRenderer(customType: string, renderer: any) {
        messageRenderers.set(customType, renderer);
      },
      sendMessage(message: any, options: any) {
        messages.push({ message, options });
      },
      on(name: string, handler: any) {
        let group = listeners.get(name);
        if (!group) { group = new Set(); listeners.set(name, group); }
        group.add(handler);
        handlers.set(name, (...args: any[]) => {
          const callbacks = [...listeners.get(name)!];
          if (callbacks.length === 1) return callbacks[0](...args);
          return (async () => {
            let result: any;
            for (const callback of callbacks) {
              const next = await callback(...args);
              result = next ?? result;
              if (result?.action === "handled" || result?.cancel || result?.block) return result;
              if (result?.action === "transform") args[0] = {...args[0], text: result.text, images: result.images};
            }
            return result;
          })();
        });
        return () => group!.delete(handler);
      },
    },
    get tool() {
      return tools.get("guild_handover");
    },
    tools,
    entries,
    shortcuts,
    commands,
    handlers,
    messages,
    messageRenderers,
  };
}

async function runCustom<T>(
  factory: (tui: any, theme: any, keybindings: any, done: (value: T) => void) => any,
): Promise<T> {
  let component: any;
  try {
    return await new Promise<T>((resolve) => {
      component = factory(
        { requestRender: () => undefined },
        {
          fg: (_color: string, text: string) => text,
          bg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        },
        { matches: () => false },
        resolve,
      );
    });
  } finally {
    component?.dispose?.();
  }
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    cwd: "/project",
    model: { provider: "openai-codex", id: "gpt-5.6-sol" },
    thinkingLevel: "xhigh",
    hasUI: true,
    mode: "tui",
    isIdle: () => true,
    waitForIdle: async () => undefined,
    sessionManager: { getBranch: () => [] },
    isProjectTrusted: () => true,
    ui: {
      confirm: async () => true,
      select: async () => undefined,
      editor: async () => undefined,
      custom: runCustom,
      notify: () => undefined,
      setWidget: () => undefined,
      setStatus: () => undefined,
      getEditorText: () => "",
      onTerminalInput: (_handler: any) => () => {},
    },
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function canonicalTargets(): string[] {
  return [...GUILD_TARGETS];
}

function assertCanonicalDetails(details: Record<string, unknown>, role: string, profile: string): void {
  assert.equal(details.role, role);
  assert.equal(details.profile, profile);
  assert.equal(details.source, "package");
  assert.equal(typeof details.model, "string");
  assert.equal(typeof details.thinkingLevel, "string");
  assert.equal(typeof details.phase, "string");
  assert.equal(typeof details.status, "string");
  assert.equal(Object.hasOwn(details, "member"), false);
  assert.equal(Object.hasOwn(details, "memberSource"), false);
  assert.equal(Object.hasOwn(details, "warnings"), false);
}

describe("guild extension", () => {
  it("routes every Go engineering target through tool and direct handovers", async () => {
    const pi = fakePi(), received: RunGuildRoleOptions[] = [];
    registerGuild(pi.api as never, {run: async options => {received.push(options); return resultFor(options);}});
    const ctx = context();
    for (const role of ["explorer", "architect", "coder", "reviewer"] as const) {
      const task = `Inspect ${role} Go behavior`;
      const result = await pi.tool.execute(`go-${role}`, {role, profile: "go", task}, undefined, undefined, ctx);
      assertCanonicalDetails(result.details, role, "go");
      await pi.commands.get("guild-handover").handler(`${role}/go ${task}`, ctx);
      assert.deepEqual(received.slice(-2).map(({role, profile, task}) => ({role, profile, task})), [
        {role, profile: "go", task}, {role, profile: "go", task},
      ]);
    }
    assert.equal(received.length, 8);
  });
  it("offers only writer/general, skips its profile picker, and reports writing permissions", async () => {
    const pi = fakePi();
    const received: RunGuildRoleOptions[] = [];
    registerGuild(pi.api as never, {run: async options => {
      received.push(options);
      const envelope = buildTask({role: options.role, profile: options.profile, task: options.task});
      const writerReport = validateResult(report(envelope), envelope);
      return resultFor(options, {report: writerReport, output: renderReport(writerReport)});
    }});
    const handover = pi.commands.get("guild-handover");
    assert.deepEqual(handover.getArgumentCompletions("writer/").map((item: any) => item.value), ["writer/general"]);
    const ctx: any = context();
    const selections: string[] = [];
    ctx.ui.select = async (title: string, choices: string[]) => {
      selections.push(title);
      assert.equal(title, "Choose a Guild role");
      return choices.find(choice => choice.startsWith("writer "));
    };
    ctx.ui.editor = async (title: string) => {
      assert.equal(title, "Task for writer/general");
      return "Write a short story at stories/music.md";
    };
    await handover.handler("", ctx);
    assert.deepEqual(selections, ["Choose a Guild role"]);
    assert.equal(received[0].role, "writer");
    assert.equal(received[0].profile, "general");
    assert.deepEqual(received[0].practices, []);
    assert.match(pi.messages[0].message.content, /Permissions: write-enabled \(no shell\)/);
    assert.deepEqual(pi.messages.map(({message}) => message.details.status), ["started", "completed"]);
    const toolResult = await pi.tool.execute("writer-tool", {role: "writer", profile: "general", task: "Revise stories/music.md"}, undefined, undefined, ctx);
    assertCanonicalDetails(toolResult.details, "writer", "general");
    assert.equal(toolResult.details.taskOutcome, "succeeded");
    assert.deepEqual(toolResult.details.tools, ["read", "grep", "find", "ls", "git_read", "edit", "write", "guild_submit_result"]);
    for (const profile of GUILD_PROFILES.filter(profile => profile !== "general")) {
      assert.throws(() => pi.tool.prepareArguments({role: "writer", profile, task: "Write"}), /unsupported/i);
      await assert.rejects(pi.tool.execute("bad-writer", {role: "writer", profile, task: "Write"}, undefined, undefined, ctx), /unsupported/i);
      await handover.handler(`writer/${profile} Write`, ctx);
      await handover.handler(`--json ${JSON.stringify({role: "writer", profile, task: "Write"})}`, ctx);
    }
    assert.equal(received.length, 2);
    assert.throws(() => pi.tool.prepareArguments({role: "writer", profile: "general", task: "Write", practices: [{id: "tdd", policy: "required"}]}), /practices/i);
  });
  it("correlates a runner observation with its parent tool call", async () => {
    const pi = fakePi();
    let received: RunGuildRoleOptions | undefined;
    registerGuild(pi.api as never, { run: async options => { received = options; return resultFor(options); } });
    await pi.tool.execute("observed-tool-1", { role: "explorer", profile: "general", task: "Inspect" }, undefined, undefined, context());
    assert.equal(received?.runId, "observed-tool-1");
  });

  it("publishes only the strict canonical role/profile/task schema", () => {
    const pi = fakePi();
    registerGuild(pi.api as never, { run: successfulRunner });

    const schema = pi.tool.parameters;
    assert.deepEqual(Object.keys(schema.properties), ["role", "profile", "task", "practices"]);
    assert.deepEqual(schema.required, ["role", "profile", "task"]);
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.properties.role.enum, GUILD_ROLES);
    assert.deepEqual(schema.properties.profile.enum, GUILD_PROFILES);
    assert.doesNotMatch(JSON.stringify(schema), /researcher|member/);

    assert.equal(Value.Check(schema, { role: "coder", profile: "typescript", task: "Implement it" }), true);
    assert.equal(Value.Check(schema, { role: "coder", profile: "go", task: "Implement it" }), true);
    for (const invalid of [
      { member: "typescript-coder", task: "legacy public shape" },
      { role: "researcher", profile: "typescript", task: "invalid role" },
      { role: "coder", profile: "researcher", task: "invalid profile" },
      { role: "coder", profile: "typescript", task: "extra", extra: true },
      { role: "coder", profile: "typescript", task: "mixed", member: "typescript-coder" },
    ]) {
      assert.equal(Value.Check(schema, invalid), false);
    }
  });

  it("migrates all known legacy member/task aliases and leaves every other raw shape invalid", () => {
    const pi = fakePi();
    registerGuild(pi.api as never, { run: successfulRunner });
    const prepare = pi.tool.prepareArguments;
    assert.equal(typeof prepare, "function");

    const canonical = { role: "coder", profile: "dotnet", task: "Implement validation" };
    assert.deepEqual(prepare(canonical), {...canonical, practices: []});

    for (const [member, target] of Object.entries(GUILD_MEMBER_ALIASES)) {
      const [role, profile] = target.split("/");
      const migrated = prepare({ member, task: `Run ${member}` });
      assert.deepEqual(migrated, { role, profile, task: `Run ${member}`, practices: [] });
      assert.equal(Object.hasOwn(migrated, "member"), false);
      assert.equal(Value.Check(pi.tool.parameters, migrated), true);
    }

    for (const invalid of [
      { member: "unknown-member", task: "Do not guess" },
      { member: "csharp-coder", role: "coder", task: "Mixed input" },
      { member: "csharp-coder", profile: "dotnet", task: "Mixed input" },
      { member: "csharp-coder", task: "Extra input", extra: true },
      { member: "csharp-coder" },
    ]) {
      assert.throws(() => prepare(invalid));
    }
  });

  it("registers canonical commands, all target-first completions, aliases, and no native-specialist observers", () => {
    const pi = fakePi();
    registerGuild(pi.api as never, { run: successfulRunner });

    assert.equal(pi.tool.name, "guild_handover");
    assert.match(pi.tool.description, /role\/profile/i);
    assert.equal(typeof pi.tool.renderCall, "function");
    assert.equal(typeof pi.tool.renderResult, "function");
    assert.ok(pi.commands.has("guild"));
    assert.ok(pi.commands.has("guild-handover"));
    assert.equal(pi.commands.has("specialists"), false);

    const handover = pi.commands.get("guild-handover");
    const completions = handover.getArgumentCompletions("");
    const aliases = Object.entries(GUILD_MEMBER_ALIASES);
    assert.equal(completions.length, 38);
    assert.deepEqual(completions.slice(0, 29).map((item: any) => item.value), canonicalTargets());
    assert.deepEqual(completions.slice(29).map((item: any) => item.value), aliases.map(([alias]) => alias));
    aliases.forEach(([, target], index) => {
      assert.match(completions[index + 29].description, new RegExp(target.replace("/", "\\/")));
    });
    assert.deepEqual(
      handover.getArgumentCompletions("coder/").map((item: any) => item.value),
      GUILD_PROFILES.map((profile) => `coder/${profile}`),
    );
    assert.equal(handover.getArgumentCompletions("coder/dotnet "), null);
    assert.equal(handover.getArgumentCompletions("researcher"), null);

    assert.equal(pi.handlers.has("tool_execution_start"), false);
    assert.equal(pi.handlers.has("tool_execution_end"), false);
    assert.equal(pi.handlers.has("message_start"), false);
  });

  it("uses shared inactive-Plan admission for tool and direct runs with identical inherited options and no override prompt", async () => {
    for (const trusted of [true, false]) {
      const pi = fakePi();
      const received: RunGuildRoleOptions[] = [];
      let confirmations = 0;
      let waits = 0;
      let trustCaptures = 0;
      registerGuild(pi.api as never, {
        run: async (options) => {
          received.push(options);
          return resultFor(options);
        },
      });
      const ctx: any = context({
        waitForIdle: async () => { waits += 1; },
        isProjectTrusted: () => {
          trustCaptures += 1;
          return trusted;
        },
      });
      ctx.ui.confirm = async () => {
        confirmations += 1;
        return true;
      };

      await pi.tool.execute(
        "tool-admission",
        { role: "coder", profile: "dotnet", task: "Implement validation" },
        undefined,
        undefined,
        ctx,
      );
      await pi.commands.get("guild-handover").handler("coder/dotnet Implement validation", ctx);

      assert.equal(received.length, 2);
      for (const options of received) {
        assert.equal(options.role, "coder");
        assert.equal(options.profile, "dotnet");
        assert.equal(options.task, "Implement validation");
        assert.equal(options.cwd, "/project");
        assert.equal(options.model, "openai-codex/gpt-5.6-sol");
        assert.equal(options.thinkingLevel, "xhigh");
        assert.equal(options.projectTrusted, trusted);
        assert.ok(options.signal instanceof AbortSignal);
      }
      assert.equal(confirmations, 0);
      assert.equal(trustCaptures, 2);
      assert.equal(waits, 1);
    }
  });

  it("blocks tool and direct handovers while Plan mode is active or indeterminate before trust or execution", async () => {
    for (const [data, state] of [[{ active: true }, "active"], [{}, "indeterminate"]] as const) {
      const pi = fakePi();
      let runs = 0;
      let trustCaptures = 0;
      let confirmations = 0;
      const notifications: string[] = [];
      registerGuild(pi.api as never, {
        run: async (options) => {
          runs += 1;
          return resultFor(options);
        },
      });
      const ctx: any = context({
        sessionManager: {
          getBranch: () => [{ type: "custom", customType: "plan-theme-state", data }],
        },
        isProjectTrusted: () => {
          trustCaptures += 1;
          return true;
        },
      });
      ctx.ui.confirm = async () => {
        confirmations += 1;
        return true;
      };
      ctx.ui.notify = (message: string) => notifications.push(message);

      await assert.rejects(
        () => pi.tool.execute(
          "plan-blocked-tool",
          { role: "architect", profile: "typescript", task: "Inspect boundaries" },
          undefined,
          undefined,
          ctx,
        ),
        new RegExp(`Plan mode.*${state}`, "i"),
      );
      await pi.commands.get("guild-handover").handler(
        "architect/typescript Inspect boundaries",
        ctx,
      );

      assert.equal(runs, 0);
      assert.equal(trustCaptures, 0);
      assert.equal(confirmations, 0);
      assert.equal(pi.messages.length, 0);
      assert.ok(notifications.some((message) => new RegExp(`Plan mode.*${state}`, "i").test(message)));
    }
  });

  it("returns canonical tool updates and result details while feeding queue phase into the compact dashboard", async () => {
    const pi = fakePi();
    const widgetUpdates: Array<string[] | undefined> = [];
    const statusUpdates: Array<string | undefined> = [];
    registerGuild(pi.api as never, {
      run: async (options) => {
        const visible = [...widgetUpdates].reverse().find(Array.isArray)?.join("\n") ?? "";
        assert.match(visible, /coder\/typescript.*running/);
        assert.doesNotMatch(visible, /openai-codex|read, grep/);
        assert.equal(options.task, "Implement validation");
        options.onUpdate?.(resultFor(options, {
          output: "Working",
          activity: "Running verification",
          activityTool: "bash",
        }));
        return resultFor(options);
      },
    });
    const ctx: any = context();
    let renderedPanel: any;
    ctx.ui.setWidget = (_key: string, value: any) => {
      const rendered = typeof value === "function"
        ? (renderedPanel = value(
          { terminal: {rows: 24}, requestRender: () => {if (renderedPanel) widgetUpdates.push(renderedPanel.render(120));} },
          {
            name: "test-light",
            fg: (_color: string, text: string) => text,
            bg: (_color: string, text: string) => text,
            bold: (text: string) => text,
            getBgAnsi: () => "\u001b[48;2;223;236;243m",
            getColorMode: () => "truecolor",
          },
        )).render(120)
        : value;
      widgetUpdates.push(rendered);
    };
    ctx.ui.setStatus = (_key: string, value: string | undefined) => statusUpdates.push(value);
    const updates: any[] = [];

    const result = await pi.tool.execute(
      "visible-tool",
      { role: "coder", profile: "typescript", task: "Implement validation" },
      undefined,
      (update: any) => updates.push(update),
      ctx,
    );

    assert.ok(widgetUpdates.some(lines => /running.*Implement validation/.test(lines?.join("\n") ?? "")), "running dashboard must include the task preview");
    assert.ok(updates.length >= 3);
    assert.deepEqual(updates.slice(0, 2).map(({ details }) => details.phase), ["queued", "running"]);
    assert.equal(updates[0].details.status, "queued");
    assert.equal(updates[1].details.status, "running");
    assert.equal(updates.at(-1).details.activityTool, "bash");
    assert.ok(statusUpdates.includes("guild: 1 active"));
    assert.equal(widgetUpdates.at(-1), undefined);
    assert.equal(statusUpdates.at(-1), undefined);

    assert.equal(result.content[0].text, "### Status\nCompleted");
    assertCanonicalDetails(result.details, "coder", "typescript");
    assert.equal(result.details.status, "completed");
    assert.equal(result.details.phase, "running");
    assert.equal(result.details.task, "Implement validation");
    assert.equal(result.details.model, "gpt-5.6-sol");
    assert.equal(result.details.inheritedModel, "openai-codex/gpt-5.6-sol");
    assert.equal(result.details.thinkingLevel, "xhigh");
    assert.deepEqual(result.details.tools, [...GUILD_ROLE_DEFINITIONS.coder.tools, "guild_submit_result"]);
  });

  it("bounds rendered output and returns detected runner failures", async () => {
    const longOutput = `Report: ${"é".repeat(40_000)}`;
    const truncatingPi = fakePi();
    registerGuild(truncatingPi.api as never, {
      run: async (options) => resultFor(options, { output: longOutput }),
    });

    const truncated = await truncatingPi.tool.execute(
      "truncate",
      { role: "reviewer", profile: "general", task: "Review output" },
      undefined,
      undefined,
      context(),
    );
    assert.match(truncated.content[0].text, /Output truncated: .* bytes omitted/);
    assert.ok(Buffer.byteLength(truncated.content[0].text, "utf8") < 53 * 1024);
    assert.equal(truncated.details.output, longOutput);

    const failingPi = fakePi();
    registerGuild(failingPi.api as never, {
      run: async (options) => resultFor(options, {
        exitCode: 1,
        stopReason: "error",
        errorMessage: "Provider failed",
      }),
    });
    await assertTerminal(
      failingPi.tool.execute(
        "failure",
        { role: "architect", profile: "dotnet", task: "Inspect architecture" },
        undefined,
        undefined,
        context(),
      ),
      "failed", /architect\/dotnet failed: Provider failed/,
    );
  });

  it("serializes tool runs FIFO with at most one injected runner active and captures queued trust", async () => {
    const pi = fakePi();
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const releaseSecond = deferred<void>();
    const starts: string[] = [];
    let active = 0;
    let maximumActive = 0;
    let secondTrust = true;
    registerGuild(pi.api as never, {
      run: async (options) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        starts.push(options.task);
        if (options.task === "first") {
          firstStarted.resolve();
          await releaseFirst.promise;
        } else {
          assert.equal(options.projectTrusted, true);
          assert.equal(options.cwd, "/project");
          assert.equal(options.model, "openai-codex/gpt-5.6-sol");
          assert.equal(options.thinkingLevel, "xhigh");
          secondStarted.resolve();
          await releaseSecond.promise;
        }
        active -= 1;
        return resultFor(options);
      },
    });

    const first = pi.tool.execute(
      "fifo-first",
      { role: "explorer", profile: "general", task: "first" },
      undefined,
      undefined,
      context(),
    );
    await firstStarted.promise;
    const secondUpdates: any[] = [];
    const secondContext: any = context({ isProjectTrusted: () => secondTrust });
    const second = pi.tool.execute(
      "fifo-second",
      { role: "coder", profile: "angular", task: "second" },
      undefined,
      (update: any) => secondUpdates.push(update),
      secondContext,
    );
    secondTrust = false;
    secondContext.cwd = "/different-project";
    secondContext.model = { provider: "changed", id: "changed-model" };
    secondContext.thinkingLevel = "off";

    assert.deepEqual(starts, ["first"]);
    assert.deepEqual(secondUpdates.map(({ details }) => details.phase), ["queued"]);
    releaseFirst.resolve();
    await secondStarted.promise;
    assert.deepEqual(starts, ["first", "second"]);
    releaseSecond.resolve();

    await Promise.all([first, second]);
    assert.equal(maximumActive, 1);
    assert.deepEqual(secondUpdates.slice(0, 2).map(({ details }) => details.phase), ["queued", "running"]);
  });

  it("cancels queued tool work without calling the runner", async () => {
    const pi = fakePi();
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const queuedController = new AbortController();
    const reason = new Error("cancel queued handover");
    const calls: string[] = [];
    registerGuild(pi.api as never, {
      run: async (options) => {
        calls.push(options.task);
        firstStarted.resolve();
        await releaseFirst.promise;
        return resultFor(options);
      },
    });

    const first = pi.tool.execute(
      "queued-first",
      { role: "explorer", profile: "general", task: "first" },
      undefined,
      undefined,
      context(),
    );
    await firstStarted.promise;
    const queuedUpdates: any[] = [];
    const queued = pi.tool.execute(
      "queued-cancelled",
      { role: "reviewer", profile: "general", task: "cancelled" },
      queuedController.signal,
      (update: any) => queuedUpdates.push(update),
      context(),
    );
    const rejected = assertTerminal(queued, "cancelled");

    queuedController.abort(reason);
    assert.deepEqual(calls, ["first"]);
    assert.deepEqual(queuedUpdates.map(({ details }) => details.phase), ["queued"]);
    releaseFirst.resolve();

    await first;
    await rejected;
    assert.deepEqual(calls, ["first"]);
  });

  it("keeps a follower queued after active abort until the runner settles", async () => {
    const pi = fakePi();
    const activeStarted = deferred<void>();
    const releaseActive = deferred<void>();
    const followerStarted = deferred<void>();
    const controller = new AbortController();
    const reason = new Error("cancel active handover");
    let activeSignal: AbortSignal | undefined;
    let followerRan = false;
    registerGuild(pi.api as never, {
      run: async (options) => {
        if (options.task === "active") {
          activeSignal = options.signal;
          activeStarted.resolve();
          await releaseActive.promise;
        } else {
          followerRan = true;
          followerStarted.resolve();
        }
        return resultFor(options);
      },
    });

    const active = pi.tool.execute(
      "abort-active",
      { role: "coder", profile: "typescript", task: "active" },
      controller.signal,
      undefined,
      context(),
    );
    const activeRejected = assertTerminal(active, "cancelled");
    await activeStarted.promise;
    const follower = pi.tool.execute(
      "abort-follower",
      { role: "reviewer", profile: "general", task: "follower" },
      undefined,
      undefined,
      context(),
    );

    controller.abort(reason);
    assert.equal(activeSignal?.aborted, true);
    await Promise.resolve();
    assert.equal(followerRan, false);
    releaseActive.resolve();
    await activeRejected;
    await followerStarted.promise;
    assert.equal((await follower).details.status, "completed");
  });

  it("releases a queued follower after an active runner failure", async () => {
    const pi = fakePi();
    const failedStarted = deferred<void>();
    const releaseFailure = deferred<void>();
    let followerRan = false;
    registerGuild(pi.api as never, {
      run: async (options) => {
        if (options.task === "fail") {
          failedStarted.resolve();
          await releaseFailure.promise;
          throw new Error("runner exploded");
        }
        followerRan = true;
        return resultFor(options);
      },
    });

    const failed = pi.tool.execute(
      "failure-first",
      { role: "coder", profile: "dotnet", task: "fail" },
      undefined,
      undefined,
      context(),
    );
    const failedRejection = assertTerminal(failed, "failed", /runner exploded/);
    await failedStarted.promise;
    const follower = pi.tool.execute(
      "failure-follower",
      { role: "explorer", profile: "general", task: "recover" },
      undefined,
      undefined,
      context(),
    );

    assert.equal(followerRan, false);
    releaseFailure.resolve();
    await failedRejection;
    assert.equal((await follower).content[0].text, "### Status\nCompleted");
    assert.equal(followerRan, true);
  });

  it("session shutdown clears visibility immediately, closes the queue, rejects queued work, aborts active work, and awaits settlement", async () => {
    const pi = fakePi();
    const activeStarted = deferred<void>();
    const releaseActive = deferred<void>();
    let activeSignal: AbortSignal | undefined;
    let calls = 0;
    let shutdownSettled = false;
    const widgetUpdates: unknown[] = [];
    const statusUpdates: Array<string | undefined> = [];
    registerGuild(pi.api as never, {
      run: async (options) => {
        calls += 1;
        activeSignal = options.signal;
        activeStarted.resolve();
        await releaseActive.promise;
        return resultFor(options);
      },
    });
    const ctx: any = context();
    ctx.ui.setWidget = (_key: string, value: unknown) => widgetUpdates.push(value);
    ctx.ui.setStatus = (_key: string, value: string | undefined) => statusUpdates.push(value);

    const active = pi.tool.execute(
      "shutdown-active",
      { role: "coder", profile: "dotnet", task: "active" },
      undefined,
      undefined,
      ctx,
    );
    const activeRejected = assertTerminal(active, "cancelled", /shut down/i);
    await activeStarted.promise;
    const queued = pi.tool.execute(
      "shutdown-queued",
      { role: "reviewer", profile: "general", task: "queued" },
      undefined,
      undefined,
      ctx,
    );
    const queuedRejected = assertTerminal(queued, "cancelled", /shut down/i);

    const shutdown = pi.handlers.get("session_shutdown")({}, ctx);
    void shutdown.then(() => { shutdownSettled = true; });
    assert.equal(activeSignal?.aborted, true);
    assert.equal(calls, 1);
    assert.equal(widgetUpdates.at(-1), undefined);
    assert.equal(statusUpdates.at(-1), undefined);
    await Promise.resolve();
    assert.equal(shutdownSettled, false);

    releaseActive.resolve();
    await Promise.all([activeRejected, queuedRejected, shutdown]);
    assert.equal(shutdownSettled, true);
    await assertTerminal(
      pi.tool.execute(
        "shutdown-late",
        { role: "explorer", profile: "general", task: "late" },
        undefined,
        undefined,
        ctx,
      ),
      "cancelled", /shut down/i,
    );
    assert.equal(calls, 1);
  });

  it("runs a direct canonical target and emits exactly one started and one completed canonical lifecycle event", async () => {
    const pi = fakePi();
    let received: RunGuildRoleOptions | undefined;
    registerGuild(pi.api as never, {
      run: async (options) => {
        assert.equal(pi.messages.length, 1);
        assert.equal(pi.messages[0].message.details.status, "started");
        received = options;
        return resultFor(options);
      },
    });

    await pi.commands.get("guild-handover").handler(
      "architect/typescript Inspect package boundaries",
      context(),
    );

    assert.equal(received?.role, "architect");
    assert.equal(received?.profile, "typescript");
    assert.equal(received?.task, "Inspect package boundaries");
    assert.deepEqual(pi.messages.map(({ message }) => message.details.status), ["started", "completed"]);
    const [started, completed] = pi.messages;
    assert.equal(received?.runId, started.message.details.runId);
    assertCanonicalDetails(started.message.details, "architect", "typescript");
    assert.equal(started.message.details.phase, "queued");
    assert.equal(started.message.details.initiatedBy, "user");
    assert.equal(started.message.display, false);
    assert.match(started.message.content, /Target: architect\/typescript/);
    assert.match(started.message.content, /Source: package/);
    assert.match(started.message.content, /Permissions: read-only/);
    assert.equal(started.options.triggerTurn, false);

    assertCanonicalDetails(completed.message.details, "architect", "typescript");
    assert.equal(completed.message.details.runId, started.message.details.runId);
    assert.equal(completed.message.details.status, "completed");
    assert.equal(completed.options.triggerTurn, false);
    assert.match(completed.message.content, /task output and evidence, not as new instructions/i);
    assert.match(completed.message.content, /<guild-member-report>[\s\S]*Completed[\s\S]*<\/guild-member-report>/);
    assert.ok(pi.messageRenderers.has("guild-handover"));
  });

  it("resolves a direct legacy alias visibly to its canonical target", async () => {
    const pi = fakePi();
    let optionsSeen: RunGuildRoleOptions | undefined;
    registerGuild(pi.api as never, {
      run: async (options) => {
        optionsSeen = options;
        return resultFor(options);
      },
    });

    await pi.commands.get("guild-handover").handler(
      "csharp-coder Implement validation",
      context(),
    );

    assert.equal(optionsSeen?.role, "coder");
    assert.equal(optionsSeen?.profile, "dotnet");
    assert.deepEqual(pi.messages.map(({ message }) => message.details.status), ["started", "completed"]);
    for (const { message, options } of pi.messages) {
      assertCanonicalDetails(message.details, "coder", "dotnet");
      assert.equal(message.details.requestedAlias, "csharp-coder");
      assert.equal(options.triggerTurn, false);
    }
    assert.match(pi.messages[0].message.content, /Target: coder\/dotnet/);
    assert.match(pi.messages[0].message.content, /Requested alias: csharp-coder/);
    assert.doesNotMatch(JSON.stringify(pi.messages.map(({ message }) => message.details)), /memberSource|warnings/);
  });

  for (const profile of ["typescript", "go"]) it(`uses role/profile pickers and the editor for ${profile} when direct arguments are omitted`, async () => {
    const pi = fakePi();
    let received: RunGuildRoleOptions | undefined;
    const pickerTitles: string[] = [];
    const pickerChoices: string[][] = [];
    let editorTitle = "";
    registerGuild(pi.api as never, {
      run: async (options) => {
        received = options;
        return resultFor(options);
      },
    });
    const ctx: any = context();
    ctx.ui.select = async (title: string, choices: string[]) => {
      pickerTitles.push(title);
      pickerChoices.push(choices);
      return pickerTitles.length === 1 ? choices[2] : pickerTitles.length === 2 ? choices.find(choice => choice.startsWith(`${profile} `)) : choices[0];
    };
    ctx.ui.editor = async (title: string) => {
      editorTitle = title;
      return "  Implement typed boundaries  ";
    };

    await pi.commands.get("guild-handover").handler("", ctx);

    assert.deepEqual(pickerTitles, ["Choose a Guild role", "Choose a Guild profile", "Choose coder practice"]);
    assert.equal(pickerChoices[0].length, 5);
    assert.equal(pickerChoices[1].length, 7);
    assert.match(pickerChoices[0][0], /^explorer \[read-only\]/);
    assert.match(pickerChoices[0][2], /^coder \[write-enabled\]/);
    assert.equal(editorTitle, `Task for coder/${profile}`);
    assert.equal(received?.role, "coder");
    assert.equal(received?.profile, profile);
    assert.equal(received?.task, "  Implement typed boundaries  ");
  });

  it("rejects unknown and researcher direct targets before opening the editor or running", async () => {
    const pi = fakePi();
    let editorCalls = 0;
    let runs = 0;
    const notifications: string[] = [];
    registerGuild(pi.api as never, {
      run: async (options) => {
        runs += 1;
        return resultFor(options);
      },
    });
    const ctx: any = context();
    ctx.ui.editor = async () => {
      editorCalls += 1;
      return "must not open";
    };
    ctx.ui.notify = (message: string) => notifications.push(message);

    for (const target of ["unknown", "researcher", "researcher/general", "architect/researcher"]) {
      await pi.commands.get("guild-handover").handler(target, ctx);
    }

    assert.equal(editorCalls, 0);
    assert.equal(runs, 0);
    assert.equal(pi.messages.length, 0);
    assert.equal(notifications.length, 4);
    assert.ok(notifications.every((message) => /Unknown Guild target/.test(message)));
  });

  it("creates no run or lifecycle event when either picker or the editor is cancelled before acceptance", async () => {
    for (const cancellationPoint of ["role", "profile", "editor"] as const) {
      const pi = fakePi();
      let runs = 0;
      let selectCalls = 0;
      let editorCalls = 0;
      registerGuild(pi.api as never, {
        run: async (options) => {
          runs += 1;
          return resultFor(options);
        },
      });
      const ctx: any = context();
      ctx.ui.select = async (_title: string, choices: string[]) => {
        selectCalls += 1;
        if (cancellationPoint === "role" || (cancellationPoint === "profile" && selectCalls === 2)) {
          return undefined;
        }
        return choices[0];
      };
      ctx.ui.editor = async () => {
        editorCalls += 1;
        return undefined;
      };

      await pi.commands.get("guild-handover").handler(
        cancellationPoint === "editor" ? "coder/typescript" : "",
        ctx,
      );

      assert.equal(runs, 0, cancellationPoint);
      assert.equal(editorCalls, cancellationPoint === "editor" ? 1 : 0, cancellationPoint);
      assert.equal(pi.messages.length, 0, cancellationPoint);
    }
  });

  it("feeds queued and running phases into direct focused progress", async () => {
    const pi = fakePi();
    const toolStarted = deferred<void>();
    const releaseTool = deferred<void>();
    const directStarted = deferred<void>();
    const releaseDirect = deferred<void>();
    const customReady = deferred<void>();
    let progress: any;
    let queuedCard = "";
    registerGuild(pi.api as never, {
      run: async (options) => {
        if (options.task === "block queue") {
          toolStarted.resolve();
          await releaseTool.promise;
        } else {
          directStarted.resolve();
          await releaseDirect.promise;
        }
        return resultFor(options);
      },
    });
    const toolRun = pi.tool.execute(
      "focused-blocker",
      { role: "explorer", profile: "general", task: "block queue" },
      undefined,
      undefined,
      context(),
    );
    await toolStarted.promise;

    const directCtx: any = context();
    directCtx.ui.custom = async (factory: any) => {
      try {
        return await new Promise((resolve) => {
          progress = factory(
            { requestRender: () => undefined },
            {
              fg: (_color: string, text: string) => text,
              bg: (_color: string, text: string) => text,
              bold: (text: string) => text,
            },
            { matches: () => false },
            resolve,
          );
          queuedCard = progress.render(100).join("\n");
          customReady.resolve();
        });
      } finally {
        progress?.dispose?.();
      }
    };
    const directRun = pi.commands.get("guild-handover").handler(
      "architect/dotnet direct queued",
      directCtx,
    );
    await customReady.promise;
    assert.match(queuedCard, /\[○ Queued/);
    assert.match(queuedCard, /architect\/dotnet.*package.*read-only/i);

    releaseTool.resolve();
    await toolRun;
    await directStarted.promise;
    assert.match(progress.render(100).join("\n"), /\[● Running/);
    releaseDirect.resolve();
    await directRun;
    assert.deepEqual(pi.messages.map(({ message }) => message.details.status), ["started", "completed"]);
  });

  it("waits for direct child cancellation and emits exactly one correlated cancelled event", async () => {
    const pi = fakePi();
    let childStopped = false;
    registerGuild(pi.api as never, {
      run: async (options) => new Promise<GuildRoleRunResult>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => {
          childStopped = true;
          reject(new Error("Guild role run was aborted."));
        }, { once: true });
      }),
    });
    const notifications: Array<{ message: string; level: string }> = [];
    const ctx: any = context();
    ctx.ui.notify = (message: string, level: string) => notifications.push({ message, level });
    ctx.ui.custom = async (factory: any) => {
      let component: any;
      try {
        return await new Promise((resolve) => {
          component = factory(
            { requestRender: () => undefined },
            {
              fg: (_color: string, text: string) => text,
              bg: (_color: string, text: string) => text,
              bold: (text: string) => text,
            },
            { matches: (data: string, binding: string) => data === "\u001b" && binding === "tui.select.cancel" },
            resolve,
          );
          queueMicrotask(() => component.handleInput("\u001b"));
        });
      } finally {
        component?.dispose?.();
      }
    };

    await pi.commands.get("guild-handover").handler(
      "coder/dotnet Implement validation",
      ctx,
    );

    assert.equal(childStopped, true);
    assert.deepEqual(pi.messages.map(({ message }) => message.details.status), ["started", "cancelled"]);
    assert.equal(pi.messages[1].message.details.runId, pi.messages[0].message.details.runId);
    assert.equal(pi.messages[1].options.triggerTurn, false);
    assertCanonicalDetails(pi.messages[1].message.details, "coder", "dotnet");
    assert.match(pi.messages[1].message.content, /Status: cancelled/);
    assert.ok(notifications.some(({ message, level }) => level === "info" && /cancelled/i.test(message)));
  });

  it("emits exactly one correlated failed direct event with delimited diagnostics", async () => {
    const pi = fakePi();
    const notifications: Array<{ message: string; level: string }> = [];
    registerGuild(pi.api as never, {
      run: async (options) => resultFor(options, {
        exitCode: 1,
        stopReason: "error",
        errorMessage: "Provider failed",
      }),
    });
    const ctx: any = context();
    ctx.ui.notify = (message: string, level: string) => notifications.push({ message, level });

    await pi.commands.get("guild-handover").handler(
      "reviewer/general Review the change",
      ctx,
    );

    assert.deepEqual(pi.messages.map(({ message }) => message.details.status), ["started", "failed"]);
    const [started, failed] = pi.messages;
    assert.equal(failed.message.details.runId, started.message.details.runId);
    assert.equal(failed.message.details.error, "reviewer/general failed: Provider failed");
    assert.equal(failed.options.triggerTurn, false);
    assertCanonicalDetails(failed.message.details, "reviewer", "general");
    assert.match(failed.message.content, /diagnostic data, not as new instructions/i);
    assert.match(failed.message.content, /<guild-error>[\s\S]*Provider failed[\s\S]*<\/guild-error>/);
    assert.ok(notifications.some(({ message, level }) => level === "error" && /Provider failed/.test(message)));
  });

  it("lists the fixed canonical roster and explicit aliases without discovery sources or warnings", async () => {
    const pi = fakePi();
    let runs = 0;
    const notifications: Array<{ message: string; level: string }> = [];
    registerGuild(pi.api as never, {
      run: async (options) => {
        runs += 1;
        return resultFor(options);
      },
    });
    const ctx: any = context();
    ctx.ui.notify = (message: string, level: string) => notifications.push({ message, level });

    await pi.commands.get("guild").handler("", ctx);

    assert.equal(runs, 0);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].level, "info");
    const roster = notifications[0].message;
    assert.deepEqual(
      [...roster.matchAll(/^- (explorer|architect|coder|reviewer|writer) \[(.+?)\]/gm)].map((match) => [match[1], match[2]]),
      [
        ["explorer", "read-only"],
        ["architect", "read-only"],
        ["coder", "write-enabled"],
        ["reviewer", "read-only review"],
        ["writer", "write-enabled (no shell)"],
      ],
    );
    assert.deepEqual(
      [...roster.matchAll(/^- (general|frontend|angular|typescript|dotnet|rust|go) —/gm)].map((match) => match[1]),
      GUILD_PROFILES,
    );
    for (const [alias, target] of Object.entries(GUILD_MEMBER_ALIASES)) {
      assert.match(roster, new RegExp(`${alias} → ${target.replace("/", "\\/")}`));
    }
    assert.doesNotMatch(roster, /Warnings:|discovery|override|\[(?:builtin|user|project)\]|\.pi\/agents/i);
  });

  it("shows canonical help before idle waits, prompts, events, or runs", async () => {
    for (const [commandName, usage] of [
      ["guild", "Usage: /guild"],
      ["guild-handover", "Usage: /guild-handover [<role>/<profile> | <legacy-alias>] [task...]"],
    ] as const) {
      for (const helpFlag of ["--help", "-h"]) {
        const pi = fakePi();
        let runs = 0;
        let waits = 0;
        let prompts = 0;
        const notifications: Array<{ message: string; level: string }> = [];
        registerGuild(pi.api as never, {
          run: async (options) => {
            runs += 1;
            return resultFor(options);
          },
        });
        const ctx: any = context({ waitForIdle: async () => { waits += 1; } });
        ctx.ui.confirm = async () => { prompts += 1; return true; };
        ctx.ui.select = async () => { prompts += 1; return undefined; };
        ctx.ui.editor = async () => { prompts += 1; return undefined; };
        ctx.ui.notify = (message: string, level: string) => notifications.push({ message, level });

        await pi.commands.get(commandName).handler(helpFlag, ctx);

        assert.equal(notifications.length, 1);
        assert.equal(notifications[0].level, "info");
        assert.match(notifications[0].message, new RegExp(usage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.match(notifications[0].message, /--help, -h/);
        if (commandName === "guild-handover") {
          const profiles = notifications[0].message.match(/Profiles:\n([\s\S]*?)\n\nOptions:/)?.[1];
          assert.deepEqual(profiles?.trim().split("\n").map(line => line.trim()), GUILD_PROFILES);
        }
        assert.equal(runs, 0);
        assert.equal(waits, 0);
        assert.equal(prompts, 0);
        assert.equal(pi.messages.length, 0);
      }
    }
  });

  it("registers Guild as the confirmed commit workflow owner", async () => {
    const pi = fakePi();
    registerGuild(pi.api as never, { run: successfulRunner });

    assert.ok(pi.commands.has("commit"));
    assert.ok(pi.tools.has("create_commit"));
    assert.ok(pi.handlers.has("input"));
    assert.ok(pi.handlers.has("tool_call"));

    const notifications: string[] = [];
    const ctx: any = context();
    ctx.ui.notify = (message: string) => notifications.push(message);
    await pi.commands.get("commit").handler("--help", ctx);

    assert.equal(pi.messages.length, 0);
    assert.match(notifications[0] ?? "", /Usage: \/commit \[instructions\]/);
  });

  it("handles conventional-commit skill help without starting an agent turn", async () => {
    const pi = fakePi();
    registerGuild(pi.api as never, { run: successfulRunner });
    const notifications: string[] = [];
    const ctx: any = context();
    ctx.ui.notify = (message: string) => notifications.push(message);

    const result = await pi.handlers.get("input")(
      { text: "/skill:conventional-commit --help" },
      ctx,
    );

    assert.deepEqual(result, { action: "handled" });
    assert.equal(pi.messages.length, 0);
    assert.match(notifications[0] ?? "", /Usage: \/skill:conventional-commit \[instructions\]/);
    assert.match(notifications[0] ?? "", /interactive confirmation/i);
  });

  it("starts the confirmed commit workflow without committing directly", async () => {
    const pi = fakePi();
    registerGuild(pi.api as never, { run: successfulRunner });

    await pi.commands.get("commit").handler("Guild queue changes", context());

    assert.equal(pi.messages.length, 1);
    assert.equal(pi.messages[0].message.customType, "guild-commit-workflow");
    assert.equal(pi.messages[0].message.display, false);
    assert.match(pi.messages[0].message.content, /Guild queue changes/);
    assert.match(pi.messages[0].message.content, /create_commit/);
    assert.deepEqual(pi.messages[0].options, { triggerTurn: true });
  });

  it("retains the commit workflow Plan-mode gate", async () => {
    for (const data of [{ active: true }, {}]) {
      const pi = fakePi();
      const notifications: string[] = [];
      registerGuild(pi.api as never, { run: successfulRunner });
      const ctx: any = context({
        sessionManager: {
          getBranch: () => [{ type: "custom", customType: "plan-theme-state", data }],
        },
      });
      ctx.ui.notify = (message: string) => notifications.push(message);

      await pi.commands.get("commit").handler("", ctx);

      assert.equal(pi.messages.length, 0);
      assert.match(notifications[0] ?? "", /commit.*unavailable.*Plan mode/i);
    }
  });
});

it("documents reviewer evidence classifications without imposing coder TDD or shell access", () => {
 const guidance = readFileSync(new URL("../agents/roles/reviewer.md", import.meta.url), "utf8");
 for (const label of ["corroborated", "contradicted", "unverified"]) assert.match(guidance, new RegExp(label));
 assert.match(guidance, /original requirement/i);
 assert.match(guidance, /no automatic pipeline/i);
 assert.doesNotMatch(guidance, /reviewer must run tests/i);
});

it("validates and copies canonical and legacy tool inputs before queue admission", async () => {
 const pi = fakePi(); const seen: RunGuildRoleOptions[] = [];
 registerGuild(pi.api as never, {run: async options => { seen.push(options); return resultFor(options); }});
 const input = {role: "coder", profile: "typescript", task: "  Work  ", practices: [{id: "tdd", policy: "required"}]};
 assert.deepEqual(pi.tool.prepareArguments(input), input);
 assert.equal(Value.Check(pi.tool.parameters, input), true);
 const pending = pi.tool.execute("copy", input, undefined, undefined, context());
 input.practices[0]!.id = "changed";
 await pending;
 assert.deepEqual(seen[0]?.practices, [{id: "tdd", policy: "required"}]);
 assert.equal(seen[0]?.task, "  Work  ");
 for (const invalid of [
  {role: "reviewer", profile: "general", task: "Review", practices: [{id: "tdd", policy: "required"}]},
  {role: "coder", profile: "general", task: "bad\0task"},
  {role: "coder", profile: "general", task: "é".repeat(17000)},
  {role: "coder", profile: "general", task: "Work", practices: [{id: "tdd", policy: "optional"}]},
 ]) {
  await assert.rejects(() => pi.tool.execute("invalid", invalid, undefined, undefined, context()));
 }
 assert.equal(seen.length, 1);
 assert.deepEqual(pi.tool.prepareArguments({member: "typescript-coder", task: "Legacy"}), {role: "coder", profile: "typescript", task: "Legacy", practices: []});
});

it("accepts only complete leading JSON and keeps default command tasks literal", async () => {
 const pi = fakePi(); const seen: RunGuildRoleOptions[] = []; const notifications: string[] = [];
 registerGuild(pi.api as never, {run: async options => { seen.push(options); return resultFor(options); }});
 const ctx: any = context(); ctx.ui.notify = (text: string) => notifications.push(text);
 const handler = pi.commands.get("guild-handover").handler;
 await handler('--json {"role":"coder","profile":"typescript","task":"  exact  ","practices":[{"id":"tdd","policy":"required"}]}', ctx);
 assert.deepEqual(seen[0]?.practices, [{id: "tdd", policy: "required"}]);
 assert.equal(seen[0]?.task, "  exact  ");
 for (const invalid of ['--json {"role":"coder","profile":"general","task":"Work"} garbage', '--json [1]', '--json {"role":"reviewer","profile":"general","task":"Review","practices":[{"id":"tdd","policy":"required"}]}']) await handler(invalid, ctx);
 assert.equal(seen.length, 1);
 assert.equal(pi.messages.length, 2);
 assert.equal(notifications.length, 3);
 await handler('coder/typescript Implement --json {"practices":"tdd"}', ctx);
 assert.equal(seen[1]?.task, 'Implement --json {"practices":"tdd"}');
 assert.deepEqual(seen[1]?.practices, []);
});

it("selects coder editor practice before preserving multiline task; cancellation creates no lifecycle", async () => {
 for (const pick of ["No requirement", "TDD required", undefined]) {
  const pi = fakePi(); const seen: RunGuildRoleOptions[] = []; const order: string[] = [];
  registerGuild(pi.api as never, {run: async options => {seen.push(options); return resultFor(options);}});
  const ctx: any = context();
  ctx.ui.select = async (title: string, choices: string[]) => { order.push(title); assert.deepEqual(choices, ["No requirement", "TDD required"]); return pick; };
  ctx.ui.editor = async () => { order.push("editor"); return "  first\nsecond  "; };
  await pi.commands.get("guild-handover").handler("coder/general", ctx);
  assert.deepEqual(order, pick ? ["Choose coder practice", "editor"] : ["Choose coder practice"]);
  assert.equal(seen[0]?.task, pick ? "  first\nsecond  " : undefined);
  assert.deepEqual(seen[0]?.practices, pick === "TDD required" ? [{id: "tdd", policy: "required"}] : pick ? [] : undefined);
  assert.equal(pi.messages.length, pick ? 2 : 0);
 }
});

it("carries blocked outcome, selected receipts and practices through tool and direct completion without error", async () => {
 const pi = fakePi(); const receipt = {id: "tdd", source: "package", path: "skills/tdd/SKILL.md", bytes: 42, sha256: "abc"};
 registerGuild(pi.api as never, {run: async options => {
  const task = buildTask({role: options.role, profile: options.profile, task: options.task, practices: options.practices});
  const submitted = validateResult({...report(task), taskOutcome: "blocked", blockers: ["Missing red"], compliance: [{id: "tdd", policy: "required", status: "blocked", reason: "No preimplementation red", cycles: [], limitations: []}]}, task);
  return resultFor(options, {selectedSkills: [receipt] as any, report: submitted, output: renderReport(submitted)});
 }});
 const input = {role: "coder", profile: "general", task: "Work", practices: [{id: "tdd", policy: "required"}]};
 const result = await pi.tool.execute("blocked", input, undefined, undefined, context());
 assert.equal(result.details.status, "completed");
 assert.equal(result.details.taskOutcome, "blocked");
 assert.match(result.content[0].text, /## compliance\n[\s\S]*No preimplementation red/);
 assert.deepEqual(result.details.selectedSkills, [receipt]);
 assert.deepEqual(result.details.practices, input.practices);
 assert.equal(pi.handlers.get("tool_result")({toolName: "guild_handover", details: result.details})?.isError, undefined);
 await pi.commands.get("guild-handover").handler('--json '+JSON.stringify(input), context());
 assert.deepEqual(pi.messages.map(({message}) => message.details.status), ["started", "completed"]);
 assert.equal(pi.messages[1].message.details.taskOutcome, "blocked");
 assert.match(pi.messages[1].message.content, /Task outcome: blocked/);
 assert.match(pi.messages[1].message.content, /## compliance\n[\s\S]*No preimplementation red/);
});

it("carries blocked writer artifacts and content-craft receipts through both public entry paths", async () => {
 const pi = fakePi();
 const receipt = {id: "content-craft", source: "package", path: "skills/content-craft/SKILL.md", bytes: 42, sha256: "abc"};
 registerGuild(pi.api as never, {run: async options => {
  const task = buildTask({role: options.role, profile: options.profile, task: options.task});
  const submitted = validateResult({...report(task), taskOutcome: "blocked", blockers: ["Explicit output path missing"], payload: {artifacts: [], sources: [], checks: []}}, task);
  return resultFor(options, {selectedSkills: [receipt] as any, report: submitted, output: renderReport(submitted)});
 }});
 const input = {role: "writer", profile: "general", task: "Write a story"};
 const result = await pi.tool.execute("writer-blocked", input, undefined, undefined, context());
 assert.equal(result.details.status, "completed");
 assert.equal(result.details.taskOutcome, "blocked");
 assert.deepEqual(result.details.report.payload.artifacts, []);
 assert.deepEqual(result.details.selectedSkills, [receipt]);
 assert.deepEqual(result.details.practices, []);
 assert.equal(pi.handlers.get("tool_result")({toolName: "guild_handover", details: result.details})?.isError, undefined);
 await pi.commands.get("guild-handover").handler('--json '+JSON.stringify(input), context());
 assert.deepEqual(pi.messages.map(({message}) => message.details.status), ["started", "completed"]);
 assert.equal(pi.messages[1].message.details.taskOutcome, "blocked");
 assert.deepEqual(pi.messages[1].message.details.selectedSkills, [receipt]);
 assert.match(pi.messages[1].message.content, /Explicit output path missing/);
});

it("returns the same failed terminal details and partial usage to tool and direct paths", async () => {
 const pi = fakePi();
 registerGuild(pi.api as never, {run: async options => resultFor(options, {status: "failed", errorMessage: "protocol missing", output: "", usageKnown: true})});
 const result = await pi.tool.execute("failed", {role: "coder", profile: "general", task: "Work"}, undefined, undefined, context());
 assert.equal(result.details.status, "failed");
 assert.equal(result.details.usage.input, 1);
 assert.equal(result.details.usageKnown, true);
 const patch = pi.handlers.get("tool_result")({toolName: "guild_handover", details: result.details});
 assert.equal(patch.isError, true);
 await pi.commands.get("guild-handover").handler("coder/general Work", context());
 const terminal = pi.messages.at(-1)!.message.details;
 assert.equal(terminal.status, "failed");
 assert.equal(terminal.usage.input, 1);
 assert.equal(terminal.usageKnown, true);
});
it("reports complete child provider usage to Pi on completed and failed tool results only", async () => {
 const providerUsage = {input: 4, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 7, cost: {input: 0.04, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.061}};
 for (const [overrides, expected] of [
  [{providerUsage}, providerUsage],
  [{providerUsage, status: "failed", errorMessage: "protocol missing", output: ""}, providerUsage],
  [{providerUsage: null}, undefined],
  [{}, undefined],
 ] as const) {
  const pi = fakePi();
  registerGuild(pi.api as never, {run: async options => resultFor(options, overrides as Partial<GuildRoleRunResult>)});
  const result = await pi.tool.execute("usage", {role: "coder", profile: "general", task: "Work"}, undefined, undefined, context());
  assert.deepEqual(result.usage, expected);
  if (expected) assert.notEqual(result.usage, providerUsage);
  assert.equal("providerUsage" in result.details, false);
 }
});
it("binds each tool and direct handover to its parent session for trace recording", async () => {
 const events: string[] = [];
 let created = 0;
 const bindings: any[] = [];
 const traceRecorder = {
  bind(runId: string, binding: unknown) {
   bindings.push({runId, binding});
   events.push(`bind:${runId}`);
   return () => events.push(`unbind:${runId}`);
  },
  dispose: () => events.push("dispose"),
 };
 const pi = fakePi();
 const captures: any[] = [];
 const captureRepoState = async (options: any) => { captures.push(options); events.push(`capture:${options.directory}`); return {state: "x.state", head: "abc", dirty: false, complete: true}; };
 registerGuild(pi.api as never, {run: async options => { events.push(`run:${options.runId}`); return resultFor(options); }, createTraceRecorder: () => { created++; return traceRecorder; }, captureRepoState});
 const sessionManager = {getBranch: () => [], getSessionDir: () => "/sessions/project", getSessionId: () => "session-7", getSessionFile: () => "/sessions/project/s.jsonl"};
 assert.equal(created, 0);
 await pi.handlers.get("session_start")({reason: "startup"}, context({sessionManager}));
 await pi.handlers.get("session_start")({reason: "reload"}, context({sessionManager}));
 assert.equal(created, 1);
 await pi.tool.execute("tool-call-1", {role: "coder", profile: "general", task: "Work"}, undefined, undefined, context({sessionManager}));
 assert.deepEqual(events, ["capture:/sessions/project/guild/session-7/tool-call-1.state", "bind:tool-call-1", "run:tool-call-1", "unbind:tool-call-1"]);
 assert.equal(captures[0].cwd, "/project");
 assert.deepEqual(bindings[0].binding, {sessionDir: "/sessions/project", sessionId: "session-7", sessionFile: "/sessions/project/s.jsonl", model: "openai-codex/gpt-5.6-sol", thinkingLevel: "xhigh", repoState: {state: "x.state", head: "abc", dirty: false, complete: true}});
 await pi.commands.get("guild-handover").handler("coder/general Work", context({sessionManager}));
 assert.equal(bindings.length, 2);
 assert.equal(bindings[1].binding.sessionId, "session-7");
 await pi.handlers.get("session_shutdown")({reason: "quit"}, context({sessionManager}));
 assert.equal(events.at(-1), "dispose");
 await pi.handlers.get("session_start")({reason: "new"}, context({sessionManager}));
 assert.equal(created, 1, "shutdown registrations cannot revive their recorder");
});
it("captures repository state only for traced runs and uses filesystem-safe run names", async () => {
 const directories: string[] = [];
 const captureRepoState = async (options: any) => { directories.push(options.directory); return {error: "not a git repository"}; };
 const sessionManager = {getBranch: () => [], getSessionDir: () => "/sessions/project", getSessionId: () => "session-7"};
 const untraced = fakePi();
 registerGuild(untraced.api as never, {run: async options => resultFor(options), createTraceRecorder: () => undefined, captureRepoState});
 await untraced.handlers.get("session_start")({reason: "startup"}, context({sessionManager}));
 await untraced.tool.execute("plain", {role: "coder", profile: "general", task: "Work"}, undefined, undefined, context({sessionManager}));
 assert.deepEqual(directories, []);
 const bindings: any[] = [];
 const traced = fakePi();
 registerGuild(traced.api as never, {run: async options => resultFor(options), createTraceRecorder: () => ({bind: (_runId: string, binding: unknown) => { bindings.push(binding); return () => undefined; }, dispose: () => undefined}), captureRepoState});
 await traced.handlers.get("session_start")({reason: "startup"}, context({sessionManager}));
 const result = await traced.tool.execute("call_1|fc/../x", {role: "coder", profile: "general", task: "Work"}, undefined, undefined, context({sessionManager}));
 assert.equal(result.details.status, "completed");
 assert.deepEqual(directories, ["/sessions/project/guild/session-7/call_1_fc_.._x.state"]);
 assert.deepEqual(bindings[0].repoState, {error: "not a git repository"});
});
it("skips trace binding when the parent session has no directory or id", async () => {
 const bindings: string[] = [];
 const pi = fakePi();
 registerGuild(pi.api as never, {run: async options => resultFor(options), createTraceRecorder: () => ({bind: runId => { bindings.push(runId); return () => undefined; }, dispose: () => undefined})});
 await pi.handlers.get("session_start")({reason: "startup"}, context());
 await pi.tool.execute("no-session", {role: "coder", profile: "general", task: "Work"}, undefined, undefined, context());
 assert.deepEqual(bindings, []);
});
it("does not accept legacy prose as a new completed handover", async () => {
 const pi = fakePi();
 registerGuild(pi.api as never, {run: async options => resultFor(options, {status: undefined})});
 const result = await pi.tool.execute("prose", {role: "coder", profile: "general", task: "Work"}, undefined, undefined, context());
 assert.equal(result.details.status, "failed");
});
it("preserves original tool task text in the shared runner input", async () => {
 const pi = fakePi(); let task: string | undefined;
 registerGuild(pi.api as never, {run: async options => { task = options.task; return resultFor(options); }});
 await pi.tool.execute("original", {role: "coder", profile: "general", task: "  Work\n "}, undefined, undefined, context());
 assert.equal(task, "  Work\n ");
});
it("settles exactly once when a phase observer reentrantly shuts down the queue", async () => {
 for (const stopAt of ["queued", "running"]) {
  const pi = fakePi(); const ctx = context(); let calls = 0;
  registerGuild(pi.api as never, {run: async options => {
   calls++;
   assert.equal(options.signal?.aborted, true);
   return resultFor(options);
  }});
  let shutdown: Promise<void> | undefined;
  const terminal = await pi.tool.execute(`reentrant-${stopAt}`, {role: "coder", profile: "general", task: "Work"}, undefined, (update: any) => {
   if (!shutdown && update.details.phase === stopAt) shutdown = pi.handlers.get("session_shutdown")({}, ctx);
  }, ctx);
  await shutdown;
  assert.equal(terminal.details.status, "cancelled");
  assert.equal(calls, 0, "phase shutdown must suppress prelaunch runner setup");
 }
});

it("seals one cancelled transcript without launch after reentrant queued or running abort", async () => {
 for (const stopAt of ["queued", "running"]) {
  const pi = fakePi(); const ctx = context();
  const fixture = runtimeFixture(() => assert.fail("unexpected background start"));
  const store = new LiveTranscriptStore(); const controller = new AbortController();
  const terminals: string[] = []; const phases: string[] = [];
  let launches = 0;
  store.subscribe(() => {
   const phase = store.get("phase-abort")?.phase;
   if (phase === "cancelled" || phase === "completed" || phase === "failed") terminals.push(phase);
  });
  registerGuild(pi.api as never, {
   createExecutionRuntime: () => fixture.runtime, createTranscriptStore: () => store,
   run: async options => { launches++; return resultFor(options); },
  });
  try {
   const result = await pi.tool.execute("phase-abort", {role: "coder", profile: "general", task: "Work"}, controller.signal, (update: any) => {
    phases.push(update.details.phase);
    if (update.details.phase === stopAt) controller.abort(new Error("phase abort"));
   }, ctx);
   assert.equal(result.details.status, "cancelled");
   assert.match(result.details.error, /phase abort/);
   assert.equal(launches, 0);
   assert.deepEqual(phases, stopAt === "queued" ? ["queued"] : ["queued", "running"]);
   assert.deepEqual(terminals, ["cancelled"]);
   const hold = fixture.runtime.planParticipant.tryAcquire({});
   assert.equal(hold.kind, "held");
   if (hold.kind === "held") hold.lease.release();
  } finally { await pi.handlers.get("session_shutdown")({}, ctx); await fixture.runtime.shutdown(); }
 }
});

it("tracks admitted queued transcripts and immutable runner events separately from results", async () => {
 const store = new LiveTranscriptStore();
 const pi = fakePi();
 const gate = deferred<void>();
 let calls = 0;
 let notifications = 0;
 store.subscribe(() => { notifications++; });
 registerGuild(pi.api as any, {
  createTranscriptStore: () => store,
  run: async options => {
   calls++;
   assert.equal(store.get(options.runId!)?.phase, "running");
   options.onEvent?.({type: "message_update", assistantMessageEvent: {type: "text_delta", delta: "private live text", contentIndex: 0}});
   options.onEvent?.({type: "tool_execution_end", toolCallId: "read1", toolName: "read", result: {content: [{type: "text", text: "private tool result"}]}});
   await gate.promise;
   return resultFor(options);
  },
 });
 const task = "Original\n task";
 const first = pi.tool.execute("live-first", {role: "coder", profile: "typescript", task}, undefined, undefined, context());
 const snapshot = store.get("live-first")!;
 assert.equal(snapshot.task, task);
 assert.equal(snapshot.entries[0].content, "private live text");
 assert.equal(snapshot.entries[1].content, "private tool result");
 assert.ok(Object.isFrozen(snapshot.entries));
 const second = pi.tool.execute("live-second", {role: "reviewer", profile: "general", task: "Next"}, undefined, undefined, context());
 assert.equal(store.get("live-second")?.phase, "queued");
 assert.equal(calls, 1);
 gate.resolve();
 const results = await Promise.all([first, second]);
 assert.deepEqual(store.list().recent.map(run => run.phase), ["completed", "completed"]);
 assert.equal(snapshot.phase, "running");
 assert.equal(results[0].details.task, task);
 assert.doesNotMatch(JSON.stringify(results), /private live text|private tool result/);
 assert.equal(pi.messages.length, 0);
 assert.ok(notifications >= 8);
});

it("seals focused blocked completion, failures and queued cancellation exactly once", async () => {
 class RecordingStore extends LiveTranscriptStore {
  finishes: string[] = [];
  override finish(...args: Parameters<LiveTranscriptStore["finish"]>) {
   this.finishes.push(args[0]);
   super.finish(...args);
  }
 }
 const store = new RecordingStore();
 const pi = fakePi();
 const gate = deferred<void>();
 const spawned: string[] = [];
 registerGuild(pi.api as any, {createTranscriptStore: () => store, run: async options => {
  spawned.push(options.task);
  if (options.task === "Fail") throw new Error("runner failure");
  if (options.task === "Hold") await gate.promise;
  const result = resultFor(options);
  if (options.task === "Blocked") result.report = {...result.report!, taskOutcome: "blocked", blockers: ["External blocker"]};
  return result;
 }});
 await pi.commands.get("guild-handover").handler("coder/typescript Blocked", context());
 const directId = pi.messages[0].message.details.runId;
 assert.equal(store.get(directId)?.phase, "completed");
 assert.equal(pi.messages[1].message.details.taskOutcome, "blocked");
 assert.equal(store.list().active.length, 0);
 await assertTerminal(pi.tool.execute("live-fail", {role: "coder", profile: "typescript", task: "Fail"}, undefined, undefined, context()), "failed");
 assert.equal(store.get("live-fail")?.phase, "failed");
 assert.match(store.get("live-fail")!.diagnostic!, /runner failure/);
 const active = pi.tool.execute("live-hold", {role: "coder", profile: "typescript", task: "Hold"}, undefined, undefined, context());
 const controller = new AbortController();
 const queued = pi.tool.execute("live-cancel", {role: "reviewer", profile: "general", task: "Never spawn"}, controller.signal, undefined, context());
 controller.abort();
 await assertTerminal(queued, "cancelled");
 assert.equal(store.get("live-cancel")?.phase, "cancelled");
 assert.ok(!spawned.includes("Never spawn"));
 gate.resolve();
 await active;
 assert.equal(new Set(store.finishes).size, 4);
 assert.equal(store.finishes.length, 4);
});

it("isolates every transcript observation without swallowing runner or update failures", async () => {
 class ThrowingStore extends LiveTranscriptStore {
  observed: string[] = [];
  private fail(name: string): never { this.observed.push(name); throw new Error(`observer ${name}`); }
  override start(): void { this.fail("start"); }
  override updatePhase(): void { this.fail("phase"); }
  override ingest(): void { this.fail("ingest"); }
  override finish(): void { this.fail("finish"); }
  override dispose(): void { this.fail("dispose"); }
 }
 const store = new ThrowingStore();
 const pi = fakePi();
 registerGuild(pi.api as any, {createTranscriptStore: () => store, run: async options => {
  options.onEvent?.({type: "message_end", message: {role: "assistant", content: [{type: "text", text: "Live"}]}});
  if (options.task === "Runner fails") throw new Error("execution failed");
  options.onUpdate?.(resultFor(options));
  return resultFor(options);
 }});
 await assertTerminal(pi.tool.execute("observe-ok", {role: "coder", profile: "general", task: "Success"}, undefined, undefined, context()), "completed");
 await assertTerminal(pi.tool.execute("observe-fail", {role: "coder", profile: "general", task: "Runner fails"}, undefined, undefined, context()), "failed", /execution failed/);
 await assertTerminal(pi.tool.execute("update-fail", {role: "coder", profile: "general", task: "Update fails"}, undefined, (update: any) => {
  if (update.details.activity === "Completed") throw new Error("update failed");
 }, context()), "failed", /update failed/);
 await pi.handlers.get("session_shutdown")({}, context());
 for (const name of ["start", "phase", "ingest", "finish", "dispose"]) assert.ok(store.observed.includes(name), name);
});

it("disposes session transcripts before awaiting shutdown and rejects late resurrection", async () => {
 const store = new LiveTranscriptStore();
 const pi = fakePi();
 const gate = deferred<void>();
 let options!: RunGuildRoleOptions;
 let factories = 0;
 let calls = 0;
 let notifications = 0;
 store.subscribe(() => { throw new Error("subscriber failure"); });
 store.subscribe(() => { notifications++; });
 registerGuild(pi.api as any, {createTranscriptStore: () => { factories++; return store; }, run: async value => {
  calls++;
  options = value;
  value.onEvent?.({type: "message_update", assistantMessageEvent: {type: "text_delta", delta: "Secret"}});
  await gate.promise;
  return resultFor(value);
 }});
 assert.equal(factories, 1);
 assert.equal(calls, 0);
 assert.deepEqual(store.list().active, []);
 assert.equal(pi.handlers.has("session_before_switch"), false);
 const active = pi.tool.execute("dispose-active", {role: "coder", profile: "typescript", task: "Active"}, undefined, undefined, context());
 const queued = pi.tool.execute("dispose-queued", {role: "coder", profile: "typescript", task: "Queued"}, undefined, undefined, context());
 assert.equal(store.list().active.length, 2);
 let settled = false;
 const shutdown = pi.handlers.get("session_shutdown")({reason: "reload"}, context());
 void shutdown.then(() => { settled = true; });
 assert.equal(store.get("dispose-active"), undefined);
 assert.equal(store.list().retainedBytes, 0);
 assert.equal(settled, false);
 const changes = notifications;
 options.onEvent?.({type: "message_update", assistantMessageEvent: {type: "text_delta", delta: "Late secret"}});
 store.start({id: "late-direct", role: "coder", profile: "typescript", task: "Late", phase: "queued", startedAt: 0});
 await assertTerminal(queued, "cancelled");
 gate.resolve();
 await assertTerminal(active, "cancelled");
 await shutdown;
 await assertTerminal(pi.tool.execute("dispose-late", {role: "coder", profile: "typescript", task: "Late"}, undefined, undefined, context()), "cancelled");
 assert.equal(calls, 1);
 assert.equal(notifications, changes);
 assert.equal(store.list().active.length + store.list().recent.length, 0);
});

const inlineTheme = {
 fg: (_: string, text: string) => text,
 inverse: (text: string) => `\x1b[7m${text}\x1b[27m`,
};

// Inline dashboard contract: no custom screen and no editor replacement.
it("focuses and expands the stable inline widget while busy, preserving draft and releasing capture", async () => {
 const pi = fakePi(); const store = new LiveTranscriptStore(); const gate = deferred<void>();
 registerGuild(pi.api as any, {createTranscriptStore: () => store, run: async options => {await gate.promise; return resultFor(options);}});
 const commands = [...pi.commands.keys()]; let panel: any; let factories = 0; let capture: any; let listeners = 0;
 const ctx = context({isIdle: () => false, waitForIdle: () => {throw new Error("must not wait");}});
 ctx.ui.custom = (() => {throw new Error("no dashboard modal");}) as any;
 let draft = "draft 中文";
 (ctx.ui as any).getEditorText = () => draft;
 (ctx.ui as any).setEditorText = () => {throw new Error("must not replace draft");};
 (ctx.ui as any).setEditorComponent = () => {throw new Error("must not replace editor");};
 (ctx.ui as any).onTerminalInput = (listener: any) => {capture = listener; listeners++; return () => {capture = undefined; listeners--;};};
 ctx.ui.setWidget = ((_key: string, value: any) => {
  if (typeof value === "function") {factories++; panel = value({requestRender() {}, terminal: {rows: 24}, hasOverlay: () => false, getFocusedComponent: () => ({getText: () => (ctx.ui as any).getEditorText(), onAction() {}, onExtensionShortcut() {}})}, inlineTheme);}
  else if (!value) panel = undefined;
 }) as any;
 const child = pi.tool.execute("inline-busy", {role: "coder", profile: "typescript", task: "Busy task"}, undefined, undefined, ctx);
 assert.equal(pi.shortcuts.has("f6"), false);
 assert.equal(pi.shortcuts.has("alt+i"), false); assert.equal(listeners, 1);
 assert.match(panel.render(80).join("\n"), /↑ select/);
 assert.equal(capture("\x1b[A"), undefined); draft = "";
 assert.deepEqual(capture("\x1b[A"), {consume: true}); assert.equal(listeners, 1);
 assert.deepEqual(capture("\r"), {consume: true}); assert.match(panel.render(80).join("\n"), /Task · Busy task/);
 await new Promise(resolve => setTimeout(resolve, 1100)); assert.equal(factories, 1);
 assert.deepEqual(capture("\x1b"), {consume: true}); assert.doesNotMatch(panel.render(80).join("\n"), /Task · Busy task/);
 const oldCapture = capture; assert.equal(capture("x"), undefined); assert.equal(listeners, 1); assert.equal(oldCapture("\r"), undefined);
 assert.equal((ctx.ui as any).getEditorText(), ""); assert.deepEqual([...pi.commands.keys()], commands);
 capture("\x1b[A"); capture("\r"); gate.resolve(); await child;
 assert.equal(panel, undefined); assert.equal(listeners, 0);
 assert.equal(oldCapture("\x1b"), undefined);
 await pi.handlers.get("session_shutdown")({}, ctx);
});
it("leaves overlays and custom dialog owners alone, including transitions from panel navigation", async () => {
 const pi = fakePi(); const gate = deferred<void>();
 registerGuild(pi.api as any, {run: async options => {await gate.promise; return resultFor(options);}});
 const ctx = context(); let capture: any; let overlay = false; let owner: any;
 const editor = {getText: () => "", onAction() {}, onExtensionShortcut: undefined}; owner = editor;
 (ctx.ui as any).getEditorText = () => "";
 (ctx.ui as any).onTerminalInput = (handler: any) => {capture = handler; return () => {};};
 ctx.ui.setWidget = ((_key: string, value: any) => {if (typeof value === "function") value({requestRender() {}, terminal: {rows: 24}, hasOverlay: () => overlay, getFocusedComponent: () => owner}, {fg: (_: string, text: string) => text});}) as any;
 const child = pi.tool.execute("owner-guard", {role: "coder", profile: "typescript", task: "Work"}, undefined, undefined, ctx);
 overlay = true; assert.equal(capture("\x1b[A"), undefined);
 overlay = false; owner = {handleInput() {}}; assert.equal(capture("\x1b[A"), undefined);
 owner = {getText: () => ""}; assert.equal(capture("\x1b[A"), undefined); // dialog input is not main editor
 owner = editor; assert.deepEqual(capture("\x1b[A"), {consume: true});
 owner = {handleInput() {}}; assert.equal(capture("\x1b"), undefined); assert.equal(capture("\x1b[B"), undefined);
 owner = editor; assert.equal(capture("\r"), undefined);
 capture("\x1b[A"); overlay = true; assert.equal(capture("\x1b"), undefined);
 gate.resolve(); await child; await pi.handlers.get("session_shutdown")({}, ctx);
});
it("never captures direct progress input even if a host still reports the editor as focused", async () => {
 const pi = fakePi(); const gate = deferred<void>(); const ready = deferred<void>(); let capture: any; let progress: any;
 const ctx = context(); const theme = {fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text};
 const tui = {requestRender() {}, terminal: {rows: 24}, hasOverlay: () => false,
  getFocusedComponent: () => ({getText: () => "", onAction() {}, onExtensionShortcut() {}})};
 (ctx.ui as any).onTerminalInput = (handler: any) => {capture = handler; return () => {};};
 ctx.ui.setWidget = ((_key: string, value: any) => {if (typeof value === "function") value(tui, theme);}) as any;
 ctx.ui.custom = ((factory: any) => new Promise(resolve => {
  progress = factory(tui, theme, {matches: (data: string) => data === "\x1b"}, resolve); ready.resolve();
 })) as any;
 registerGuild(pi.api as any, {run: async options => {await gate.promise; return resultFor(options);}});
 const child = pi.tool.execute("direct-guard", {role: "coder", profile: "typescript", task: "Work"}, undefined, undefined, ctx);
 capture("\x1b[A");
 const direct = pi.commands.get("guild-handover").handler("explorer/typescript Direct", ctx); await ready.promise;
 try {
  assert.equal(capture("\x1b[A"), undefined); assert.equal(capture("\x1b"), undefined);
  assert.equal(progress.signal.aborted, false); progress.handleInput("\x1b"); assert.equal(progress.signal.aborted, true);
 } finally {
  progress.handleInput("\x1b"); gate.resolve(); await child; await direct; await pi.handlers.get("session_shutdown")({}, ctx);
 }
});
it("cleans compact final runs and closes inline capture before shutdown; late callbacks are inert", async () => {
 const pi = fakePi(); const store = new LiveTranscriptStore(); const gate = deferred<void>();
 registerGuild(pi.api as any, {createTranscriptStore: () => store, run: async options => {await gate.promise; return resultFor(options);}});
 let panel: any; let capture: any; let off = 0;
 const ctx = context();
 (ctx.ui as any).onTerminalInput = (listener: any) => {capture = listener; return () => {off++;};};
 ctx.ui.setWidget = ((_key: string, value: any) => {panel = typeof value === "function" ? value({requestRender() {}, terminal: {rows: 24}, hasOverlay: () => false, getFocusedComponent: () => ({getText: () => (ctx.ui as any).getEditorText(), onAction() {}, onExtensionShortcut() {}})}, {fg: (_: string, text: string) => text}) : value;}) as any;
 assert.equal(pi.shortcuts.has("alt+i"), false); assert.equal(capture, undefined);
 (ctx.ui as any).getEditorText = () => "";
 const child = pi.tool.execute("inline-shutdown", {role: "coder", profile: "typescript", task: "Work"}, undefined, undefined, ctx);
 (capture as any)("\x1b[A"); const oldPanel = panel;
 const shutdown = pi.handlers.get("session_shutdown")({}, ctx);
 assert.equal(off, 1); assert.equal((capture as any)("\r"), undefined); assert.deepEqual(oldPanel.render(80), []); assert.equal(panel, undefined);
 gate.resolve(); await child; await shutdown;
 assert.equal(store.list().active.length + store.list().recent.length, 0);
 const other = fakePi(); registerGuild(other.api as any, {run: successfulRunner});
 await other.tool.execute("compact-final", {role: "coder", profile: "typescript", task: "Work"}, undefined, undefined, ctx);
 assert.equal(panel, undefined);
});
it("disposes observers on rebuild and makes cleared widget factories inert", async () => {
 const pi = fakePi(); const gate = deferred<void>(); let factory: any; let capture: any; let listeners = 0;
 const ctx = context(); const tui = {requestRender() {}, terminal: {rows: 24}, hasOverlay: () => false,
  getFocusedComponent: () => ({getText: () => "", onAction() {}, onExtensionShortcut() {}})};
 const theme = {fg: (_: string, text: string) => text};
 (ctx.ui as any).onTerminalInput = (handler: any) => {capture = handler; listeners++; return () => {listeners--;};};
 ctx.ui.setWidget = ((_key: string, value: any) => {if (typeof value === "function") {factory = value; value(tui, theme);}}) as any;
 registerGuild(pi.api as any, {run: async options => {await gate.promise; return resultFor(options);}});
 const child = pi.tool.execute("rebuild", {role: "coder", profile: "typescript", task: "Work"}, undefined, undefined, ctx);
 const staleCapture = capture; const oldPanel = factory(tui, theme);
 assert.equal(listeners, 1); assert.equal(staleCapture("\x1b[A"), undefined);
 gate.resolve(); await child; assert.equal(listeners, 0);
 const late = factory(tui, theme); assert.deepEqual(late.render(80), []); assert.equal(listeners, 0);
 await pi.handlers.get("session_shutdown")({}, ctx);
 assert.deepEqual(factory(tui, theme).render(80), []); assert.deepEqual(oldPanel.render(80), []);
});
it("fullscreen rows expand exact IDs beneath the panel with detail-aware click coordinates", async () => {
 const pi = fakePi(); const store = new LiveTranscriptStore(); const gate = deferred<void>(); const secondGate = deferred<void>();
 registerGuild(pi.api as any, {createTranscriptStore: () => store, run: async options => {await (options.runId === "row-first" ? gate.promise : secondGate.promise); return resultFor(options);}});
 let panel: any; let factories = 0;
 const ctx = context();
 (ctx.ui as any).onTerminalInput = () => () => {};
 ctx.ui.setWidget = ((_key: string, value: any) => {if (typeof value === "function") {factories++; panel = value({requestRender() {}, terminal: {rows: 35}}, inlineTheme);} else if (!value) panel = undefined;}) as any;
 ctx.ui.custom = (() => {throw new Error("no modal");}) as any;
 const first = pi.tool.execute("row-first", {role: "coder", profile: "typescript", task: "First"}, undefined, undefined, ctx);
 const second = pi.tool.execute("row-second", {role: "coder", profile: "typescript", task: "Second"}, undefined, undefined, ctx);
 let lines = panel.render(100); let row = lines.findIndex((line: string) => /running.*First/.test(line));
 assert.deepEqual(panel.handleMouse({type: "click", button: "left", y: row}), {handled: true, render: false});
 lines = panel.render(100); assert.match(lines.join("\n"), /Task · First/);
 row = lines.findIndex((line: string) => /queued.*Second/.test(line));
 assert.ok(row > 3); panel.handleMouse({type: "click", button: "left", y: row});
 assert.match(panel.render(100).join("\n"), /Task · Second/);
 gate.resolve(); await first; assert.equal(factories, 1); assert.match(panel.render(100).join("\n"), /Task · Second/);
 secondGate.resolve(); await second; assert.equal(panel, undefined);
 await pi.handlers.get("session_shutdown")({}, ctx);
});

for (const terminal of ["completed", "failed", "cancelled", "shutdown", "disposed"] as const) it(`direct detail settles ${terminal} with correct run events and releases listeners`, async () => {
 const pi = fakePi(); const store = new LiveTranscriptStore(); const gate = deferred<void>(); const ready = deferred<void>();
 let listeners = 0; const subscribe = store.subscribe.bind(store);
 store.subscribe = listener => {listeners++; const off = subscribe(listener); let disposed = false; return () => {if (!disposed) {disposed = true; listeners--; off();}};};
 let child: RunGuildRoleOptions | undefined; let progress: any; let doneCalls = 0;
 registerGuild(pi.api as any, {createTranscriptStore: () => store, run: async options => {
  child = options;
  options.onEvent?.({type: "message_end", message: {role: "assistant", content: [{type: "text", text: "Own emitted transcript"}]}});
  ready.resolve(); await gate.promise;
  if (terminal === "failed") throw new Error("Detail failure");
  return resultFor(options);
 }});
 store.start({id: "other", role: "coder", profile: "typescript", task: "Other task", phase: "running", startedAt: 0});
 store.ingest("other", {type: "message_end", message: {role: "assistant", content: [{type: "text", text: "Wrong transcript"}]}});
 const ctx = context(); ctx.ui.custom = ((factory: any) => new Promise(resolve => {
  progress = factory({requestRender() {}, terminal: {rows: 20}}, {fg: (_: string, text: string) => text, bg: (_: string, text: string) => text}, {matches: (data: string, binding: string) => data === binding}, (value: any) => {doneCalls++; resolve(value);});
 })) as any;
 const command = pi.commands.get("guild-handover").handler("coder/typescript Own task", ctx);
 await ready.promise;
 for (let i = 0; i < 2; i++) {
  progress.handleInput("\x1b[17~"); assert.match(progress.render(100).join("\n"), /Own emitted transcript/);
  assert.doesNotMatch(progress.render(100).join("\n"), /Wrong transcript/);
  progress.handleInput("\x1b[A"); progress.handleInput("tui.select.cancel");
  assert.equal(child?.signal?.aborted, false); assert.equal(listeners, 0);
 }
 progress.handleInput("\r"); assert.equal(listeners, 1);
 assert.match(progress.render(100).at(-1), /Esc back · F6 back/);
 let shutdown: Promise<void> | undefined;
 if (terminal === "shutdown") {shutdown = pi.handlers.get("session_shutdown")({}, ctx); assert.equal(listeners, 0);}
 if (terminal === "disposed") {progress.dispose(); assert.equal(listeners, 0); assert.equal(child?.signal?.aborted, false);}
 if (terminal === "cancelled") {
  progress.handleInput("tui.select.cancel"); assert.equal(child?.signal?.aborted, false);
  progress.handleInput("tui.select.cancel"); assert.equal(child?.signal?.aborted, true);
  // A cancelling card must not reopen inspection.
  progress.handleInput("\r"); assert.equal(listeners, 0);
 }
 gate.resolve(); await command; await shutdown;
 assert.equal(doneCalls, terminal === "disposed" ? 0 : 1); assert.equal(listeners, 0);
 const status = terminal === "shutdown" ? "cancelled" : terminal === "disposed" ? "completed" : terminal;
 assert.deepEqual(pi.messages.map(({message}) => message.details.status), terminal === "shutdown" || terminal === "disposed" ? ["started"] : ["started", status]);
 if (terminal !== "shutdown" && terminal !== "disposed") assert.equal(pi.messages[0].message.details.runId, pi.messages[1].message.details.runId);
 progress.dispose();
});

// Final-run behavior list: every terminal outcome, focus/draft changes, stale
// input/render/factory callbacks, ticker removal and repeated shutdown.
for (const terminal of ["completed", "failed", "cancelled", "queued-cancelled"] as const) {
 for (const ownership of ["editor", "draft", "dialog"] as const) it(`auto-clears expanded final ${terminal} with ${ownership} ownership`, async () => {
  const pi = fakePi(); const store = new LiveTranscriptStore(); const gate = deferred<void>(); const ready = deferred<void>();
  let calls = 0;
  registerGuild(pi.api as any, {createTranscriptStore: () => store, run: async options => {
   calls++; ready.resolve(); await gate.promise;
   if (terminal === "failed") throw new Error("terminal fixture failure");
   return resultFor(options);
  }});
  const ctx = context(); let panel: any; let factory: any; let capture: any; let listeners = 0; let subscriptions = 0;
  let draft = ""; let editorOwns = true; let status: string | undefined; let clears = 0;
  const subscribe = store.subscribe.bind(store);
  store.subscribe = listener => {subscriptions++; const off = subscribe(listener); return () => {subscriptions--; off();};};
  const editor = {getText: () => draft, onAction() {}, onExtensionShortcut() {}};
  const tui = {requestRender() {}, terminal: {rows: 40}, hasOverlay: () => false, getFocusedComponent: () => editorOwns ? editor : {handleInput() {}}};
  const theme = {fg: (_: string, text: string) => text};
  (ctx.ui as any).getEditorText = () => draft;
  (ctx.ui as any).onTerminalInput = (handler: any) => {capture = handler; listeners++; return () => {listeners--;};};
  ctx.ui.setWidget = ((_key: string, value: any) => {if (typeof value === "function") {factory = value; panel = value(tui, theme);} else {panel = value; clears++;}}) as any;
  ctx.ui.setStatus = ((_key: string, value: string | undefined) => {status = value;}) as any;
  const controller = new AbortController();
  // Cancel queued work reentrantly before RunQueue can launch a child.
  const child = pi.tool.execute(`final-${terminal}-${ownership}`, {role: "coder", profile: "typescript", task: "Final task"}, controller.signal, (update: any) => {
   if (terminal === "queued-cancelled" && update.details.phase === "queued") {
    capture("\x1b[A"); capture("\x1b[C"); controller.abort();
   }
  }, ctx);
  if (terminal !== "queued-cancelled") {
   await ready.promise; capture("\x1b[A"); capture("\x1b[C");
  }
  const stalePanel = panel; const staleCapture = capture; const staleFactory = factory;
  assert.equal(subscriptions, 1);
  if (ownership === "draft") draft = "nonempty 中文";
  if (ownership === "dialog") editorOwns = false;
  if (terminal === "cancelled") controller.abort();
  gate.resolve(); const result = await child;
  assert.equal(result.details.status, terminal === "queued-cancelled" ? "cancelled" : terminal);
  assert.equal(calls, terminal === "queued-cancelled" ? 0 : 1);
  assert.equal(panel, undefined); assert.equal(status, undefined); assert.equal(listeners, 0); assert.equal(subscriptions, 0);
  assert.deepEqual(stalePanel.render(100), []);
  for (const key of ["\x1b", "\x1b[D", "\x1b[A", "x"]) assert.equal(staleCapture(key), undefined);
  assert.deepEqual(staleFactory(tui, theme).render(100), []); assert.equal(listeners, 0);
  const before = clears; await new Promise(resolve => setTimeout(resolve, 1050)); assert.equal(clears, before, "no orphan ticker");
  await pi.handlers.get("session_shutdown")({}, ctx); await pi.handlers.get("session_shutdown")({}, ctx);
  assert.equal(listeners, 0); assert.equal(staleCapture("\x1b"), undefined);
 });
}

for (const terminal of ["completed", "failed", "cancelled", "queued-cancelled"] as const) it(`removes expanded ${terminal} while another queued/run survives; close across queue switch`, async () => {
 const pi = fakePi(); const store = new LiveTranscriptStore(); const firstGate = deferred<void>(); const secondGate = deferred<void>(); const ready = deferred<void>();
 const controller = new AbortController();
 registerGuild(pi.api as any, {createTranscriptStore: () => store, run: async options => {
  await (options.runId === "queue-first" ? firstGate.promise : secondGate.promise);
  if (terminal === "failed" && options.runId === "queue-first") throw new Error("selected failed");
  return resultFor(options);
 }});
 const ctx = context(); let panel: any; let capture: any; let subscriptions = 0; let listeners = 0;
 const subscribe = store.subscribe.bind(store);
 store.subscribe = listener => {subscriptions++; const off = subscribe(listener); return () => {subscriptions--; off();};};
 (ctx.ui as any).getEditorText = () => "";
 (ctx.ui as any).onTerminalInput = (handler: any) => {capture = handler; listeners++; return () => {listeners--;};};
 ctx.ui.setWidget = ((_key: string, value: any) => {panel = typeof value === "function" ? value({requestRender() {}, terminal: {rows: 48}, hasOverlay: () => false,
  getFocusedComponent: () => ({getText: () => "", onAction() {}, onExtensionShortcut() {}})}, inlineTheme) : value;}) as any;
 const first = pi.tool.execute("queue-first", {role: "coder", profile: "typescript", task: "First"}, terminal === "cancelled" ? controller.signal : undefined, (update: any) => {if (update.details.phase === "running") ready.resolve();}, ctx);
 await ready.promise;
 const second = pi.tool.execute("queue-second", {role: "coder", profile: "typescript", task: "Second"}, terminal === "queued-cancelled" ? controller.signal : undefined, undefined, ctx);
 capture("\x1b[A"); if (terminal !== "queued-cancelled") capture("\x1b[A"); capture("\x1b[C");
 assert.equal(subscriptions, 1);
 if (terminal === "cancelled" || terminal === "queued-cancelled") controller.abort();
 if (terminal === "queued-cancelled") await second;
 else {firstGate.resolve(); await first;}
 assert.equal(subscriptions, 0); assert.equal(listeners, 1);
 const removed = terminal === "queued-cancelled" ? "Second" : "First";
 const survivor = terminal === "queued-cancelled" ? "First" : "Second";
 const output = panel.render(100).join("\n"); assert.doesNotMatch(output, new RegExp(removed + "|Task ·|Session")); assert.match(output, new RegExp(survivor));
 // Closing selected compact navigation during a queue phase transition is harmless.
 assert.deepEqual(capture("\x1b"), {consume: true}); assert.equal(capture("\x1b"), undefined);
 assert.equal(controller.signal.aborted, terminal === "cancelled" || terminal === "queued-cancelled");
 firstGate.resolve(); secondGate.resolve(); await first; await second;
 assert.equal(panel, undefined); assert.equal(listeners, 0); assert.equal(subscriptions, 0); assert.equal(capture("\x1b"), undefined);
 await pi.handlers.get("session_shutdown")({}, ctx);
});

it("owns a runtime for one registration and rejects transfer to a second registration", async (t) => {
 const fixture = runtimeFixture(() => assert.fail("unexpected background start"));
 const pi = fakePi(); const ctx = context();
 let factories = 0;
 const dependencies = {
  createExecutionRuntime: () => { factories++; return fixture.runtime; },
  run: async (options: RunGuildRoleOptions) => resultFor(options),
 };
 registerGuild(pi.api as never, dependencies);
 t.after(() => pi.handlers.get("session_shutdown")({}, ctx));
 assert.throws(() => registerGuild(fakePi().api as never, dependencies), /active|activation/i);
 await pi.handlers.get("session_start")({}, ctx);
 await pi.handlers.get("session_start")({}, ctx);
 assert.equal(factories, 2, "one explicit activation per registration, no session-start rotation");
 const result = await pi.tool.execute("registered", {role: "explorer", profile: "general", task: "Inspect"}, undefined, undefined, ctx);
 assert.equal(result.details.status, "completed", "rejected transfer must not close the first owner");
});

it("keeps both blocking entry paths independent of the captured background Plan setting", async () => {
 const previous = process.env.PITHOS_GUILD_PLAN_MODE;
 try {
  for (const mode of [undefined, "required", "standalone", "invalid"]) {
   if (mode === undefined) delete process.env.PITHOS_GUILD_PLAN_MODE;
   else process.env.PITHOS_GUILD_PLAN_MODE = mode;
   const pi = fakePi(); const ctx = context(); const calls: string[] = [];
   registerGuild(pi.api as never, { run: async options => { calls.push(options.task); return resultFor(options); } });
   try {
    const tool = await pi.tool.execute("background-policy-compat", { role: "coder", profile: "general", task: "tool" }, undefined, undefined, ctx);
    await pi.commands.get("guild-handover").handler("reviewer/general direct", ctx);
    assert.equal(tool.details.status, "completed", String(mode));
    assert.deepEqual(calls, ["tool", "direct"], String(mode));
   } finally { await pi.handlers.get("session_shutdown")({}, ctx); }
  }
 } finally {
  if (previous === undefined) delete process.env.PITHOS_GUILD_PLAN_MODE;
  else process.env.PITHOS_GUILD_PLAN_MODE = previous;
 }
});

it("registration captures a lazy receiver-preserving bus and immutable parent-only policy", async () => {
 const previous = process.env.PITHOS_GUILD_PLAN_MODE;
 try {
  for (const mode of [undefined, "standalone", "invalid"]) {
   if (mode === undefined) delete process.env.PITHOS_GUILD_PLAN_MODE;
   else process.env.PITHOS_GUILD_PLAN_MODE = mode;
   const pi = fakePi(); const ctx = context();
   let captured!: Parameters<NonNullable<GuildDependencies["createExecutionRuntime"]>>[0];
   let runtime!: GuildExecutionRuntime; let owner!: GuildOwner;
   let emissions = 0; let launches = 0; let factories = 0; let activations = 0;
   const events = pi.api.events;
   const emit = events.emit;
   events.emit = function(channel, request) {
    assert.equal(this, events); emissions++;
    return emit.call(this, channel, request);
   };
   registerGuild(pi.api as never, {
    createExecutionRuntime(options) {
     factories++; captured = options;
     const actual = createGuildBackgroundRuntime({ ...options, runner: async options => { launches++; return backgroundResult(options); } });
     runtime = { ...actual, activate() { activations++; owner = actual.activate(); return owner; } };
     return runtime;
    }, run: successfulRunner,
   });
   try {
    assert.equal(factories, 1); assert.equal(activations, 1);
    assert.deepEqual(captured.parentEnvironment, { PITHOS_GUILD_PLAN_MODE: mode });
    assert.equal(Object.isFrozen(captured.parentEnvironment), true);
    process.env.PITHOS_GUILD_PLAN_MODE = mode === "standalone" ? "required" : "standalone";
    pi.api.events = new EventEmitter();
    assert.equal(emissions, 0); assert.equal(launches, 0);
    assert.deepEqual([...pi.tools.keys()].sort(), ["create_commit", "guild_handover"]);
    assert.deepEqual([...pi.commands.keys()].sort(), ["commit", "guild", "guild-handover"]);
    assert.equal((await pi.tool.execute("lazy", { role: "explorer", profile: "general", task: "tool" }, undefined, undefined, ctx)).details.status, "completed");
    await pi.commands.get("guild-handover").handler("reviewer/general direct", ctx);
    assert.ok(emissions > 0, "blocking work discovers on the captured bus"); assert.equal(launches, 0);
    const blockingEmissions = emissions;
    const input = { role: "reviewer", profile: "general", task: "background" };
    if (mode === "standalone") {
     const run = runtime.start(owner, input, backgroundContext());
     await runtime.wait(owner, run.id, 1000);
     assert.equal(runtime.status(owner, run.id).status, "completed");
     assert.equal(launches, 1);
     // An on-stack reply conflicts with explicit standalone even on the captured bus.
     events.on("pithos.plan.coordination", request => request.reply({}));
     assert.throws(() => runtime.start(owner, input, backgroundContext()), /standalone|provider|Plan/i);
     assert.equal(launches, 1);
    } else {
     assert.throws(() => runtime.start(owner, input, backgroundContext()), /Plan|configuration|mode|provider/i);
     assert.equal(launches, 0);
     assert.equal(emissions - blockingEmissions, mode === undefined ? 1 : 0);
    }
    const beforeShutdown = emissions;
    await pi.handlers.get("session_shutdown")({}, ctx);
    assert.equal(emissions, beforeShutdown);
   } finally { await pi.handlers.get("session_shutdown")({}, ctx); }
  }
 } finally {
  if (previous === undefined) delete process.env.PITHOS_GUILD_PLAN_MODE;
  else process.env.PITHOS_GUILD_PLAN_MODE = previous;
 }
});

it("registration shutdown aborts background immediately and joins cleanup without queued launch", async () => {
 const cleanup = deferred<void>(); const signals: AbortSignal[] = [];
 const fixture = runtimeFixture(async options => {
  signals.push(options.signal!);
  await cleanup.promise;
  return backgroundResult(options);
 });
 const pi = fakePi(); const ctx = context();
 registerGuild(pi.api as never, { createExecutionRuntime: () => fixture.runtime, run: successfulRunner });
 const input = { role: "coder", profile: "general", task: "background" };
 for (let index = 0; index < 4; index++) fixture.runtime.start(fixture.owner, input, backgroundContext());
 assert.equal(signals.length, 3);
 let joined = false;
 const shutdown = pi.handlers.get("session_shutdown")({}, ctx).then(() => { joined = true; });
 try {
  assert.ok(signals.every(signal => signal.aborted));
  await Promise.resolve(); assert.equal(joined, false);
  assert.throws(() => fixture.runtime.start(fixture.owner, input, backgroundContext()), /stale|owner/i);
  await assert.rejects(fixture.runtime.runExclusive(fixture.owner, () => assert.fail("closed operation")), /stale|owner/i);
 } finally { cleanup.resolve(); await shutdown; await fixture.runtime.shutdown(); }
 assert.equal(signals.length, 3);
});

// Registration lifetime: saved callbacks, capture/bind reentry, cleanup failure,
// terminal session_start and execution-tail joining (custom/preparation are separate).
it("terminal execution ignores saved runner callbacks before inspecting their arguments", async () => {
 const pi = fakePi(); const ctx = context(); let saved!: RunGuildRoleOptions; let updates = 0;
 registerGuild(pi.api as never, {run: async options => { saved = options; return resultFor(options); }});
 await pi.tool.execute("terminal", {role: "coder", profile: "general", task: "Work"}, undefined, () => updates++, ctx);
 const count = updates;
 const poison = new Proxy({}, {get() { throw new Error("late argument read"); }});
 assert.doesNotThrow(() => saved.onUpdate?.(poison as never));
 assert.doesNotThrow(() => saved.onEvent?.(poison as never));
 assert.equal(updates, count);
 await pi.handlers.get("session_shutdown")({}, ctx);
});

for (const mode of ["capture", "bind", "unbind", "ui"] as const) it(`terminal shutdown owns ${mode} cleanup and never revives`, async () => {
 const pi = fakePi(); const ctx = context({sessionManager: {getBranch: () => [], getSessionDir: () => "/sessions", getSessionId: () => "one"}});
 const gate = deferred<void>(); const entered = deferred<void>();
 let saved: RunGuildRoleOptions | undefined; let binds = 0; let unbinds = 0; let creates = 0; let runs = 0; let joined = false;
 let shutdown: Promise<void> | undefined; let reentrant: Promise<void> | undefined;
 const stop = () => pi.handlers.get("session_shutdown")({}, ctx) as Promise<void>;
 const deps: GuildDependencies = {
  createTraceRecorder: () => { creates++; return {bind() { binds++; if (mode === "bind") shutdown = stop(); return () => { unbinds++; if (mode === "unbind") throw new Error("unbind failed"); }; }, dispose() { reentrant = stop(); }}; },
  captureRepoState: async () => { if (mode === "capture") { entered.resolve(); await gate.promise; } return {state: "x", head: "a", dirty: false, complete: true}; },
  run: async options => { runs++; saved = options; entered.resolve(); await gate.promise; return resultFor(options); },
 };
 registerGuild(pi.api as never, deps);
 await pi.handlers.get("session_start")({}, ctx);
 const execution = pi.tool.execute("owned", {role: "coder", profile: "general", task: "Work"}, undefined, undefined, ctx);
 const outcome = Promise.allSettled([execution]);
 if (mode === "bind") { await new Promise(resolve => setImmediate(resolve)); }
 else await entered.promise;
 if (mode === "ui") ctx.ui.setWidget = () => { throw new Error("UI cleanup failed"); };
 shutdown ??= stop();
 const joinOutcome = shutdown.then(() => { joined = true; }, error => { joined = true; return error; });
 if (saved) assert.equal(saved.signal?.aborted, true);
 if (mode !== "bind") { await Promise.resolve(); assert.equal(joined, false); }
 const poison = new Proxy({}, {get() { throw new Error("stale context read"); }});
 const late = await pi.tool.execute("late", {role: "coder", profile: "general", task: "Work"}, undefined, undefined, poison);
 assert.equal(late.details.status, "cancelled");
 if (saved) { assert.doesNotThrow(() => saved!.onUpdate?.(poison as never)); assert.doesNotThrow(() => saved!.onEvent?.(poison as never)); }
 gate.resolve(); await outcome; const error = await joinOutcome;
 assert.equal(reentrant, shutdown, "reentrant shutdown returns the installed join after drain");
 if (mode === "ui" || mode === "unbind") assert.ok(error instanceof Error);
 assert.equal(runs, mode === "capture" || mode === "bind" ? 0 : 1);
 assert.equal(binds, mode === "capture" ? 0 : 1); assert.equal(unbinds, binds);
 await pi.handlers.get("session_start")({}, poison); assert.equal(creates, 1);
 const replacement = fakePi(); registerGuild(replacement.api as never, deps);
 await replacement.handlers.get("session_start")({}, ctx); assert.equal(creates, 2);
});

it("captures metadata before reentrant transcript publication closes the registration", async () => {
 const pi = fakePi(); const ctx = context(); let closed = false; let shutdown!: Promise<void>; let readsAfterClose = 0;
 const session = {getBranch: () => [], getSessionId: () => "one", getSessionDir: () => "/sessions"};
 Object.defineProperty(ctx, "sessionManager", {get() { if (closed) readsAfterClose++; return session; }});
 class ClosingStore extends LiveTranscriptStore {
  override start(input: Parameters<LiveTranscriptStore["start"]>[0]) {
   super.start(input); shutdown = pi.handlers.get("session_shutdown")({}, context()); closed = true;
  }
 }
 registerGuild(pi.api as never, {createTranscriptStore: () => new ClosingStore(), run: async () => assert.fail("closed publication cannot launch")});
 const result = await pi.tool.execute("reenter-store", {role: "coder", profile: "general", task: "Work"}, undefined, undefined, ctx);
 await shutdown;
 assert.equal(result.details.status, "cancelled"); assert.equal(readsAfterClose, 0);
});

it("does not clear replacement visibility after reentrant terminal widget cleanup", async () => {
 const pi = fakePi(); const ctx = context(); let armed = false; let replaced = false; let lateWrites = 0; let shutdown!: Promise<void>;
 ctx.ui.setWidget = ((_key: string, value: unknown) => {
  if (armed && value === undefined && !replaced) { armed = false; shutdown = pi.handlers.get("session_shutdown")({}, ctx); replaced = true; }
 }) as never;
 ctx.ui.setStatus = (() => { if (replaced) lateWrites++; }) as never;
 registerGuild(pi.api as never, {run: async options => { armed = true; return resultFor(options); }});
 await pi.tool.execute("replacement", {role: "coder", profile: "general", task: "Work"}, undefined, undefined, ctx);
 await shutdown; assert.equal(lateWrites, 0);
});

for (const stage of ["idle", "role", "profile", "practice", "editor"] as const) {
 for (const reject of [false, true]) it(`direct preparation fences ${stage} late ${reject ? "rejection" : "success"}`, async () => {
  const pi = fakePi(); const gate = deferred<any>(); const ready = deferred<void>();
  const ctx = context(); let stale = false; let effects = 0; let choice: any;
  const check = () => { if (stale) effects++; };
  ctx.waitForIdle = async () => { check(); if (stage === "idle") {ready.resolve(); await gate.promise;} };
  ctx.ui.select = (async (title: string, choices: string[]) => {
   check(); const here = title.includes("role") ? "role" : title.includes("profile") ? "profile" : "practice";
   const value = here === "role" ? choices.find(value => value.startsWith("coder "))! : choices[0];
   if (stage === here) {choice = value; ready.resolve(); return gate.promise;}
   return value;
  }) as any;
  ctx.ui.editor = async () => { check(); ready.resolve(); return gate.promise; };
  ctx.ui.notify = (() => {check();}) as any;
  Object.defineProperty(ctx, "model", {get() {check(); return undefined;}});
  Object.defineProperty(ctx, "sessionManager", {get() {check(); return {getBranch: () => {check(); return [];}};}});
  ctx.ui.custom = (() => {check(); throw new Error("must not launch custom");}) as any;
  registerGuild(pi.api as never, {run: async () => assert.fail("must not launch")});
  const command = pi.commands.get("guild-handover").handler("", ctx);
  const settled = Promise.allSettled([command]);
  await ready.promise; await pi.handlers.get("session_shutdown")({}, context()); stale = true;
  if (reject) gate.reject(new Error("native preparation rejected")); else gate.resolve(stage === "editor" ? "Work" : choice);
  assert.equal((await settled)[0].status, "fulfilled");
  assert.equal(effects, 0); assert.deepEqual(pi.messages, []);
  await pi.commands.get("guild-handover").handler("--help", new Proxy({}, {get() {assert.fail("terminal entry read");}}));
 });
}

for (const boundary of ["sessionManager", "hasUI", "mode", "ui", "getBranch", "isProjectTrusted", "model", "thinkingLevel", "started"] as const) it(`direct preparation stops reentrant ${boundary}`, async () => {
 const pi = fakePi(); const ctx = context(); let shutdown: Promise<void> | undefined; let closed = false; let late = 0; let armed = false;
 const stop = () => {shutdown = pi.handlers.get("session_shutdown")({}, context()); closed = true;};
 for (const key of ["sessionManager", "hasUI", "mode", "ui", "model", "thinkingLevel"] as const) {
  const value = ctx[key]; Object.defineProperty(ctx, key, {get() {if (closed) late++; if (armed && boundary === key && !closed) stop(); return value;}});
 }
 ctx.sessionManager.getBranch = () => {if (boundary === "getBranch") stop(); return [];};
 ctx.isProjectTrusted = () => {if (closed) late++; if (boundary === "isProjectTrusted") stop(); return true;};
 let custom = 0; ctx.ui.custom = (() => {custom++; throw new Error("unexpected custom");}) as any;
 const send = pi.api.sendMessage; pi.api.sendMessage = (message, options) => {send(message, options); if (boundary === "started") stop();};
 registerGuild(pi.api as never, {run: async () => assert.fail("reentrant launch")});
 armed = true;
 await pi.commands.get("guild-handover").handler("coder/general Work", ctx);
 await shutdown; assert.equal(late, 0); assert.equal(custom, 0);
});

for (const ending of ["complete", "shutdown", "reset-resolve", "reset-reject", "native-reject"] as const) it(`direct custom ownership ${ending} protects replacement draft`, async () => {
 const pi = fakePi(); const ctx = context(); const gate = deferred<void>(); const ready = deferred<void>(); const native = deferred<any>();
 let component: any; let draft = "old draft"; let renders = 0; let doneCalls = 0;
 ctx.ui.custom = ((factory: any) => {
  const saved = draft;
  component = factory({requestRender() {renders++;}}, inlineTheme, {matches: () => false}, (value: any) => {
   doneCalls++; draft = saved; renders++; native.resolve(value); component?.dispose();
  });
  return native.promise;
 }) as any;
 registerGuild(pi.api as never, {run: async options => {ready.resolve(); await gate.promise; if (ending === "reset-reject") throw new Error("late runner"); return resultFor(options);}});
 let settled = false;
 const command = pi.commands.get("guild-handover").handler("coder/general Work", ctx).then(() => {settled = true;});
 await ready.promise;
 let shutdown: Promise<void> | undefined;
 if (ending.startsWith("reset") || ending === "native-reject") {
  component.dispose(); draft = "replacement draft";
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, true, "host disposal settles Guild without resolving the native promise");
  shutdown = pi.handlers.get("session_shutdown")({}, ctx);
 } else if (ending === "shutdown") shutdown = pi.handlers.get("session_shutdown")({}, ctx);
 const beforeLate = renders;
 gate.resolve(); await command; await shutdown;
 if (ending === "native-reject") {native.reject(new Error("late native rejection")); await new Promise(resolve => setImmediate(resolve));}
 assert.equal(doneCalls, ending === "complete" || ending === "shutdown" ? 1 : 0);
 if (ending !== "complete") assert.equal(renders, beforeLate);
 assert.equal(draft, ending.startsWith("reset") || ending === "native-reject" ? "replacement draft" : "old draft");
 assert.deepEqual(pi.messages.map(({message}) => message.details.status), ending === "complete" ? ["started", "completed"] : ["started"]);
 await pi.handlers.get("session_shutdown")({}, ctx);
});

it("direct custom native failure remains a live diagnostic", async () => {
 const pi = fakePi(); const ctx = context(); const notices: unknown[] = [];
 ctx.ui.custom = (async () => {throw new Error("native custom failure");}) as any;
 ctx.ui.notify = ((...args: unknown[]) => {notices.push(args);}) as any;
 registerGuild(pi.api as never, {run: successfulRunner});
 await pi.commands.get("guild-handover").handler("coder/general Work", ctx);
 assert.deepEqual(pi.messages.map(({message}) => message.details.status), ["started", "failed"]);
 assert.match(JSON.stringify(notices), /native custom failure/);
 await pi.handlers.get("session_shutdown")({}, ctx);
});

it("direct custom delayed factory cancels locally without native close or launch", async () => {
 const pi = fakePi(); const ctx = context(); const ready = deferred<void>(); const native = deferred<any>(); let factory: any; let done = 0;
 ctx.ui.custom = ((value: any) => {factory = value; ready.resolve(); return native.promise;}) as any;
 registerGuild(pi.api as never, {run: async () => assert.fail("delayed factory launched")});
 let settled = false; const command = pi.commands.get("guild-handover").handler("coder/general Work", ctx).then(() => {settled = true;});
 await ready.promise; await pi.handlers.get("session_shutdown")({}, ctx);
 await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, true);
 const poison = new Proxy({}, {get() {assert.fail("late factory inspected host");}});
 const component = factory(poison, poison, poison, () => {done++;});
 assert.deepEqual(component.render(80), []); component.dispose(); assert.equal(done, 0);
 native.reject(new Error("delayed host rejection")); await command;
});

it("direct custom throwing disposal still closes once and joins runner cleanup", async () => {
 const pi = fakePi(); const ctx = context(); const store = new LiveTranscriptStore(); const ready = deferred<void>(); const gate = deferred<void>();
 const subscribe = store.subscribe.bind(store);
 store.subscribe = listener => {const off = subscribe(listener); return () => {off(); throw new Error("detail disposal failed");};};
 let component: any; let done = 0; let joined = false;
 ctx.ui.custom = ((factory: any) => new Promise(resolve => {
  component = factory({requestRender() {}}, inlineTheme, {matches: () => false}, (value: any) => {done++; resolve(value);});
 })) as any;
 registerGuild(pi.api as never, {createTranscriptStore: () => store, run: async options => {ready.resolve(); await gate.promise; return resultFor(options);}});
 const command = pi.commands.get("guild-handover").handler("coder/general Work", ctx);
 await ready.promise; component.handleInput("\r");
 const shutdown = pi.handlers.get("session_shutdown")({}, ctx).then(() => {joined = true;}, (error: unknown) => {joined = true; return error;});
 assert.equal(done, 1); await Promise.resolve(); assert.equal(joined, false);
 gate.resolve(); assert.ok(await shutdown instanceof AggregateError); await command;
 component.dispose(); assert.equal(done, 1);
 assert.deepEqual(pi.messages.map(({message}) => message.details.status), ["started"]);
});

it("direct custom creation reentry disposes the returned card before host use", async (t) => {
 const pi = fakePi(); const ctx = context(); let shutdown: Promise<void> | undefined; let done = 0; let renders = 0;
 const interval = globalThis.setInterval;
 t.mock.method(globalThis, "setInterval", ((callback: any, delay: number, ...args: any[]) => {
  const timer = interval(callback, delay, ...args);
  if (delay === 80) shutdown = pi.handlers.get("session_shutdown")({}, ctx);
  return timer;
 }) as typeof setInterval);
 ctx.ui.custom = ((factory: any) => new Promise(resolve => {
  const component = factory({requestRender() {renders++;}}, inlineTheme, {matches: () => false}, (value: any) => {done++; resolve(value);});
  component.handleInput("\r");
  component.dispose();
 })) as any;
 registerGuild(pi.api as never, {run: async () => assert.fail("creation reentry launched")});
 await pi.commands.get("guild-handover").handler("coder/general Work", ctx); await shutdown;
 assert.equal(renders, 0, "creation handshake must dispose before returning to host");
 assert.equal(done, 1); assert.deepEqual(pi.messages.map(({message}) => message.details.status), ["started"]);
});

it("direct preparation preserves frozen host objects and method receivers", async () => {
 const pi = fakePi(); const ctx = context();
 ctx.waitForIdle = async function () {assert.equal(this, ctx);};
 ctx.sessionManager.getBranch = function () {assert.equal(this, ctx.sessionManager); return [];};
 ctx.ui.custom = (function (this: unknown, factory: any) {assert.equal(this, ctx.ui); return runCustom(factory);}) as any;
 Object.freeze(ctx.ui); Object.freeze(ctx.sessionManager); Object.freeze(ctx.model); Object.freeze(ctx);
 registerGuild(pi.api as never, {run: successfulRunner});
 await pi.commands.get("guild-handover").handler("coder/general Work", ctx);
 assert.deepEqual(pi.messages.map(({message}) => message.details.status), ["started", "completed"]);
 await pi.handlers.get("session_shutdown")({}, ctx);
});

// Tool admission/capture must stop at the first lifecycle boundary, without
// consulting the retired context or turning cancellation into a failed join.
for (const boundary of ["getBranch", "isProjectTrusted", "cwd", "model", "provider", "id", "thinkingLevel", "sessionManager", "getSessionId", "getSessionDir", "getSessionFile"] as const) it(`tool preparation stops reentrant ${boundary}`, async () => {
 const pi = fakePi(); let closed = false; let late = 0; let captures = 0; let runs = 0;
 let shutdown: Promise<void> | undefined;
 const stop = () => { closed = true; shutdown = pi.handlers.get("session_shutdown")({}, context()); void shutdown?.catch(() => {}); };
 const access = (key: string) => {
  if (closed) { late++; throw new Error(`stale host access: ${key}`); }
  if (key === boundary) stop();
 };
 const sessionManager = {
  getBranch() { access("getBranch"); return []; },
  getSessionId() { access("getSessionId"); return "one"; },
  getSessionDir() { access("getSessionDir"); return "/sessions"; },
  getSessionFile() { access("getSessionFile"); return "/sessions/one.jsonl"; },
 };
 const model = {get provider() { access("provider"); return "openai"; }, get id() { access("id"); return "test"; }};
 const ctx = context({sessionManager, model, isProjectTrusted() { access("isProjectTrusted"); return true; }});
 for (const key of ["cwd", "model", "thinkingLevel", "sessionManager", "hasUI", "ui"] as const) {
  const value = ctx[key]; Object.defineProperty(ctx, key, {get() { access(key); return value; }});
 }
 registerGuild(pi.api as never, {
  captureRepoState: async () => { captures++; return {state: "x", head: "a", dirty: false, complete: true}; },
  run: async options => { runs++; return resultFor(options); },
 });
 await pi.handlers.get("session_start")({}, context());
 const terminal = await pi.tool.execute(`reentry-${boundary}`, {role: "coder", profile: "general", task: "Work"}, undefined, undefined, ctx);
 assert.ok(shutdown, "the selected boundary was reached");
 await shutdown;
 assert.equal(terminal.details.status, "cancelled");
 assert.equal(late, 0); assert.equal(captures, 0); assert.equal(runs, 0);
 const poison = new Proxy({}, {get() { assert.fail("stale tool context read"); }});
 const stale = await pi.tool.execute("stale", {role: "coder", profile: "general", task: "Work"}, undefined, undefined, poison);
 assert.equal(stale.details.status, "cancelled");
});

it("tool preparation preserves frozen host objects and method receivers", async () => {
 const pi = fakePi(); const ctx = context();
 ctx.sessionManager.getBranch = function () { assert.equal(this, ctx.sessionManager); return []; };
 ctx.isProjectTrusted = function () { assert.equal(this, ctx); return true; };
 Object.freeze(ctx.ui); Object.freeze(ctx.sessionManager); Object.freeze(ctx.model); Object.freeze(ctx);
 registerGuild(pi.api as never, {run: successfulRunner});
 const terminal = await pi.tool.execute("frozen", {role: "coder", profile: "general", task: "Work"}, undefined, undefined, ctx);
 assert.equal(terminal.details.status, "completed");
 await pi.handlers.get("session_shutdown")({}, ctx);
});

for (const boundary of ["mode", "ui", "timer-hasUI"] as const) it(`visibility stops reentrant ${boundary}`, async () => {
 const pi = fakePi(); const ctx = context(); let closed = false; let stopping = false; let late = 0; let reads = 0; let timers = 0;
 let shutdown: Promise<void> | undefined;
 const original = globalThis.setInterval;
 globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => { timers++; return original(...args); }) as typeof setInterval;
 const stop = () => { stopping = true; shutdown = pi.handlers.get("session_shutdown")({}, ctx); closed = true; stopping = false; };
 const key = boundary === "timer-hasUI" ? "hasUI" : boundary;
 const ui = ctx.ui;
 for (const property of ["mode", "ui", "hasUI"] as const) {
  const value = ctx[property];
  Object.defineProperty(ctx, property, {get() {
   if (closed) { late++; throw new Error(`retired visibility getter: ${property}`); }
   if (!stopping && property === key && (++reads === (boundary === "timer-hasUI" ? 2 : 1))) stop();
   return value;
  }});
 }
 ui.setWidget = () => { if (closed) late++; };
 ui.setStatus = () => { if (closed) late++; };
 registerGuild(pi.api as never, {run: async () => assert.fail("visibility reentry launched runner")});
 try {
  const terminal = await pi.tool.execute("visibility", {role: "coder", profile: "general", task: "Work"}, undefined, undefined, ctx);
  assert.ok(shutdown); await shutdown;
  assert.equal(terminal.details.status, "cancelled"); assert.equal(late, 0); assert.equal(timers, 0);
 } finally { globalThis.setInterval = original; await pi.handlers.get("session_shutdown")({}, context()); }
});

for (const boundary of ["tick", "factory-ui", "factory-listener"] as const) it(`visibility callback contains reentrant ${boundary}`, async () => {
 const pi = fakePi(); const ctx = context(); const ui = ctx.ui;
 const ready = deferred<void>(); const release = deferred<void>();
 let armed = false; let closed = false; let stopping = false; let late = 0; let listeners = 0;
 let shutdown: Promise<void> | undefined; let factory: any; let tick: (() => void) | undefined;
 const timers = new Set<ReturnType<typeof setInterval>>();
 const originalSet = globalThis.setInterval; const originalClear = globalThis.clearInterval;
 globalThis.setInterval = ((callback: any, delay: number, ...args: any[]) => {
  const timer = originalSet(callback, delay, ...args); timers.add(timer);
  if (delay === 1000) tick = callback;
  return timer;
 }) as typeof setInterval;
 globalThis.clearInterval = ((timer: any) => { timers.delete(timer); originalClear(timer); }) as typeof clearInterval;
 const stop = () => { armed = false; stopping = true; shutdown = pi.handlers.get("session_shutdown")({}, ctx); closed = true; stopping = false; };
 for (const key of ["mode", "ui"] as const) {
  const value = ctx[key]; Object.defineProperty(ctx, key, {get() {
   if (closed) { late++; throw new Error(`retired ${key}`); }
   if (armed && !stopping && key === (boundary === "tick" ? "mode" : "ui") && boundary !== "factory-listener") stop();
   return value;
  }});
 }
 (ui as any).setWidget = (_key: any, value: any) => { if (closed) late++; if (typeof value === "function") factory = value; };
 ui.setStatus = () => { if (closed) late++; };
 ui.onTerminalInput = () => { listeners++; if (armed) stop(); return () => { listeners--; }; };
 registerGuild(pi.api as never, {run: async options => { ready.resolve(); await release.promise; return resultFor(options); }});
 const tool = pi.tool.execute("visibility-callback", {role: "coder", profile: "general", task: "Work"}, undefined, undefined, ctx);
 try {
  await ready.promise; armed = true;
  if (boundary === "tick") { assert.ok(tick); assert.doesNotThrow(() => tick!()); }
  else {
   assert.ok(factory);
   assert.doesNotThrow(() => factory({requestRender() {}, terminal: {rows: 30}}, {}));
  }
  assert.ok(shutdown); release.resolve(); await shutdown;
  assert.equal((await tool).details.status, "cancelled");
  assert.equal(late, 0); assert.equal(listeners, 0); assert.equal(timers.size, 0);
 } finally {
  try { release.resolve(); await tool; await pi.handlers.get("session_shutdown")({}, context()); }
  finally {
   for (const timer of timers) originalClear(timer);
   globalThis.setInterval = originalSet; globalThis.clearInterval = originalClear;
  }
 }
});

it("visibility disposes ticker returned after shutdown reentry", async () => {
 const pi = fakePi(); const ctx = context(); let shutdown: Promise<void> | undefined;
 const timers = new Set<ReturnType<typeof setInterval>>();
 const originalSet = globalThis.setInterval; const originalClear = globalThis.clearInterval;
 globalThis.setInterval = ((callback: any, delay: number, ...args: any[]) => {
  const timer = originalSet(callback, delay, ...args); timers.add(timer);
  if (delay === 1000) shutdown = pi.handlers.get("session_shutdown")({}, ctx);
  return timer;
 }) as typeof setInterval;
 globalThis.clearInterval = ((timer: any) => { timers.delete(timer); originalClear(timer); }) as typeof clearInterval;
 registerGuild(pi.api as never, {run: async () => assert.fail("retired timer launched runner")});
 try {
  const terminal = await pi.tool.execute("timer-install", {role: "coder", profile: "general", task: "Work"}, undefined, undefined, ctx);
  assert.ok(shutdown); await shutdown;
  assert.equal(terminal.details.status, "cancelled"); assert.equal(timers.size, 0);
 } finally {
  try { await pi.handlers.get("session_shutdown")({}, context()); }
  finally {
   for (const timer of timers) originalClear(timer);
   globalThis.setInterval = originalSet; globalThis.clearInterval = originalClear;
  }
 }
});

it("native tree retirement drains active work without launching queued work or disposing session observations", async () => {
 const pi = fakePi(); const ctx = context(); const gate = deferred<void>();
 const store = new LiveTranscriptStore(); let calls = 0; let disposed = 0;
 let options!: RunGuildRoleOptions;
 const fixture = runtimeFixture(() => assert.fail("no background route"));
 registerGuild(pi.api as never, {
  createExecutionRuntime: () => fixture.runtime, createTranscriptStore: () => store,
  createTraceRecorder: () => ({bind: () => () => {}, dispose: () => { disposed++; }}),
  run: async value => { calls++; options = value; await gate.promise; return resultFor(value); },
 });
 await pi.handlers.get("session_start")({}, ctx);
 const input = {role: "coder", profile: "general", task: "tree drain"};
 const active = pi.tool.execute("tree-active", input, undefined, undefined, ctx);
 const queued = pi.tool.execute("tree-queued", input, undefined, undefined, ctx);
 const before = pi.handlers.get("session_before_tree");
 assert.equal(typeof before, "function", "native before-tree handler must own cleanup");
 let settled = false;
 const join = before({}, ctx); void join.then(() => { settled = true; });
 assert.equal(fixture.runtime.isCurrent(fixture.owner), false);
 assert.equal(options.signal?.aborted, true);
 await assertTerminal(queued, "cancelled");
 assert.equal(settled, false);
 assert.equal(disposed, 0);
 gate.resolve(); await assertTerminal(active, "cancelled");
 assert.equal(await join, undefined);
 assert.equal(calls, 1);
 assert.equal(store.list().active.length, 0);
 assert.equal(store.get("tree-active")?.phase, "cancelled");
 assert.equal(fixture.activations, 1, "retirement must not auto-activate");
 await pi.handlers.get("session_shutdown")({}, ctx);
 assert.equal(disposed, 1);
});

it("native tree rearm accepts fresh idle interactive/rpc intent independently of background policy", async () => {
 const previous = process.env.PITHOS_GUILD_PLAN_MODE;
 try {
  for (const mode of [undefined, "required", "standalone", "invalid"]) {
   if (mode === undefined) delete process.env.PITHOS_GUILD_PLAN_MODE; else process.env.PITHOS_GUILD_PLAN_MODE = mode;
   const pi = fakePi(); const ctx = context(); let calls = 0; let activations = 0;
   registerGuild(pi.api as never, {
    createExecutionRuntime: options => { const runtime = createGuildBackgroundRuntime(options); return {...runtime, activate() { activations++; return runtime.activate(); }}; },
    run: async options => { calls++; return resultFor(options); },
   });
   for (const source of ["interactive", "rpc"]) {
    await pi.handlers.get("session_before_tree")({}, ctx);
    const input = pi.handlers.get("input");
    assert.equal(typeof input, "function", "fresh input must have a rearm boundary");
    assert.deepEqual(await input({source, text: "continue"}, ctx), {action: "continue"});
    const result = await pi.tool.execute(`rearmed-${source}`, {role: "coder", profile: "general", task: "ordinary blocking"}, undefined, undefined, ctx);
    assert.equal(result.details.status, "completed", `${mode}/${source}`);
   }
   assert.equal(calls, 2); assert.equal(activations, 3);
   await pi.handlers.get("session_shutdown")({}, ctx);
  }
 } finally { if (previous === undefined) delete process.env.PITHOS_GUILD_PLAN_MODE; else process.env.PITHOS_GUILD_PLAN_MODE = previous; }
});

it("native tree direct intent rearms only at idle entry and old idle waits never reacquire", async () => {
 const pi = fakePi(); const gate = deferred<void>(); const calls: string[] = []; const notices: string[] = [];
 const fixture = runtimeFixture(() => assert.fail("no background route"));
 registerGuild(pi.api as never, {createExecutionRuntime: () => fixture.runtime, run: async options => {calls.push(options.task); return resultFor(options);}});
 const ctx = context(); const command = pi.commands.get("guild-handover").handler;
 const old = command("coder/general old", context({waitForIdle: () => gate.promise}));
 await pi.handlers.get("session_before_tree")({}, ctx);
 let waits = 0;
 const busy = context({isIdle: () => false, waitForIdle: async () => {waits++;}});
 busy.ui.notify = ((text: string) => {notices.push(text);}) as never;
 await command("coder/general busy", busy);
 assert.equal(waits, 0); assert.equal(fixture.activations, 1);
 assert.match(notices.join("\n"), /unavailable/i);
 await command("--help", ctx); assert.equal(fixture.activations, 1);
 await command("coder/general fresh", ctx);
 assert.deepEqual(calls, ["fresh"]);
 assert.equal(fixture.activations, 2);
 gate.resolve(); await old;
 assert.deepEqual(calls, ["fresh"], "old command must retain its entry scope");
 await pi.handlers.get("session_shutdown")({}, ctx);
});

it("native tree reentrant activation cannot let navigation outrun unpublished-owner cleanup", async () => {
 const pi = fakePi(); const ctx = context(); const gate = deferred<void>(); const entered = deferred<void>();
 const actual = createGuildBackgroundRuntime({bus: {emit() {}}, parentEnvironment: {PITHOS_GUILD_PLAN_MODE: "standalone"}});
 let activations = 0; let nested: Promise<unknown> | undefined; let owner!: GuildOwner;
 let nestedSettled = false; let holdRetire = false;
 registerGuild(pi.api as never, {
  createExecutionRuntime: () => ({...actual,
   activate() { owner = actual.activate(); activations++; if (activations === 2) {
    holdRetire = true; nested = Promise.resolve(pi.handlers.get("session_before_tree")({}, ctx));
    void nested.then(() => {nestedSettled = true;});
   } return owner; },
   retire(token) { const retired = actual.retire(token); if (!holdRetire) return retired;
    entered.resolve(); return Promise.all([retired, gate.promise]).then(() => {});
   },
  }), run: async options => resultFor(options),
 });
 await pi.handlers.get("session_before_tree")({}, ctx);
 await pi.handlers.get("input")({source: "interactive", text: "fresh"}, ctx);
 await entered.promise;
 assert.equal(actual.isCurrent(owner), false);
 assert.equal(nestedSettled, false, "reentrant navigation must join the unpublished token's actual cleanup");
 await pi.handlers.get("input")({source: "rpc", text: "during drain"}, ctx);
 assert.equal(activations, 2);
 gate.resolve(); await nested;
 assert.equal(activations, 2, "cleanup completion cannot bank intent");
 await pi.handlers.get("session_shutdown")({}, ctx);
});

for (const fault of ["capture", "unbind", "visibility"] as const) it(`native tree joins ${fault} cleanup and explicitly vetoes faults without rearming`, async () => {
 const pi = fakePi(); const gate = deferred<void>(); const entered = deferred<void>();
 const ctx = context({sessionManager: {getBranch: () => [], getSessionDir: () => "/sessions", getSessionId: () => "tree"}});
 const fixture = runtimeFixture(() => assert.fail("no background route"));
 let disposed = 0; let unbound = 0; let runs = 0;
 registerGuild(pi.api as never, {
  createExecutionRuntime: () => fixture.runtime,
  createTraceRecorder: () => ({bind() {return () => {unbound++; if (fault === "unbind") throw new Error("trace unbind fault");};}, dispose() {disposed++;}}),
  captureRepoState: async () => {if (fault === "capture") {entered.resolve(); await gate.promise;} return {state: "x", head: "a", dirty: false, complete: true};},
  run: async options => {runs++; entered.resolve(); await gate.promise; return resultFor(options);},
 });
 await pi.handlers.get("session_start")({}, ctx);
 const execution = pi.tool.execute(`tree-${fault}`, {role: "coder", profile: "general", task: "work"}, undefined, undefined, ctx);
 const result = Promise.allSettled([execution]); await entered.promise;
 if (fault === "visibility") ctx.ui.setWidget = () => {throw new Error("widget cleanup fault");};
 const before = pi.handlers.get("session_before_tree"); const join = before({}, ctx);
 assert.equal(before({}, ctx), join, "duplicate handler shares its latched join");
 let settled = false; void join.then(() => {settled = true;});
 await Promise.resolve(); assert.equal(settled, false); assert.equal(disposed, 0);
 gate.resolve(); await result;
 assert.deepEqual(await join, fault === "capture" ? undefined : {cancel: true});
 assert.equal(runs, fault === "capture" ? 0 : 1); assert.equal(unbound, runs);
 await pi.handlers.get("input")({source: "rpc", text: "fresh"}, context());
 assert.equal(fixture.activations, fault === "capture" ? 2 : 1);
 await pi.handlers.get("session_shutdown")({}, context()); assert.equal(disposed, 1);
});

it("native tree terminal shutdown dominates a pending retirement and late input", async () => {
 const pi = fakePi(); const gate = deferred<void>(); const ctx = context();
 const fixture = runtimeFixture(() => assert.fail("no background route"));
 registerGuild(pi.api as never, {createExecutionRuntime: () => fixture.runtime, run: async options => {await gate.promise; return resultFor(options);}});
 const active = pi.tool.execute("shutdown-tree", {role: "coder", profile: "general", task: "work"}, undefined, undefined, ctx);
 const before = pi.handlers.get("session_before_tree")({}, ctx);
 const shutdown = pi.handlers.get("session_shutdown")({}, ctx);
 assert.equal(pi.handlers.get("session_shutdown")({}, ctx), shutdown);
 await pi.handlers.get("input")({source: "interactive", text: "during drain"}, ctx);
 gate.resolve(); await active; await shutdown;
 assert.deepEqual(await before, {cancel: true});
 await pi.handlers.get("session_start")({}, ctx);
 await pi.handlers.get("input")({source: "rpc", text: "after shutdown"}, ctx);
 assert.equal(fixture.activations, 1);
});

it("native tree rejects nonfresh and unsafe activation while preserving frozen context receivers", async () => {
 const pi = fakePi(); const fixture = runtimeFixture(() => assert.fail("no background route")); const ctx = context();
 registerGuild(pi.api as never, {createExecutionRuntime: () => fixture.runtime, run: successfulRunner});
 const before = pi.handlers.get("session_before_tree"); const input = pi.handlers.get("input");
 // No-op/earlier veto means no Guild hook dispatch, not a synthetic completion event.
 await input({source: "interactive", text: "same leaf"}, ctx); assert.equal(fixture.activations, 1);
 await before({}, ctx);
 for (const source of ["extension", undefined, "unknown"]) {
  assert.deepEqual(await input({source, text: "not fresh"}, ctx), {action: "continue"});
 }
 const accessor = Object.defineProperty({}, "type", {get() {assert.fail("persistence accessor executed");}});
 const active = [{type: "custom", customType: "plan-theme-state", data: {active: true}}];
 const unknown = [{type: "custom", customType: "plan-theme-state", data: {active: "no"}}];
 const readers = [() => active, () => unknown, () => [accessor], () => new Proxy([], {}), () => {throw new Error("read fault");}];
 for (const getBranch of readers) await input({source: "rpc", text: "unsafe"}, context({sessionManager: {getBranch}}));
 for (const isIdle of [undefined, false, () => false, () => {throw new Error("idle fault");}]) {
  await input({source: "interactive", text: "busy"}, context({isIdle}));
 }
 await pi.handlers.get("session_start")({}, ctx);
 if (pi.handlers.has("session_tree")) await pi.handlers.get("session_tree")({}, ctx);
 await Promise.resolve(); assert.equal(fixture.activations, 1);
 const frozen = context();
 frozen.isIdle = function () {assert.equal(this, frozen); return true;};
 frozen.sessionManager.getBranch = function () {assert.equal(this, frozen.sessionManager); return [];};
 Object.freeze(frozen.sessionManager); Object.freeze(frozen.ui); Object.freeze(frozen);
 await input({source: "rpc", text: "fresh"}, frozen); assert.equal(fixture.activations, 2);
 await input({source: "interactive", text: "already active"}, frozen); assert.equal(fixture.activations, 2);
 await pi.handlers.get("session_shutdown")({}, ctx);
});

for (const boundary of ["idle-getter", "idle-call", "branch-getter", "branch-call", "shutdown", "nested-direct"] as const) it(`native tree activation fences reentrant ${boundary}`, async () => {
 const pi = fakePi(); const ctx = context(); const fixture = runtimeFixture(() => assert.fail("no background route"));
 registerGuild(pi.api as never, {createExecutionRuntime: () => fixture.runtime, run: successfulRunner});
 await pi.handlers.get("session_before_tree")({}, ctx);
 let reentered = false; let nested: Promise<unknown> | undefined;
 const transition = () => {
  if (reentered) return; reentered = true;
  if (boundary === "shutdown") nested = pi.handlers.get("session_shutdown")({}, context());
  else if (boundary === "nested-direct") nested = pi.commands.get("guild-handover").handler("coder/general nested", context());
  else nested = Promise.resolve(pi.handlers.get("session_before_tree")({}, context()));
 };
 if (boundary === "idle-getter") Object.defineProperty(ctx, "isIdle", {get() {transition(); return () => true;}});
 else if (["idle-call", "shutdown", "nested-direct"].includes(boundary)) ctx.isIdle = () => {transition(); return true;};
 else if (boundary === "branch-getter") Object.defineProperty(ctx.sessionManager, "getBranch", {get() {transition(); return () => [];}});
 else ctx.sessionManager.getBranch = () => {transition(); return [];};
 await pi.handlers.get("input")({source: "interactive", text: "fresh"}, ctx);
 await nested; assert.equal(reentered, true); assert.equal(fixture.activations, 1);
 await pi.handlers.get("session_shutdown")({}, context());
});

for (const pendingHost of ["picker", "editor"] as const) it(`native tree stale ${pendingHost} and runner observers cannot publish into a new scope`, async () => {
 const pi = fakePi(); const picker = deferred<string | undefined>(); const gate = deferred<void>();
 const ctx = context(); const store = new LiveTranscriptStore(); const calls: string[] = []; let saved!: RunGuildRoleOptions;
 registerGuild(pi.api as never, {createTranscriptStore: () => store, run: async options => {calls.push(options.task); saved = options; if (options.task === "old") await gate.promise; return resultFor(options);}});
 const selectContext = context(); let selectedValue: string | undefined;
 selectContext.ui.select = ((_title: string, choices: string[]) => {selectedValue = choices.find(choice => choice.startsWith("writer ")); return picker.promise;}) as never;
 selectContext.ui.editor = (() => pendingHost === "editor" ? picker.promise : Promise.resolve("stale dialog work")) as never;
 const pending = pi.commands.get("guild-handover").handler(pendingHost === "editor" ? "writer/general" : "", selectContext);
 await new Promise(resolve => setImmediate(resolve));
 const active = pi.tool.execute("old-observer", {role: "coder", profile: "general", task: "old"}, undefined, undefined, ctx);
 const old = saved; const drain = pi.handlers.get("session_before_tree")({}, ctx);
 await pi.handlers.get("input")({source: "interactive", text: "busy intent"}, ctx);
 gate.resolve(); await active; await drain;
 assert.equal((await pi.tool.execute("no-banked-intent", {role: "coder", profile: "general", task: "must not run"}, undefined, undefined, ctx)).details.status, "cancelled");
 await pi.handlers.get("input")({source: "rpc", text: "fresh"}, ctx);
 await pi.tool.execute("new-observer", {role: "coder", profile: "general", task: "new"}, undefined, undefined, ctx);
 const snapshot = store.get("new-observer");
 const poison = new Proxy({}, {get() {assert.fail("stale observer read");}});
 old.onEvent?.(poison as never); old.onUpdate?.(poison as never);
 picker.resolve(pendingHost === "editor" ? "stale dialog work" : selectedValue); await pending;
 assert.deepEqual(calls, ["old", "new"]); assert.equal(store.get("new-observer"), snapshot); assert.deepEqual(pi.messages, []);
 await pi.handlers.get("session_shutdown")({}, ctx);
});

it("native tree keeps participant holds across generation activation and independent lease release", async () => {
 const pi = fakePi(); const fixture = runtimeFixture(() => assert.fail("no background route")); const ctx = context();
 let calls = 0; registerGuild(pi.api as never, {createExecutionRuntime: () => fixture.runtime, run: async options => {calls++; return resultFor(options);}});
 const participant = fixture.runtime.planParticipant;
 const first = participant.tryAcquire({}); const second = participant.tryAcquire({});
 assert.equal(first.kind, "held"); assert.equal(second.kind, "held");
 if (first.kind !== "held" || second.kind !== "held") return;
 const old = fixture.owner; await pi.handlers.get("session_before_tree")({}, ctx);
 await pi.handlers.get("input")({source: "rpc", text: "activate under hold"}, ctx);
 assert.equal(fixture.activations, 2); assert.equal(fixture.runtime.planParticipant, participant);
 assert.throws(() => fixture.runtime.list(old), /stale|owner/i);
 const tool = () => pi.tool.execute("held-new", {role: "coder", profile: "general", task: "work"}, undefined, undefined, ctx);
 assert.equal((await tool()).details.status, "failed"); first.lease.release();
 assert.equal((await tool()).details.status, "failed"); assert.equal(calls, 0);
 second.lease.release(); assert.equal((await tool()).details.status, "completed"); assert.equal(calls, 1);
 await pi.handlers.get("session_shutdown")({}, ctx);
});

it("native tree message publication fences a reentrant host sendMessage getter", async () => {
 const pi = fakePi(); const ctx = context(); let publishes = 0; let drain: Promise<unknown> | undefined;
 registerGuild(pi.api as never, {run: successfulRunner});
 Object.defineProperty(pi.api, "sendMessage", {get() {
  drain = Promise.resolve(pi.handlers.get("session_before_tree")({}, ctx));
  return () => {publishes++;};
 }});
 await pi.commands.get("guild-handover").handler("coder/general work", ctx);
 await drain;
 assert.equal(publishes, 0, "retired message getter must not yield callable publication authority");
 await pi.handlers.get("session_shutdown")({}, ctx);
});

for (const disposedByHost of [false, true]) it(`native tree closes only owned custom dialogs (host-disposed=${disposedByHost}) and ignores late completion`, async () => {
 const pi = fakePi(); const ctx = context(); const gate = deferred<void>();
 let done = 0; let card: any; let calls = 0;
 ctx.ui.custom = ((factory: any) => {
  card = factory({requestRender() {}}, {fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text}, {matches: () => false}, () => {done++;});
  return new Promise(() => {}); // Host promise is deliberately never joined.
 }) as never;
 registerGuild(pi.api as never, {run: async options => {calls++; await gate.promise; return resultFor(options);}});
 const command = pi.commands.get("guild-handover").handler("coder/general old", ctx);
 await new Promise(resolve => setImmediate(resolve)); assert.ok(card);
 if (disposedByHost) card.dispose();
 const drain = pi.handlers.get("session_before_tree")({}, context());
 assert.equal(done, disposedByHost ? 0 : 1);
 gate.resolve(); await drain; await command;
 await pi.handlers.get("input")({source: "rpc", text: "fresh"}, context());
 await pi.commands.get("guild-handover").handler("coder/general new", context());
 card.dispose(); assert.equal(done, disposedByHost ? 0 : 1); assert.equal(calls, 2);
 assert.deepEqual(pi.messages.map(({message}) => message.details.status), ["started", "started", "completed"]);
 await pi.handlers.get("session_shutdown")({}, context());
});

it("native tree retains bounded terminal history and a single trace recorder until shutdown", async () => {
 const pi = fakePi(); const store = new LiveTranscriptStore({maxRecentRuns: 2}); let creates = 0; let disposes = 0; let binds = 0; let unbinds = 0;
 const ctx = context({sessionManager: {getBranch: () => [], getSessionDir: () => "/sessions", getSessionId: () => "one"}});
 registerGuild(pi.api as never, {
  createTranscriptStore: () => store,
  createTraceRecorder: () => {creates++; return {bind() {binds++; return () => {unbinds++;};}, dispose() {disposes++;}};},
  captureRepoState: async () => ({state: "x", head: "a", dirty: false, complete: true}), run: successfulRunner,
 });
 for (let index = 0; index < 4; index++) {
  await pi.handlers.get("session_start")({}, ctx);
  await pi.tool.execute(`history-${index}`, {role: "coder", profile: "general", task: "work"}, undefined, undefined, ctx);
  await pi.handlers.get("session_before_tree")({}, ctx);
  assert.equal(store.list().active.length, 0); assert.ok(store.list().recent.length <= 2);
  assert.equal(store.get(`history-${index}`)?.phase, "completed");
  await pi.handlers.get("input")({source: "interactive", text: "fresh"}, ctx);
 }
 assert.equal(creates, 1); assert.equal(disposes, 0); assert.equal(binds, 4); assert.equal(unbinds, 4);
 await pi.handlers.get("session_shutdown")({}, ctx); assert.equal(disposes, 1); assert.equal(store.list().retainedBytes, 0);
});

it("native tree retains disposed Plan coordinator protection across activation without rediscovery", async () => {
 const {createPlanCoordinator} = await import("../../pithos.plan/extensions/plan-coordination.ts");
 const coordinator = createPlanCoordinator();
 assert.equal(coordinator.confirmInactive(coordinator.provider.inspect().generation).kind, "ok");
 const pi = fakePi(); const fixture = runtimeFixture(() => assert.fail("no background route")); const ctx = context();
 registerGuild(pi.api as never, {createExecutionRuntime: () => fixture.runtime, run: successfulRunner});
 assert.equal(coordinator.provider.attachParticipant(fixture.runtime.planParticipant).kind, "attached");
 assert.equal(coordinator.transition(coordinator.provider.inspect().generation, "entering").kind, "ok");
 coordinator.dispose();
 await pi.handlers.get("session_before_tree")({}, ctx);
 await pi.handlers.get("input")({source: "rpc", text: "fresh"}, ctx);
 assert.equal(fixture.activations, 2);
 const result = await pi.tool.execute("disposed-plan", {role: "coder", profile: "general", task: "work"}, undefined, undefined, ctx);
 assert.equal(result.details.status, "failed"); assert.match(result.details.error, /Plan hold/i);
 await pi.handlers.get("session_shutdown")({}, ctx);
});

it("native tree closes owned dialogs before disposing the panel and joins local command cleanup", async () => {
 const pi = fakePi(); const gate = deferred<void>(); const ctx = context(); const order: string[] = []; let card: any;
 ctx.ui.setWidget = ((_key: string, value: any) => {
  if (typeof value === "function") value({requestRender() {}, terminal: {rows: 24}, hasOverlay: () => false}, inlineTheme);
 }) as never;
 ctx.ui.onTerminalInput = (() => () => {order.push("panel-dispose"); card?.dispose();}) as never;
 ctx.ui.custom = ((factory: any) => {
  card = factory({requestRender() {}}, {fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text}, {matches: () => false}, () => {order.push("dialog-close");});
  return new Promise(() => {});
 }) as never;
 registerGuild(pi.api as never, {run: async options => {await gate.promise; return resultFor(options);}});
 const active = pi.tool.execute("panel-active", {role: "coder", profile: "general", task: "work"}, undefined, undefined, ctx);
 let localSettled = false;
 const direct = pi.commands.get("guild-handover").handler("coder/general queued", ctx).then(() => {localSettled = true;});
 await new Promise(resolve => setImmediate(resolve)); assert.ok(card);
 const drain = pi.handlers.get("session_before_tree")({}, ctx);
 gate.resolve(); await drain;
 assert.deepEqual(order.slice(0, 2), ["dialog-close", "panel-dispose"]);
 assert.equal(localSettled, true);
 await Promise.all([active, direct]); await pi.handlers.get("session_shutdown")({}, ctx);
});

it("native tree activation does not relax captured background admission policy", async () => {
 const previous = process.env.PITHOS_GUILD_PLAN_MODE;
 try {
  for (const mode of [undefined, "required", "standalone", "invalid"]) {
   if (mode === undefined) delete process.env.PITHOS_GUILD_PLAN_MODE; else process.env.PITHOS_GUILD_PLAN_MODE = mode;
   const pi = fakePi(); const ctx = context(); let runtime!: GuildExecutionRuntime; let owner!: GuildOwner;
   registerGuild(pi.api as never, {createExecutionRuntime: options => {
    runtime = createGuildBackgroundRuntime({...options, runner: async options => backgroundResult(options)});
    return {...runtime, activate() {owner = runtime.activate(); return owner;}};
   }, run: successfulRunner});
   await pi.handlers.get("session_before_tree")({}, ctx);
   process.env.PITHOS_GUILD_PLAN_MODE = mode === "standalone" ? "invalid" : "standalone";
   await pi.handlers.get("input")({source: "rpc", text: "fresh"}, ctx);
   const start = () => runtime.start(owner, {role: "coder", profile: "general", task: "internal fixture"}, backgroundContext());
   if (mode === "standalone") {
    const run = start(); assert.equal((await runtime.wait(owner, run.id, 1000)).reason, "terminal");
   } else assert.throws(start, /configuration|admission blocked/i);
   await pi.handlers.get("session_shutdown")({}, ctx);
  }
 } finally {if (previous === undefined) delete process.env.PITHOS_GUILD_PLAN_MODE; else process.env.PITHOS_GUILD_PLAN_MODE = previous;}
});

it("native tree activation rechecks current idle after activation callbacks before publishing", async () => {
 const pi = fakePi(); let idle = true; let count = 0; let owner!: GuildOwner;
 const ctx = context({isIdle: () => idle});
 const runtime = createGuildBackgroundRuntime({bus: {emit() {}}});
 registerGuild(pi.api as never, {createExecutionRuntime: () => ({...runtime, activate() {
  owner = runtime.activate(); if (++count === 2) idle = false; return owner;
 }}), run: successfulRunner});
 await pi.handlers.get("session_before_tree")({}, ctx);
 await pi.handlers.get("input")({source: "interactive", text: "fresh"}, ctx);
 assert.equal(runtime.isCurrent(owner), false, "busy activation callback must revoke the unpublished token");
 await pi.handlers.get("session_shutdown")({}, ctx);
});

for (const boundary of ["idle", "activate"] as const) for (const data of [{active: true}, {active: "unknown"}, Object.defineProperty({}, "active", {get() {throw new Error("unsafe");}})]) it(`native tree persistence changes at ${boundary} (${String(Object.getOwnPropertyDescriptor(data, "active")?.value)})`, async () => {
 const pi = fakePi(); let branch: unknown[] = []; let idleCalls = 0; let activations = 0; let calls = 0; let owner!: GuildOwner;
 const changed = () => {branch = [{type: "custom", customType: "plan-theme-state", data}];};
 const ctx = context({isIdle() {if (++idleCalls === 2 && boundary === "idle") changed(); return true;}});
 ctx.sessionManager.getBranch = (() => branch) as never;
 const runtime = createGuildBackgroundRuntime({bus: {emit() {}}});
 registerGuild(pi.api as never, {createExecutionRuntime: () => ({...runtime, activate() {
  owner = runtime.activate(); if (++activations === 2 && boundary === "activate") changed(); return owner;
 }}), run: async options => {calls++; return resultFor(options);}});
 await pi.handlers.get("session_before_tree")({}, ctx);
 await pi.handlers.get("input")({source: "rpc", text: "fresh"}, ctx);
 assert.equal(runtime.isCurrent(owner), false, "ineligible persistence must not publish an owner");
 assert.equal(activations, boundary === "idle" ? 1 : 2);
 await pi.tool.execute("denied", {role: "coder", profile: "general", task: "no launch"}, undefined, undefined, ctx);
 assert.equal(calls, 0);
 assert.equal(await pi.handlers.get("session_before_tree")({}, ctx), undefined);
 await pi.handlers.get("session_shutdown")({}, ctx);
});

for (const aborted of [false, true, "blocking"] as const) it(`native tree real prompt cleanup fault fails closed (aborted=${aborted})`, async () => {
 const directory = mkdtempSync(join(tmpdir(), "guild-cleanup-test-"));
 const child = join(directory, "child.mjs");
 writeFileSync(child, `process.stdout.write(JSON.stringify({type: "fixture-ready", pid: process.pid}) + "\\n"); setInterval(() => {}, 1000); process.on("SIGTERM", () => {}); process.on("SIGUSR2", () => process.exit(0));`);
 const originalScript = process.argv[1]; const originalRm = fsPromises.rm;
 const ready = deferred<number>(); const cleaning = deferred<void>(); const release = deferred<void>();
 let promptDir = ""; let launches = 0;
 const pi = fakePi(); const ctx = context({cwd: process.cwd()}); const fixture = runtimeFixture(() => assert.fail("background"));
 process.argv[1] = child;
 fsPromises.rm = async path => {promptDir = String(path); cleaning.resolve(); await release.promise; throw new Error("private filesystem detail");};
 registerGuild(pi.api as never, {createExecutionRuntime: () => fixture.runtime, run: options => {
  launches++;
  return runGuildRole({...options, onEvent(event) {if (event.type === "fixture-ready") ready.resolve(event.pid as number);}});
 }});
 let execution: Promise<unknown> | undefined;
 try {
  execution = pi.tool.execute("cleanup", {role: "coder", profile: "general", task: "work"}, undefined, undefined, ctx);
  const outcome = execution!.then(() => "fulfilled", error => (error as Error).name);
  const pid = await ready.promise;
  let navigation: Promise<unknown> | undefined;
  if (aborted === true) navigation = pi.handlers.get("session_before_tree")({}, ctx);
  process.kill(pid, "SIGUSR2");
  await cleaning.promise;
  assert.throws(() => process.kill(pid, 0), /ESRCH/, "cleanup follows actual close");
  if (aborted === "blocking") {
   release.resolve();
   assert.equal(await outcome, "GuildCleanupError");
  }
  navigation ??= pi.handlers.get("session_before_tree")({}, ctx);
  let settled = false; void navigation!.then(() => {settled = true;});
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, aborted === "blocking");
  release.resolve();
  assert.deepEqual(await navigation, {cancel: true});
  assert.equal(await outcome, "GuildCleanupError");
  await pi.handlers.get("input")({source: "rpc", text: "fresh"}, ctx);
  await pi.commands.get("guild-handover").handler("coder/general denied", ctx);
  assert.equal(fixture.activations, 1); assert.equal(launches, 1);
 } finally {
  try {
   release.resolve(); await execution?.catch(() => {});
   await assert.rejects(pi.handlers.get("session_shutdown")({}, ctx), /Guild shutdown cleanup failed/);
  } finally {
   fsPromises.rm = originalRm; process.argv[1] = originalScript;
   rmSync(directory, {recursive: true, force: true}); if (promptDir) rmSync(promptDir, {recursive: true, force: true});
  }
 }
});

it("ordinary task diagnostics mentioning cleanup do not fail registration ownership", async () => {
 const pi = fakePi(); const ctx = context(); const fixture = runtimeFixture(() => assert.fail("background"));
 registerGuild(pi.api as never, {createExecutionRuntime: () => fixture.runtime, run: async options => resultFor(options, {status: "failed", errorMessage: "Guild prompt cleanup failed.", exitCode: 1})});
 const result = await pi.tool.execute("task-failure", {role: "coder", profile: "general", task: "work"}, undefined, undefined, ctx);
 assert.equal(result.details.status, "failed");
 assert.equal(await pi.handlers.get("session_before_tree")({}, ctx), undefined);
 await pi.handlers.get("input")({source: "rpc", text: "fresh"}, ctx);
 assert.equal(fixture.activations, 2);
 await pi.handlers.get("session_shutdown")({}, ctx);
});

// Followup test list: latch before queued admission; settle owned direct UI on cleanup failure.
it("real cleanup fault latches before queued runner admission", {timeout: 5000}, async () => {
 const directory = mkdtempSync(join(tmpdir(), "guild-followup-"));
 const child = join(directory, "child.mjs");
 writeFileSync(child, `process.stdout.write(JSON.stringify({type: "fixture-ready", pid: process.pid}) + "\\n"); setInterval(() => {}, 1000); process.on("SIGUSR2", () => process.exit(0));`);
 const originalScript = process.argv[1]; const originalRm = fsPromises.rm;
 const ready = deferred<number>(); const cleaning = deferred<void>(); const release = deferred<void>();
 const prompts: string[] = []; let launches = 0; let pid: number | undefined;
 const pi = fakePi(); const ctx = context({cwd: process.cwd()});
 process.argv[1] = child;
 fsPromises.rm = async path => {prompts.push(String(path)); cleaning.resolve(); await release.promise; throw new Error("private filesystem detail");};
 registerGuild(pi.api as never, {run: options => {
  launches++;
  if (launches > 1) return Promise.resolve(resultFor(options));
  return runGuildRole({...options, onEvent(event) {if (event.type === "fixture-ready") ready.resolve(event.pid as number);}});
 }});
 try {
  const first = pi.tool.execute("first", {role: "coder", profile: "general", task: "work"}, undefined, undefined, ctx);
  const failed = assert.rejects(first, {name: "GuildCleanupError"});
  pid = await ready.promise;
  const queued = ["second", "third"].map(id => pi.tool.execute(id, {role: "coder", profile: "general", task: "queued"}, undefined, undefined, ctx));
  process.kill(pid, "SIGUSR2"); await cleaning.promise; release.resolve();
  await failed; await Promise.all(queued);
  assert.equal(launches, 1, "queued dependency must not be entered (and cannot spawn a child)");
 } finally {
  release.resolve();
  if (pid) {try {process.kill(pid, "SIGKILL");} catch {}}
  await pi.handlers.get("session_shutdown")({}, ctx).catch(() => {});
  fsPromises.rm = originalRm; process.argv[1] = originalScript;
  for (const path of [directory, ...prompts]) rmSync(path, {recursive: true, force: true});
 }
});

it("real cleanup fault settles still-owned direct dialog without navigation", {timeout: 5000}, async (t) => {
 const directory = mkdtempSync(join(tmpdir(), "guild-followup-direct-"));
 const child = join(directory, "child.mjs");
 writeFileSync(child, `process.stdout.write(JSON.stringify({type: "fixture-ready", pid: process.pid}) + "\\n"); setInterval(() => {}, 1000); process.on("SIGUSR2", () => process.exit(0));`);
 const originalScript = process.argv[1]; const originalRm = fsPromises.rm;
 const ready = deferred<number>(); const prompts: string[] = [];
 let pid: number | undefined; let card: any; let done = 0; let cleared = 0; let renders = 0;
 const timers = new Set<ReturnType<typeof setInterval>>();
 const interval = globalThis.setInterval; const clear = globalThis.clearInterval;
 t.mock.method(globalThis, "setInterval", ((callback: any, delay: number, ...args: any[]) => {
  const timer = interval(callback, delay, ...args); if (delay === 80) timers.add(timer); return timer;
 }) as typeof setInterval);
 t.mock.method(globalThis, "clearInterval", ((timer: any) => {if (timers.has(timer)) cleared++; clear(timer);}) as typeof clearInterval);
 const pi = fakePi(); const ctx = context({cwd: process.cwd()});
 ctx.ui.custom = ((factory: any) => new Promise(resolve => {
  card = factory({requestRender() {renders++;}}, inlineTheme, {matches: () => false}, (value: any) => {
   done++; card.dispose(); resolve(value);
  });
 })) as never;
 process.argv[1] = child;
 fsPromises.rm = async path => {prompts.push(String(path)); throw new Error("private filesystem detail");};
 registerGuild(pi.api as never, {run: options => runGuildRole({...options, onEvent(event) {
  if (event.type === "fixture-ready") ready.resolve(event.pid as number);
 }})});
 let deadline: ReturnType<typeof setTimeout> | undefined;
 try {
  const command = pi.commands.get("guild-handover").handler("coder/general work", ctx);
  pid = await ready.promise; process.kill(pid, "SIGUSR2");
  const outcome = await Promise.race([command.then(() => "settled"), new Promise(resolve => {deadline = setTimeout(() => resolve("hung"), 500);})]);
  assert.equal(outcome, "settled", "owned dialog and local cleanup tail must settle before navigation");
  assert.equal(done, 1); assert.equal(timers.size, 1); assert.equal(cleared, 1);
  const priorRenders = renders;
  card.handleInput("\u001b"); card.dispose();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(renders, priorRenders); assert.equal(done, 1); assert.equal(cleared, 1);
  assert.deepEqual(pi.messages.map(({message}) => message.details.status), ["started"]);
  await assert.rejects(pi.handlers.get("session_shutdown")({}, ctx), /Guild shutdown cleanup failed/);
 } finally {
  if (deadline) clearTimeout(deadline);
  if (pid) {try {process.kill(pid, "SIGKILL");} catch {}}
  await pi.handlers.get("session_shutdown")({}, ctx).catch(() => {});
  fsPromises.rm = originalRm; process.argv[1] = originalScript;
  for (const path of [directory, ...prompts]) rmSync(path, {recursive: true, force: true});
 }
});

it("setup rollback fault joins native navigation and never rearms", async () => {
 const originalWrite = fsPromises.writeFile; const originalRm = fsPromises.rm;
 const cleaning = deferred<void>(); const release = deferred<void>(); const directories: string[] = [];
 const pi = fakePi(); const ctx = context({cwd: process.cwd()}); const fixture = runtimeFixture(() => assert.fail("background"));
 let launches = 0;
 fsPromises.writeFile = async () => {throw new Error("private setup detail");};
 fsPromises.rm = async path => {directories.push(String(path)); cleaning.resolve(); await release.promise; throw new Error("private removal detail");};
 registerGuild(pi.api as never, {createExecutionRuntime: () => fixture.runtime, run: options => {launches++; return runGuildRole(options);}});
 let execution: Promise<unknown> | undefined;
 try {
  execution = pi.tool.execute("setup", {role: "coder", profile: "general", task: "work"}, undefined, undefined, ctx);
  const outcome = execution!.then(() => "fulfilled", error => (error as Error).name);
  await cleaning.promise;
  const navigation = pi.handlers.get("session_before_tree")({}, ctx);
  let settled = false; void navigation.then(() => {settled = true;});
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  release.resolve();
  assert.deepEqual(await navigation, {cancel: true});
  assert.equal(await outcome, "GuildCleanupError");
  await pi.handlers.get("input")({source: "rpc", text: "fresh"}, ctx);
  await pi.commands.get("guild-handover").handler("coder/general denied", ctx);
  assert.equal(fixture.activations, 1); assert.equal(launches, 1);
  assert.equal(directories.length, 1);
 } finally {
  release.resolve(); await execution?.catch(() => {});
  await pi.handlers.get("session_shutdown")({}, ctx).catch(() => {});
  fsPromises.writeFile = originalWrite; fsPromises.rm = originalRm;
  for (const directory of directories) await originalRm(directory, {recursive: true, force: true});
 }
});

it("live blocking discovery attaches the coordinator and vetoes active Plan on both routes", async () => {
 const { createPlanCoordinator } = await import("../../pithos.plan/extensions/plan-coordination.ts");
 const c = createPlanCoordinator(); c.confirmInactive(c.provider.inspect().generation);
 const pi = fakePi(); const ctx = context(); const gate = deferred<void>(); let runs = 0;
 Object.defineProperty(pi.api, "events", {value: createEventBus()});
 pi.api.events.on("pithos.plan.coordination", request => request.reply(c.provider));
 registerGuild(pi.api as never, {run: async options => {runs++; await gate.promise; return resultFor(options);}});
 const work = pi.tool.execute("live-plan", {role: "coder", profile: "general", task: "Work"}, undefined, undefined, ctx);
 try {
  assert.equal(runs, 1);
  assert.equal(c.transition(c.provider.inspect().generation, "active").kind, "blocked");
  gate.resolve(); await work;
  assert.equal(c.transition(c.provider.inspect().generation, "active").kind, "ok");
  assert.equal((await pi.tool.execute("active-plan", {role: "coder", profile: "general", task: "Work"}, undefined, undefined, ctx)).details.status, "failed");
  await pi.commands.get("guild-handover").handler("coder/general Work", ctx);
  assert.equal(runs, 1);
  assert.deepEqual(pi.messages.map(({message}) => message.details.status), ["started", "failed"]);
 } finally {gate.resolve(); await work; await pi.handlers.get("session_shutdown")({}, ctx);}
});

it("trace unbind retains the exclusive reservation against real Plan acquisition", async () => {
 const { createPlanCoordinator } = await import("../../pithos.plan/extensions/plan-coordination.ts");
 const c = createPlanCoordinator(); c.confirmInactive(c.provider.inspect().generation);
 const fixture = runtimeFixture(() => assert.fail("no background"));
 // Isolate cleanup ownership from discovery, which has its own un-pre-attached test.
 c.provider.attachParticipant(fixture.runtime.planParticipant);
 const pi = fakePi(); const attempts: string[] = [];
 const ctx = context({sessionManager: {getBranch: () => [], getSessionDir: () => "/sessions", getSessionId: () => "one"}});
 registerGuild(pi.api as never, {
  createExecutionRuntime: () => fixture.runtime, run: successfulRunner,
  captureRepoState: async () => ({state: "x", head: "a", dirty: false, complete: true}),
  createTraceRecorder: () => ({bind() {return () => {attempts.push(c.transition(c.provider.inspect().generation, "active").kind);};}, dispose() {}}),
 });
 try {
  await pi.handlers.get("session_start")({}, ctx);
  await pi.tool.execute("cleanup-plan", {role: "coder", profile: "general", task: "Work"}, undefined, undefined, ctx);
  assert.deepEqual(attempts, ["blocked"]);
  assert.equal(c.transition(c.provider.inspect().generation, "active").kind, "ok");
 } finally {await pi.handlers.get("session_shutdown")({}, ctx);}
});

for (const boundary of ["queue", "capture", "bind"] as const) it(`live Plan recheck at ${boundary} prevents downstream side effects`, async () => {
 const { createPlanCoordinator } = await import("../../pithos.plan/extensions/plan-coordination.ts");
 const c = createPlanCoordinator(); c.confirmInactive(c.provider.inspect().generation);
 c.transition(c.provider.inspect().generation, "active");
 const pi = fakePi(); const gate = deferred<void>(); const entered = deferred<void>();
 let captures = 0; let binds = 0; let runs = 0; let unbinds = 0;
 Object.defineProperty(pi.api, "events", {value: createEventBus()});
 const appear = () => pi.api.events.on("pithos.plan.coordination", request => request.reply(c.provider));
 const ctx = context({sessionManager: {getBranch: () => [], getSessionDir: () => "/sessions", getSessionId: () => "one"}});
 registerGuild(pi.api as never, {
  run: async options => {runs++; if (boundary === "queue") {entered.resolve(); await gate.promise;} return resultFor(options);},
  captureRepoState: async () => {captures++; if (boundary === "capture") {entered.resolve(); await gate.promise;} return {state: "x", head: "a", dirty: false, complete: true};},
  createTraceRecorder: () => ({bind() {binds++; if (boundary === "bind") appear(); return () => {unbinds++;};}, dispose() {}}),
 });
 const tool = (id: string) => pi.tool.execute(id, {role: "coder", profile: "general", task: "Work"}, undefined, undefined, ctx);
 await pi.handlers.get("session_start")({}, ctx);
 const first = tool("first"); let second: Promise<any> | undefined;
 try {
  if (boundary !== "bind") {
   await entered.promise;
   if (boundary === "queue") second = tool("second");
   appear(); gate.resolve();
  }
  const result = await (second ?? first);
  assert.equal(result.details.status, "failed");
  assert.equal(captures, 1);
  assert.equal(binds, boundary === "capture" ? 0 : 1);
  assert.equal(runs, boundary === "queue" ? 1 : 0);
  assert.equal(unbinds, binds);
 } finally {gate.resolve(); await Promise.allSettled([first, second]); await pi.handlers.get("session_shutdown")({}, ctx);}
});

it("final blocking reservation follows tool metadata and delayed direct custom factories", async () => {
 for (const route of ["metadata", "custom"] as const) {
  const {createPlanCoordinator} = await import("../../pithos.plan/extensions/plan-coordination.ts");
  const c = createPlanCoordinator(); c.confirmInactive(c.provider.inspect().generation);
  const pi = fakePi(); const ctx = context(); let runs = 0;
  Object.defineProperty(pi.api, "events", {value: createEventBus()});
  pi.api.events.on("pithos.plan.coordination", request => request.reply(c.provider));
  const activate = () => assert.equal(c.transition(c.provider.inspect().generation, "active").kind, "ok");
  if (route === "metadata") Object.defineProperty(ctx, "model", {get() {activate(); return undefined;}});
  else ctx.ui.custom = async factory => {await Promise.resolve(); activate(); return runCustom(factory);};
  registerGuild(pi.api as never, {run: async options => {runs++; return resultFor(options);}});
  try {
   if (route === "metadata") {
    const result = await pi.tool.execute("metadata-plan", {role: "coder", profile: "general", task: "Work"}, undefined, undefined, ctx);
    assert.equal(result.details.status, "failed");
   } else {
    await pi.commands.get("guild-handover").handler("coder/general Work", ctx);
    assert.deepEqual(pi.messages.map(({message}) => message.details.status), ["started", "failed"]);
   }
   assert.equal(runs, 0, route);
  } finally {await pi.handlers.get("session_shutdown")({}, ctx);}
 }
});

it("ordinary undefined runner rejection remains a failed result rather than a cleanup fault", async () => {
 const pi = fakePi(); const ctx = context();
 registerGuild(pi.api as never, {run: async () => {throw undefined;}});
 try {
  const result = await pi.tool.execute("undefined-error", {role: "coder", profile: "general", task: "Work"}, undefined, undefined, ctx);
  assert.equal(result.details.status, "failed");
 } finally {await pi.handlers.get("session_shutdown")({}, ctx);}
});

it("trace cleanup cannot revive runner publication after execution settles", async () => {
 const pi = fakePi(); let saved!: RunGuildRoleOptions; let updates = 0; let atCleanup = 0;
 const ctx = context({sessionManager: {getBranch: () => [], getSessionDir: () => "/sessions", getSessionId: () => "one"}});
 registerGuild(pi.api as never, {
  run: async options => {saved = options; return resultFor(options);},
  captureRepoState: async () => ({state: "x", head: "a", dirty: false, complete: true}),
  createTraceRecorder: () => ({bind() {return () => {atCleanup = updates; saved.onUpdate?.(resultFor(saved));};}, dispose() {}}),
 });
 try {
  await pi.handlers.get("session_start")({}, ctx);
  await pi.tool.execute("cleanup-publication", {role: "coder", profile: "general", task: "Work"}, undefined, () => updates++, ctx);
  assert.equal(updates, atCleanup);
 } finally {await pi.handlers.get("session_shutdown")({}, ctx);}
});

// Regression list: trace unbind Error/null/undefined must close only the owned dialog,
// release its progress timer, suppress late publication, and retain shutdown diagnostics.
for (const fault of [new Error("trace unbind fault"), null, undefined]) it(`trace cleanup settles owned direct dialog before navigation (${String(fault)})`, {timeout: 5000}, async (t) => {
 const pi = fakePi();
 const ctx = context({sessionManager: {getBranch: () => [], getSessionDir: () => "/sessions", getSessionId: () => "one"}});
 let saved!: RunGuildRoleOptions; let card: any; let done = 0; let cleared = 0; let renders = 0; let unbound = 0; let disposed = 0;
 const timers = new Set<ReturnType<typeof setInterval>>();
 const interval = globalThis.setInterval; const clear = globalThis.clearInterval;
 t.mock.method(globalThis, "setInterval", ((callback: any, delay: number, ...args: any[]) => {
  const timer = interval(callback, delay, ...args); if (delay === 80) timers.add(timer); return timer;
 }) as typeof setInterval);
 t.mock.method(globalThis, "clearInterval", ((timer: any) => {if (timers.has(timer)) cleared++; clear(timer);}) as typeof clearInterval);
 ctx.ui.custom = ((factory: any) => new Promise(resolve => {
  card = factory({requestRender() {renders++;}}, inlineTheme, {matches: () => false}, (value: any) => {
   done++; card.dispose(); resolve(value);
  });
 })) as never;
 registerGuild(pi.api as never, {
  run: async options => {saved = options; return resultFor(options);},
  captureRepoState: async () => ({state: "x", head: "a", dirty: false, complete: true}),
  createTraceRecorder: () => ({bind() {return () => {unbound++; throw fault;};}, dispose() {disposed++;}}),
 });
 let deadline: ReturnType<typeof setTimeout> | undefined;
 try {
  await pi.handlers.get("session_start")({}, ctx);
  const command = pi.commands.get("guild-handover").handler("coder/general work", ctx);
  const outcome = await Promise.race([command.then(() => "settled"), new Promise(resolve => {deadline = setTimeout(() => resolve("hung"), 500);})]);
  assert.equal(outcome, "settled", "owned dialog and local cleanup tail must settle before navigation");
  assert.equal(done, 1); assert.equal(unbound, 1); assert.equal(timers.size, 1); assert.equal(cleared, 1);
  const priorRenders = renders;
  saved.onUpdate?.(resultFor(saved));
  card.handleInput("\u001b"); card.dispose();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(renders, priorRenders); assert.equal(done, 1); assert.equal(cleared, 1);
  assert.deepEqual(pi.messages.map(({message}) => message.details.status), ["started"]);
  await assert.rejects(pi.handlers.get("session_shutdown")({}, ctx), (error: unknown) => {
   assert.ok(error instanceof AggregateError);
   assert.match(error.message, /Guild shutdown cleanup failed/);
   if (fault instanceof Error) assert.equal(error.errors[0], fault);
   else {
    assert.ok(error.errors[0] instanceof Error);
    assert.equal(error.errors[0].message, "Guild trace cleanup failed.");
    assert.equal(error.errors[0].cause, fault);
   }
   return true;
  });
  assert.equal(disposed, 1);
 } finally {
  if (deadline) clearTimeout(deadline);
  await pi.handlers.get("session_shutdown")({}, ctx).catch(() => {});
 }
});

it("semantic interrupt fences held and queued work and joins adapter cleanup at shutdown", async () => {
 const pi = fakePi(); const ctx = context(); const runner = deferred<void>(); const cleanup = deferred<void>();
 let interrupt!: () => void; let subscriptions = 0; let options!: RunGuildRoleOptions; let launches = 0;
 Object.assign(ctx.ui, {semanticInterrupt: {protocol: "pi-semantic-interrupt-v1", subscribe(callback: () => void) {
  subscriptions++; interrupt = callback; return () => cleanup.promise;
 }}});
 registerGuild(pi.api as never, {run: async value => { launches++; options = value; await runner.promise; return resultFor(value); }});
 pi.handlers.get("session_start")({}, ctx);
 assert.equal(subscriptions, 1);
 const first = pi.tool.execute("semantic-first", {role: "explorer", profile: "general", task: "first"}, undefined, undefined, ctx);
 await new Promise(resolve => setImmediate(resolve));
 const second = pi.tool.execute("semantic-second", {role: "explorer", profile: "general", task: "second"}, undefined, undefined, ctx);
 interrupt();
 assert.equal(options.signal?.aborted, true);
 let settled = false;
 const shutdown = Promise.resolve(pi.handlers.get("session_shutdown")({}, ctx)).then(() => { settled = true; });
 runner.resolve(); await Promise.all([first, second]);
 await new Promise(resolve => setImmediate(resolve));
 assert.equal(launches, 1); assert.equal(settled, false);
 cleanup.resolve(); await shutdown;
 assert.equal(pi.messages.length, 0);
});

for (const reason of ["ui-reset", "ui-stop", "runner-rebind", "runner-invalidate"]) it(`semantic interrupt host retirement ${reason} revokes local dialog without native UI access`, async () => {
 const pi = fakePi(); const ctx = context(); const gate = deferred<void>();
 let retire!: (reason: string) => void; let stale = false; let doneCalls = 0; let writes = 0;
 ctx.ui.custom = ((factory: any) => {
  factory({requestRender() {}}, {fg: (_: string, value: string) => value, bold: (value: string) => value}, {matches: () => false}, () => { doneCalls++; });
  return new Promise(() => {});
 }) as never;
 ctx.ui.setWidget = () => { if (stale) writes++; };
 ctx.ui.setStatus = () => { if (stale) writes++; };
 Object.assign(ctx.ui, {semanticInterrupt: {protocol: "pi-semantic-interrupt-v1", subscribe(_callback: () => void, callback: (reason: string) => void) {
  retire = callback; return () => {};
 }}});
 registerGuild(pi.api as never, {run: async options => { await gate.promise; return resultFor(options); }});
 pi.handlers.get("session_start")({}, ctx);
 const direct = pi.commands.get("guild-handover").handler("explorer/general held", ctx);
 await new Promise(resolve => setImmediate(resolve));
 ctx.ui = new Proxy(ctx.ui, {get(target, key, receiver) { if (stale) writes++; return Reflect.get(target, key, receiver); }});
 stale = true; retire(reason);
 assert.equal(doneCalls, 0); assert.equal(writes, 0);
 gate.resolve(); await direct;
 await pi.handlers.get("session_shutdown")({}, ctx);
 assert.equal(doneCalls, 0); assert.equal(writes, 0); assert.deepEqual(pi.messages.map(x => x.message.details.status), ["started"]);
});

it("semantic interrupt rearms only fresh idle inactive-Plan intent after full drain", async () => {
 const pi = fakePi(); const ctx = context(); const cleanup = deferred<void>(); const runner = deferred<void>();
 const callbacks: Array<() => void> = []; let launches = 0;
 Object.assign(ctx.ui, {semanticInterrupt: {protocol: "pi-semantic-interrupt-v1", subscribe(callback: () => void) {
  callbacks.push(callback); return () => callbacks.length === 1 ? cleanup.promise : undefined;
 }}});
 registerGuild(pi.api as never, {run: async options => { launches++; if (launches === 1) await runner.promise; return resultFor(options); }});
 const start = pi.handlers.get("session_start"); const input = pi.handlers.get("input");
 await start({}, ctx); await await start({}, ctx); assert.equal(callbacks.length, 1);
 const tool = () => pi.tool.execute("semantic-rearm", {role: "explorer", profile: "general", task: "work"}, undefined, undefined, ctx);
 const old = tool(); callbacks[0](); await input({source: "interactive", text: "busy"}, ctx);
 runner.resolve(); await old; await new Promise(resolve => setImmediate(resolve));
 assert.equal((await tool()).details.status, "cancelled"); assert.equal(callbacks.length, 1);
 cleanup.resolve(); await new Promise(resolve => setImmediate(resolve));
 await start({}, ctx); assert.equal((await tool()).details.status, "cancelled");
 ctx.isIdle = () => false; await input({source: "interactive", text: "busy"}, ctx); assert.equal(callbacks.length, 1);
 ctx.isIdle = () => true;
 ctx.sessionManager.getBranch = () => [{type: "custom", customType: "plan-theme-state", data: {active: true}}] as never;
 await input({source: "rpc", text: "Plan active"}, ctx); assert.equal(callbacks.length, 1);
 ctx.sessionManager.getBranch = () => { throw new Error("unreadable Plan"); };
 await input({source: "rpc", text: "uncertain"}, ctx); assert.equal(callbacks.length, 1);
 ctx.sessionManager.getBranch = () => [];
 await input({source: "rpc", text: "fresh"}, ctx); assert.equal(callbacks.length, 2);
 callbacks[0](); assert.equal((await tool()).details.status, "completed"); assert.equal(launches, 2);
 await pi.handlers.get("session_shutdown")({}, ctx);
});

it("semantic interrupt during registration fences scope before disposer reentry", async () => {
 const pi = fakePi(); const ctx = context(); const cleanup = deferred<void>(); let nested: Promise<any> | undefined; let launches = 0;
 Object.assign(ctx.ui, {semanticInterrupt: {protocol: "pi-semantic-interrupt-v1", subscribe(callback: () => void) {
  callback(); return () => {
   nested = pi.tool.execute("semantic-reentry", {role: "explorer", profile: "general", task: "forbidden"}, undefined, undefined, ctx);
   return cleanup.promise;
  };
 }}});
 registerGuild(pi.api as never, {run: async options => { launches++; return resultFor(options); }});
 pi.handlers.get("session_start")({}, ctx);
 assert.equal((await nested).details.status, "cancelled"); assert.equal(launches, 0);
 let closed = false; const shutdown = Promise.resolve(pi.handlers.get("session_shutdown")({}, ctx)).then(() => { closed = true; });
 await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
 cleanup.resolve(); await shutdown; assert.equal(pi.messages.length, 0);
});

it("semantic interrupt cleanup fault latches closed before fresh intent", async () => {
 const pi = fakePi(); const ctx = context(); const cleanup = deferred<void>(); let interrupt!: () => void; let subscriptions = 0;
 Object.assign(ctx.ui, {semanticInterrupt: {protocol: "pi-semantic-interrupt-v1", subscribe(callback: () => void) {
  subscriptions++; interrupt = callback; return () => cleanup.promise;
 }}});
 registerGuild(pi.api as never, {run: async () => assert.fail("fault must stay closed")});
 pi.handlers.get("session_start")({}, ctx); interrupt(); cleanup.reject(new Error("private provider diagnostic"));
 await new Promise(resolve => setImmediate(resolve));
 await pi.handlers.get("input")({source: "interactive", text: "fresh"}, ctx); assert.equal(subscriptions, 1);
 assert.equal((await pi.tool.execute("semantic-fault", {role: "explorer", profile: "general", task: "forbidden"}, undefined, undefined, ctx)).details.status, "cancelled");
 const shutdown = pi.handlers.get("session_shutdown")({}, ctx);
 await assert.rejects(shutdown, /Guild shutdown cleanup failed/);
});

it("semantic interrupt unavailable capabilities preserve legacy blocking admission", async () => {
 for (const variant of ["absent", "old", "unknown", "malformed", "rpc"] as const) {
  const pi = fakePi(); const ctx = context(); let subscriptions = 0; let launches = 0;
  const subscribe = () => { subscriptions++; return () => {}; };
  if (variant === "old") Object.assign(ctx.ui, {onInterrupt: subscribe});
  if (variant !== "absent" && variant !== "old") Object.assign(ctx.ui, {semanticInterrupt: {
   protocol: variant === "unknown" ? "future" : "pi-semantic-interrupt-v1", subscribe: variant === "malformed" ? 42 : subscribe,
  }});
  if (variant === "rpc") ctx.mode = "rpc";
  registerGuild(pi.api as never, {run: async options => { launches++; return resultFor(options); }});
  await pi.handlers.get("session_start")({}, ctx);
  assert.equal((await pi.tool.execute(`semantic-${variant}`, {role: "explorer", profile: "general", task: "legacy"}, undefined, undefined, ctx)).details.status, "completed");
  assert.equal(launches, 1); assert.equal(subscriptions, 0);
  assert.deepEqual([...pi.tools.keys()].sort(), ["create_commit", "guild_handover"]);
  assert.equal(pi.entries.length, 0);
  await pi.handlers.get("session_shutdown")({}, ctx);
 }
});

it("semantic interrupt cancels actual hidden running waiting and queued runtime records", async (t) => {
 const gate = deferred<void>(); const signals: AbortSignal[] = []; let launches = 0;
 const fixture = runtimeFixture(async options => {
  launches++; signals.push(options.signal!);
  try { if (options.task === "waiting") await options.onQuestion("Wait?", new AbortController().signal); }
  finally { await gate.promise; }
  return backgroundResult(options);
 });
 const pi = fakePi(); const ctx = context(); let interrupt!: () => void;
 Object.assign(ctx.ui, {semanticInterrupt: {protocol: "pi-semantic-interrupt-v1", subscribe(callback: () => void) { interrupt = callback; return () => {}; }}});
 registerGuild(pi.api as never, {createExecutionRuntime: () => fixture.runtime, run: async () => assert.fail("no blocking launch")});
 await pi.handlers.get("session_start")({}, ctx);
 t.after(async () => { gate.resolve(); await pi.handlers.get("session_shutdown")({}, ctx); });
 const records = ["waiting", "running-1", "running-2", "queued"].map(task => fixture.runtime.start(fixture.owner, {role: "reviewer", profile: "general", task}, backgroundContext()));
 await new Promise(resolve => setImmediate(resolve));
 assert.equal(launches, 3); assert.equal(fixture.runtime.status(fixture.owner, records[0].id).status, "waiting");
 assert.equal(fixture.runtime.status(fixture.owner, records[3].id).status, "queued");
 interrupt(); assert.ok(signals.every(signal => signal.aborted));
 let settled = false; const shutdown = Promise.resolve(pi.handlers.get("session_shutdown")({}, ctx)).then(() => { settled = true; });
 await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
 gate.resolve(); await shutdown; assert.equal(launches, 3); assert.equal(pi.messages.length, 0);
});

it("semantic interrupt shutdown joins and retains a retirement visibility cleanup fault", async () => {
 const pi = fakePi(); const ctx = context(); const cleanup = deferred<void>(); let interrupt!: () => void;
 Object.assign(ctx.ui, {semanticInterrupt: {protocol: "pi-semantic-interrupt-v1", subscribe(callback: () => void) { interrupt = callback; return () => cleanup.promise; }}});
 registerGuild(pi.api as never, {run: successfulRunner});
 await pi.handlers.get("session_start")({}, ctx);
 ctx.ui.setWidget = () => { throw new Error("native cleanup failed"); };
 interrupt();
 const shutdown = pi.handlers.get("session_shutdown")({}, ctx);
 cleanup.resolve();
 await assert.rejects(shutdown, /Guild shutdown cleanup failed/);
});

function qualifiedBackgroundContext(pi: ReturnType<typeof fakePi>) {
 let claim: {live: boolean; retire: () => void} | undefined;
 Object.assign(pi.api, {atomicOwnedTools: {protocol: "pi-atomic-owned-tools-v1", bind(names: string[], retire: () => void) {
  const old = claim; const owned = {live: true, retire}; claim = owned;
  if (old) { old.live = false; old.retire(); }
  const update = (batch: any[]) => {
   if (!owned.live) return {status: "aborted", reason: "stale"};
   assert.deepEqual(batch.map(item => item.definition.name), names);
   const active = pi.api.getActiveTools().filter(name => !names.includes(name));
   for (const {definition, activation} of batch) {
    pi.tools.set(definition.name, definition);
    if (activation === "activate" && definition.exposure !== "hidden") active.push(definition.name);
   }
   pi.api.setActiveTools(active);
   return {status: "committed"};
  };
  return {protocol: "pi-atomic-owned-tools-v1", isActive: () => owned.live, update, dispose() {
   if (!owned.live) return {status: "aborted", reason: "stale"};
   const result = update(names.map(name => ({definition: {...pi.tools.get(name), name, exposure: "hidden"}, activation: "deactivate"})));
   if (result.status === "committed") owned.live = false;
   return result;
  }};
 }}});
 const retireAtomic = () => { if (claim?.live) { claim.live = false; claim.retire(); } };
 const manager = {
  getSessionId() { assert.equal(this, manager); return "public-session"; },
  getEntries() { assert.equal(this, manager); return pi.entries; },
  getBranch() { assert.equal(this, manager); return pi.entries; },
 };
 const ctx = context({sessionManager: manager});
 const interrupts: Array<() => void> = [];
 Object.assign(ctx.ui, {semanticInterrupt: {protocol: "pi-semantic-interrupt-v1", subscribe(callback: () => void) {
  interrupts.push(callback); return () => {};
 }}});
 return {ctx, interrupts, retireAtomic};
}

it("public background composition qualifies inventory and persists admission before launch", async () => {
 const environment = process.env.PITHOS_GUILD_PLAN_MODE;
 process.env.PITHOS_GUILD_PLAN_MODE = "standalone";
 const pi = fakePi(); const {ctx, interrupts} = qualifiedBackgroundContext(pi); const gate = deferred<void>();
 let launches = 0;
 registerGuild(pi.api as never, {
  run: successfulRunner,
  createExecutionRuntime: options => createGuildBackgroundRuntime({...options, runner: async request => {
   launches++; assert.ok(pi.entries.some(entry => entry.data.kind === "admitted"));
   await gate.promise; return {...backgroundResult(request), providerUsage: {
    input: 4, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 7,
    cost: {input: 0.04, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.061},
   }};
  }}),
 });
 try {
  assert.equal(pi.tools.has("guild_start"), false);
  await pi.handlers.get("session_start")({}, ctx);
  await pi.handlers.get("session_start")({}, ctx);
  assert.equal(interrupts.length, 1);
  assert.deepEqual(pi.api.getActiveTools().filter(name => name !== "guild_handover" && name !== "create_commit").sort(),
   ["guild_cancel", "guild_send", "guild_start", "guild_status", "guild_wait"]);
  const admitted = await pi.tools.get("guild_start").execute("start", {role: "coder", profile: "general", task: "Work"}, undefined, undefined, ctx);
  assert.equal(typeof admitted.details.runId, "string");
  assert.equal(launches, 1);
  const status = await pi.tools.get("guild_status").execute("status", {}, undefined, undefined, ctx);
  assert.equal(status.details.runs[0].runId, admitted.details.runId);
  const nested = await pi.handlers.get("tool_call")({toolName: "guild_wait", parentToolCallId: "parent"}, ctx);
  assert.equal(nested.block, true);
  assert.equal(pi.entries.some(entry => entry.data.kind === "collected"), false);
  gate.resolve();
  const wait = () => pi.tools.get("guild_wait").execute("wait", {runId: admitted.details.runId}, undefined, undefined, ctx);
  const first = await wait();
  assert.equal(first.usage.totalTokens, 7); assert.ok(first.details.guildBackground);
  const repeat = await wait(); assert.equal(repeat.usage, undefined); assert.equal(repeat.details.guildBackground, undefined);
  assert.equal(pi.entries.filter(entry => entry.data.kind === "collected").length, 1);
 } finally {
  gate.resolve(); await pi.handlers.get("session_shutdown")({}, ctx);
  if (environment === undefined) delete process.env.PITHOS_GUILD_PLAN_MODE; else process.env.PITHOS_GUILD_PLAN_MODE = environment;
 }
});

it("public background navigation drains publication and resumes observation without automatic activation", async () => {
 const pi = fakePi(); const {ctx, interrupts} = qualifiedBackgroundContext(pi);
 const gate = deferred<void>();
 const fixture = runtimeFixture(async options => { await gate.promise; return backgroundResult(options); });
 registerGuild(pi.api as never, {run: successfulRunner, createExecutionRuntime: () => fixture.runtime});
 try {
  await pi.handlers.get("session_start")({}, ctx);
  const call = (name: string, args: unknown = {}) => pi.tools.get(name).execute(name, args, undefined, undefined, ctx);
  const admitted = await call("guild_start", {role: "coder", profile: "general", task: "Navigate"});
  const stale = pi.tools.get("guild_status");
  let drained = false;
  const navigation = Promise.resolve(pi.handlers.get("session_before_tree")({}, ctx)).then(value => {drained = true; return value;});
  assert.deepEqual(pi.api.getActiveTools(), []);
  await assert.rejects(stale.execute("old", {}, undefined, undefined, ctx), /unavailable/);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false);
  gate.resolve(); assert.equal(await navigation, undefined);
  assert.deepEqual(pi.entries.map(entry => entry.data.kind), ["admitted", "terminal"]);
  assert.equal(pi.entries[1].data.report.status, "cancelled");
  assert.equal(typeof pi.handlers.get("session_tree"), "function");
  await pi.handlers.get("session_tree")({}, ctx);
  assert.equal(interrupts.length, 1); assert.deepEqual(pi.api.getActiveTools(), []);
  await pi.handlers.get("input")({source: "interactive", text: "fresh"}, ctx);
  assert.equal(interrupts.length, 2);
  const collected = await call("guild_wait", {runId: admitted.details.runId, timeoutMs: 0});
  assert.ok(collected.details.guildBackground);
  assert.equal(pi.entries.filter(entry => entry.data.kind === "collected").length, 1);
  const repeated = await call("guild_wait", {runId: admitted.details.runId, timeoutMs: 0});
  assert.equal(repeated.details.guildBackground, undefined); assert.equal(repeated.usage, undefined);
  await assert.rejects(stale.execute("still-old", {}, undefined, undefined, ctx), /unavailable/);
 } finally { gate.resolve(); await pi.handlers.get("session_shutdown")({}, ctx); }
});

it("public background Plan entry withdraws tools and fresh active input restores only the same owner", async () => {
 const pi = fakePi(); const {ctx, interrupts} = qualifiedBackgroundContext(pi);
 registerGuild(pi.api as never, {run: successfulRunner});
 try {
  await pi.handlers.get("session_start")({}, ctx);
  assert.equal(pi.api.getActiveTools().length, 5);
  pi.api.appendEntry("plan-theme-state", {active: true});
  await pi.handlers.get("input")({source: "interactive", text: "Plan"}, ctx);
  assert.deepEqual(pi.api.getActiveTools(), []);
  pi.api.appendEntry("plan-theme-state", {active: false});
  await pi.handlers.get("input")({source: "extension", text: "not intent"}, ctx);
  assert.deepEqual(pi.api.getActiveTools(), []);
  await pi.handlers.get("input")({source: "interactive", text: "fresh"}, ctx);
  assert.equal(pi.api.getActiveTools().length, 5); assert.equal(interrupts.length, 1);
 } finally {await pi.handlers.get("session_shutdown")({}, ctx);}
});

it("public background persistence fault closes tools without joining its own publication", async () => {
 const pi = fakePi(); const {ctx} = qualifiedBackgroundContext(pi); const gate = deferred<void>();
 const fixture = runtimeFixture(async options => {await gate.promise; return backgroundResult(options);});
 registerGuild(pi.api as never, {run: successfulRunner, createExecutionRuntime: () => fixture.runtime});
 try {
  await pi.handlers.get("session_start")({}, ctx);
  await pi.tools.get("guild_start").execute("start", {role: "coder", profile: "general", task: "fault"}, undefined, undefined, ctx);
  pi.api.appendEntry = () => {throw new Error("disk fault");};
  gate.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(pi.api.getActiveTools(), []);
  assert.deepEqual(await pi.handlers.get("session_before_tree")({}, ctx), {cancel: true});
  await assert.rejects(pi.handlers.get("session_shutdown")({}, ctx), /Guild shutdown cleanup failed/);
 } finally {gate.resolve(); await Promise.resolve(pi.handlers.get("session_shutdown")({}, ctx)).catch(() => {});}
});

it("public background semantic retirement hides held cleanup and fresh owner collects old cancellations", async () => {
 const pi = fakePi(); const {ctx, interrupts} = qualifiedBackgroundContext(pi); const cleanup = deferred<void>();
 let launches = 0; const signals: AbortSignal[] = [];
 const fixture = runtimeFixture(async options => {
  launches++; signals.push(options.signal!); await cleanup.promise; return backgroundResult(options);
 });
 registerGuild(pi.api as never, {run: successfulRunner, createExecutionRuntime: () => fixture.runtime});
 try {
  await pi.handlers.get("session_start")({}, ctx);
  const saved = pi.tools.get("guild_start");
  const runs = [];
  for (let index = 0; index < 4; index++) runs.push(await saved.execute(`start-${index}`, {role: "reviewer", profile: "general", task: `Task ${index}`}, undefined, undefined, ctx));
  assert.equal(launches, 3);
  interrupts[0](); assert.ok(signals.every(signal => signal.aborted));
  assert.deepEqual(pi.api.getActiveTools(), []);
  await assert.rejects(saved.execute("stale", {role: "coder", profile: "general", task: "no"}, undefined, undefined, ctx), /unavailable/);
  await pi.handlers.get("input")({source: "interactive", text: "too early"}, ctx);
  assert.equal(interrupts.length, 1);
  cleanup.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(pi.entries.filter(entry => entry.data.kind === "terminal" && entry.data.report.status === "cancelled").length, 4);
  await pi.handlers.get("input")({source: "extension", text: "not intent"}, ctx);
  assert.equal(interrupts.length, 1);
  await pi.handlers.get("input")({source: "interactive", text: "fresh"}, ctx);
  assert.equal(interrupts.length, 2);
  const result = await pi.tools.get("guild_wait").execute("collect", {runId: runs[0].details.runId, timeoutMs: 0}, undefined, undefined, ctx);
  assert.ok(result.details.guildBackground); assert.equal(launches, 3);
 } finally {cleanup.resolve(); await pi.handlers.get("session_shutdown")({}, ctx);}
});

it("public background rearm after a later navigation veto refuses another session identity", async () => {
 const pi = fakePi(); const {ctx, interrupts} = qualifiedBackgroundContext(pi);
 const fixture = runtimeFixture(async options => backgroundResult(options));
 registerGuild(pi.api as never, {run: successfulRunner, createExecutionRuntime: () => fixture.runtime});
 try {
  await pi.handlers.get("session_start")({}, ctx);
  assert.equal(await pi.handlers.get("session_before_tree")({}, ctx), undefined);
  // A later hook veto means no session_tree event. Fresh intent must resume explicitly.
  const manager = ctx.sessionManager;
  ctx.sessionManager = {...manager};
  await pi.handlers.get("input")({source: "interactive", text: "wrong manager"}, ctx);
  assert.equal(fixture.activations, 1);
  ctx.sessionManager = manager;
  ctx.cwd = "/other";
  await pi.handlers.get("input")({source: "interactive", text: "wrong cwd"}, ctx);
  assert.equal(fixture.activations, 1);
  ctx.cwd = "/project";
  await pi.handlers.get("input")({source: "interactive", text: "same session"}, ctx);
  assert.equal(fixture.activations, 2); assert.equal(interrupts.length, 2);
  assert.equal(pi.api.getActiveTools().length, 5);
 } finally {await pi.handlers.get("session_shutdown")({}, ctx);}
});

it("manual status is read-only while retired and Plan is active", async () => {
 const pi = fakePi(); const {ctx, interrupts} = qualifiedBackgroundContext(pi);
 const notices: string[] = []; Object.assign(ctx.ui, {notify: (text: string) => {notices.push(text);}});
 const fixture = runtimeFixture(async options => backgroundResult(options));
 registerGuild(pi.api as never, {run: successfulRunner, createExecutionRuntime: () => fixture.runtime});
 try {
  await pi.handlers.get("session_start")({}, ctx);
  interrupts[0](); await new Promise(resolve => setImmediate(resolve));
  pi.api.appendEntry("plan-theme-state", {active: true});
  await pi.commands.get("guild").handler("status", ctx);
  assert.match(notices.at(-1)!, /No background runs/);
  assert.match(notices.at(-1)!, /Automatic parent continuation unavailable; use \/guild status or submit fresh input\./);
  assert.equal(fixture.activations, 1);
  assert.equal(pi.messages.length, 0);
  assert.equal(pi.entries.some(entry => entry.data.kind === "collected"), false);
  await pi.commands.get("guild").handler("status bad\x1b[31mid", ctx);
  assert.match(notices.at(-1)!, /Invalid run ID/);
  assert.doesNotMatch(notices.at(-1)!, /\x1b/);
 } finally {await pi.handlers.get("session_shutdown")({}, ctx);}
});

it("manual cancel joins only the selected run even with Plan active", async () => {
 const pi = fakePi(); const {ctx} = qualifiedBackgroundContext(pi);
 const gates = [deferred<void>(), deferred<void>()]; const signals: AbortSignal[] = [];
 const notices: string[] = []; Object.assign(ctx.ui, {notify: (text: string) => {notices.push(text);}});
 const fixture = runtimeFixture(async options => {
  const index = signals.length; signals.push(options.signal!);
  await gates[index].promise; return backgroundResult(options);
 });
 registerGuild(pi.api as never, {run: successfulRunner, createExecutionRuntime: () => fixture.runtime});
 try {
  await pi.handlers.get("session_start")({}, ctx);
  const ids: string[] = [];
  for (let index = 0; index < 2; index++) {
   const result = await pi.tools.get("guild_start").execute(`start-${index}`, {role: "coder", profile: "general", task: `Work ${index}`}, undefined, undefined, ctx);
   ids.push(result.details.runId);
  }
  pi.api.appendEntry("plan-theme-state", {active: true});
  let settled = false;
  const cancel = pi.commands.get("guild").handler(`cancel ${ids[0]}`, ctx).then(() => {settled = true;});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
  assert.equal(settled, false);
  gates[0].resolve(); await cancel;
  assert.match(notices.at(-1)!, /cancelled/);
  await pi.commands.get("guild").handler(`cancel ${ids[0]}`, ctx);
  assert.match(notices.at(-1)!, /cancelled/);
  assert.equal(fixture.activations, 1);
  assert.equal(pi.messages.length, 0);
  assert.equal(pi.entries.some(entry => entry.data.kind === "collected"), false);
 } finally {gates.forEach(gate => gate.resolve()); await pi.handlers.get("session_shutdown")({}, ctx);}
});

it("manual cancel-all closes admission atomically and joins held cleanup without launching queued work", async () => {
 const pi = fakePi(); const {ctx} = qualifiedBackgroundContext(pi);
 const gate = deferred<void>(); let launches = 0;
 const fixture = runtimeFixture(async options => {launches++; await gate.promise; return backgroundResult(options);});
 const notices: string[] = []; Object.assign(ctx.ui, {notify: (text: string) => {notices.push(text);}});
 registerGuild(pi.api as never, {run: successfulRunner, createExecutionRuntime: () => fixture.runtime});
 try {
  await pi.handlers.get("session_start")({}, ctx);
  for (let index = 0; index < 4; index++) await pi.tools.get("guild_start").execute(`start-${index}`, {role: "coder", profile: "general", task: `Work ${index}`}, undefined, undefined, ctx);
  assert.equal(launches, 3);
  let settled = false;
  const cancel = pi.commands.get("guild").handler("cancel-all", ctx).then(() => {settled = true;});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.runtime.isCurrent(fixture.owner), false);
  assert.equal(settled, false);
  assert.match(notices.at(-1)!, /Cancellation requested; joining cleanup/);
  const repeated = pi.commands.get("guild").handler("cancel-all", ctx);
  assert.match(notices.at(-1)!, /Already draining/);
  gate.resolve(); await Promise.all([cancel, repeated]);
  await pi.commands.get("guild").handler("cancel-all", ctx);
  assert.match(notices.at(-1)!, /No active owner/);
  await pi.commands.get("guild").handler("status", ctx);
  assert.equal(launches, 3);
  assert.equal(fixture.activations, 1);
  assert.equal(pi.messages.length, 0);
  assert.equal(pi.entries.some(entry => entry.data.kind === "collected"), false);
 } finally {gate.resolve(); await pi.handlers.get("session_shutdown")({}, ctx);}
});

it("manual cancel preserves completed status rather than claiming cancellation", async () => {
 const pi = fakePi(); const {ctx} = qualifiedBackgroundContext(pi);
 const notices: string[] = []; Object.assign(ctx.ui, {notify: (text: string) => {notices.push(text);}});
 const fixture = runtimeFixture(async options => backgroundResult(options));
 registerGuild(pi.api as never, {run: successfulRunner, createExecutionRuntime: () => fixture.runtime});
 try {
  await pi.handlers.get("session_start")({}, ctx);
  const result = await pi.tools.get("guild_start").execute("start", {role: "coder", profile: "general", task: "Work"}, undefined, undefined, ctx);
  await fixture.runtime.wait(fixture.owner, result.details.runId, 1000);
  await pi.commands.get("guild").handler(`cancel ${result.details.runId}`, ctx);
  assert.match(notices.at(-1)!, /completed \(already terminal\)/);
  assert.equal(pi.entries.some(entry => entry.data.kind === "collected"), false);
 } finally {await pi.handlers.get("session_shutdown")({}, ctx);}
});

it("manual status inspects collected historical IDs without a second result claim", async () => {
 const pi = fakePi(); const {ctx, interrupts} = qualifiedBackgroundContext(pi);
 const notices: string[] = []; Object.assign(ctx.ui, {notify: (text: string) => {notices.push(text);}});
 const fixture = runtimeFixture(async options => backgroundResult(options));
 registerGuild(pi.api as never, {run: successfulRunner, createExecutionRuntime: () => fixture.runtime});
 try {
  await pi.handlers.get("session_start")({}, ctx);
  const result = await pi.tools.get("guild_start").execute("start", {role: "coder", profile: "general", task: "Work"}, undefined, undefined, ctx);
  await pi.tools.get("guild_wait").execute("wait", {runId: result.details.runId}, undefined, undefined, ctx);
  interrupts[0](); await new Promise(resolve => setImmediate(resolve));
  await pi.commands.get("guild").handler(`status ${result.details.runId}`, ctx);
  assert.ok(notices.at(-1)!.includes(`${result.details.runId} · coder/general · completed`));
  await pi.commands.get("guild").handler(`cancel ${result.details.runId}`, ctx);
  assert.match(notices.at(-1)!, /completed \(already terminal\)/);
  assert.equal(pi.entries.filter(entry => entry.data.kind === "collected").length, 1);
  assert.equal(fixture.activations, 1);
  assert.equal(pi.messages.length, 0);
 } finally {await pi.handlers.get("session_shutdown")({}, ctx);}
});

it("manual status remains available during retirement cleanup", async () => {
 const pi = fakePi(); const {ctx} = qualifiedBackgroundContext(pi); const gate = deferred<void>();
 const notices: string[] = []; Object.assign(ctx.ui, {notify: (text: string) => {notices.push(text);}});
 const fixture = runtimeFixture(async options => {await gate.promise; return backgroundResult(options);});
 registerGuild(pi.api as never, {run: successfulRunner, createExecutionRuntime: () => fixture.runtime});
 try {
  await pi.handlers.get("session_start")({}, ctx);
  const result = await pi.tools.get("guild_start").execute("start", {role: "coder", profile: "general", task: "Work"}, undefined, undefined, ctx);
  const join = pi.commands.get("guild").handler("cancel-all", ctx);
  await pi.commands.get("guild").handler(`status ${result.details.runId}`, ctx);
  assert.ok(notices.at(-1)!.includes(`${result.details.runId} · coder/general · stopping`));
  gate.resolve(); await join;
 } finally {gate.resolve(); await pi.handlers.get("session_shutdown")({}, ctx);}
});

it("manual output fences reentrant UI accessors", async () => {
 for (const property of ["hasUI", "ui", "notify"] as const) for (const action of ["pause", "navigate", "replace"] as const) {
  const pi = fakePi(); const {ctx, interrupts} = qualifiedBackgroundContext(pi);
  const notices: string[] = []; const ui = ctx.ui;
  Object.assign(ui, {notify(text: string) { assert.equal(this, ui); notices.push(text); }});
  const fixture = runtimeFixture(async options => backgroundResult(options));
  registerGuild(pi.api as never, {run: successfulRunner, createExecutionRuntime: () => fixture.runtime});
  await pi.handlers.get("session_start")({}, ctx);
  const target = property === "notify" ? ui : ctx;
  const value = property === "notify" ? ui.notify : property === "ui" ? ui : true;
  const manager = ctx.sessionManager;
  let armed = true;
  Object.defineProperty(target, property, {configurable: true, get() {
   if (armed) {
    armed = false;
    if (action === "pause") interrupts[0]();
    else if (action === "navigate") void pi.handlers.get("session_before_tree")({}, ctx);
    else Object.assign(ctx, {sessionManager: {...manager}});
   }
   return value;
  }});
  try {
   await pi.commands.get("guild").handler("status", ctx);
   assert.deepEqual(notices, [], `${property}/${action}`);
  } finally {
   Object.assign(ctx, {sessionManager: manager});
   Object.defineProperty(target, property, {configurable: true, writable: true, value});
   await pi.handlers.get("session_shutdown")({}, ctx);
  }
 }
});

it("manual output invokes captured functions without reading their call properties", async () => {
 for (const hasUI of [true, false]) {
  const pi = fakePi(); const {ctx, interrupts} = qualifiedBackgroundContext(pi);
  const fixture = runtimeFixture(async options => backgroundResult(options));
  registerGuild(pi.api as never, {run: successfulRunner, createExecutionRuntime: () => fixture.runtime});
  await pi.handlers.get("session_start")({}, ctx);
  Object.assign(ctx, {hasUI});
  const notices: string[] = []; let reads = 0;
  const receiver = hasUI ? ctx.ui : console;
  const notify = function(this: unknown, text: string) { assert.equal(this, receiver); notices.push(text); };
  Object.defineProperty(notify, "call", {get() { reads++; interrupts[0](); return Function.prototype.call; }});
  const originalLog = console.log;
  if (hasUI) Object.assign(ctx.ui, {notify}); else console.log = notify;
  try {
   await pi.commands.get("guild").handler("status", ctx);
   assert.equal(reads, 0, "captured host functions must not have their properties read after the fence");
   assert.equal(notices.length, 1);
  } finally { console.log = originalLog; await pi.handlers.get("session_shutdown")({}, ctx); }
 }
});

it("manual cancel reports authoritative failure after question lifetime abort and held cleanup", async () => {
 const pi = fakePi(); const {ctx} = qualifiedBackgroundContext(pi);
 const question = new AbortController(); const cleanup = deferred<void>(); const stopped = deferred<void>();
 const notices: string[] = []; Object.assign(ctx.ui, {notify: (text: string) => notices.push(text)});
 const fixture = runtimeFixture(async options => {
  try { await options.onQuestion("Continue?", question.signal); }
  finally { stopped.resolve(); await cleanup.promise; }
  return backgroundResult(options);
 });
 registerGuild(pi.api as never, {run: successfulRunner, createExecutionRuntime: () => fixture.runtime});
 try {
  await pi.handlers.get("session_start")({}, ctx);
  const result = await pi.tools.get("guild_start").execute("start", {role: "coder", profile: "general", task: "Work"}, undefined, undefined, ctx);
  const id = result.details.runId;
  assert.equal(fixture.runtime.status(fixture.owner, id).status, "waiting");
  question.abort(); await stopped.promise;
  assert.equal(fixture.runtime.status(fixture.owner, id).status, "stopping");
  const cancel = pi.commands.get("guild").handler(`cancel ${id}`, ctx);
  assert.deepEqual(notices, []);
  cleanup.resolve(); await cancel;
  assert.equal(fixture.runtime.status(fixture.owner, id).status, "failed");
  assert.equal(notices.at(-1), `${id} · failed`);
 } finally {cleanup.resolve(); await pi.handlers.get("session_shutdown")({}, ctx);}
});

it("manual status transient navigation read permits fresh admission on the same service", async () => {
 const pi = fakePi(); const {ctx} = qualifiedBackgroundContext(pi);
 const fixture = runtimeFixture(async options => backgroundResult(options));
 registerGuild(pi.api as never, {run: successfulRunner, createExecutionRuntime: () => fixture.runtime});
 try {
  await pi.handlers.get("session_start")({}, ctx);
  const manager = ctx.sessionManager; const getBranch = manager.getBranch;
  let navigation: Promise<unknown> | undefined;
  Object.assign(manager, {getBranch() {
   Object.assign(manager, {getBranch});
   navigation = Promise.resolve(pi.handlers.get("session_before_tree")({}, ctx));
   throw new Error("transient navigation");
  }});
  await pi.commands.get("guild").handler("status", ctx);
  await navigation;
  await pi.handlers.get("input")({source: "interactive", text: "fresh intent"}, ctx);
  const result = await pi.tools.get("guild_start").execute("fresh", {role: "coder", profile: "general", task: "Work"}, undefined, undefined, ctx);
  assert.equal(typeof result.details.runId, "string");
  await fixture.runtime.wait(fixture.owner, result.details.runId, 1000);
  assert.equal(pi.entries.some(entry => entry.data.kind === "terminal"), true);
 } finally {await pi.handlers.get("session_shutdown")({}, ctx);}
});

it("manual delayed cancel emits nothing after navigation including console fallback", async () => {
 for (const hasUI of [true, false]) {
  const pi = fakePi(); const {ctx} = qualifiedBackgroundContext(pi); const gate = deferred<void>();
  const notices: string[] = []; Object.assign(ctx.ui, {notify: (text: string) => notices.push(text)});
  const fixture = runtimeFixture(async options => {await gate.promise; return backgroundResult(options);});
  registerGuild(pi.api as never, {run: successfulRunner, createExecutionRuntime: () => fixture.runtime});
  const log = console.log;
  try {
   await pi.handlers.get("session_start")({}, ctx);
   const result = await pi.tools.get("guild_start").execute("start", {role: "coder", profile: "general", task: "Work"}, undefined, undefined, ctx);
   Object.assign(ctx, {hasUI}); console.log = (text: string) => {notices.push(text);};
   const cancel = pi.commands.get("guild").handler(`cancel ${result.details.runId}`, ctx);
   const navigation = pi.handlers.get("session_before_tree")({}, ctx);
   gate.resolve(); await cancel; await navigation;
   assert.deepEqual(notices, []);
  } finally {console.log = log; gate.resolve(); await pi.handlers.get("session_shutdown")({}, ctx);}
 }
});

it("background dashboard observes three occupied and eight queued runs until cleanup", async () => {
 const previous = process.env.PITHOS_GUILD_PLAN_MODE;
 process.env.PITHOS_GUILD_PLAN_MODE = "standalone";
 const pi = fakePi(); const {ctx} = qualifiedBackgroundContext(pi);
 let panel: any;
 const lines = () => panel?.render(200) ?? [];
 ctx.ui.setWidget = ((_key: string, value: any) => { panel = typeof value === "function"
  ? value({requestRender() {}, terminal: {rows: 48}}, inlineTheme) : undefined; }) as any;
 const store = new LiveTranscriptStore(); const gate = deferred<void>();
 registerGuild(pi.api as never, {run: successfulRunner, createTranscriptStore: () => store,
  createExecutionRuntime: options => createGuildBackgroundRuntime({...options, runner: async request => {
   await gate.promise; return backgroundResult(request);
  }}),
 });
 try {
  await pi.handlers.get("session_start")({}, ctx);
  const ids: string[] = [];
  for (let i = 0; i < 11; i++) {
   const result = await pi.tools.get("guild_start").execute(`start-${i}`, {role: "coder", profile: "general", task: `Task ${i}`}, undefined, undefined, ctx);
   ids.push(result.details.runId);
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.match(lines().join("\n"), /3 occupied · 8 queued/);
  for (const id of ids) { assert.ok(lines().some((line: string) => line.includes(id))); assert.ok(store.get(id)); }
  assert.equal(pi.messages.length, 0);
  gate.resolve();
  for (const id of ids) await pi.tools.get("guild_wait").execute("wait", {runId: id}, undefined, undefined, ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(lines(), []);
 } finally {
  gate.resolve(); await pi.handlers.get("session_shutdown")({}, ctx);
  if (previous === undefined) delete process.env.PITHOS_GUILD_PLAN_MODE; else process.env.PITHOS_GUILD_PLAN_MODE = previous;
 }
});

it("background observers bind traces before launch and retain distinct early transcripts through retirement cleanup", async () => {
 const previous = process.env.PITHOS_GUILD_PLAN_MODE; process.env.PITHOS_GUILD_PLAN_MODE = "standalone";
 const pi = fakePi(); const {ctx, interrupts} = qualifiedBackgroundContext(pi);
 Object.assign(ctx.sessionManager, {getSessionDir: () => "/tmp/guild-trace-test"});
 const store = new LiveTranscriptStore(); const gate = deferred<void>();
 const questionLifetime = new AbortController();
 const bound = new Set<string>(); const unbound: string[] = []; const launched: string[] = [];
 const notices: string[] = []; ctx.ui.notify = ((text: string) => notices.push(text)) as any;
 registerGuild(pi.api as never, {run: successfulRunner, createTranscriptStore: () => store,
  createTraceRecorder: () => ({bind(id) {bound.add(id); return () => {unbound.push(id);};}, dispose() {}}),
  createExecutionRuntime: options => createGuildBackgroundRuntime({...options, runner: async request => {
   assert.ok(bound.has(request.runId!), "binding precedes runner launch");
   launched.push(request.runId!);
   request.onEvent?.({type: "message_end", message: {role: "assistant", content: [{type: "text", text: `untrusted ${request.runId}`} ]}});
   try { await request.onQuestion("Continue?", launched.length === 1 ? questionLifetime.signal : request.signal!); } catch {}
   await gate.promise; return backgroundResult(request);
  }}),
 });
 try {
  await pi.handlers.get("session_start")({}, ctx);
  for (let i = 0; i < 4; i++) await pi.tools.get("guild_start").execute(`s${i}`, {role: "coder", profile: "general", task: "Private task"}, undefined, undefined, ctx);
  assert.equal(bound.size, 3);
  for (const id of launched) assert.equal(store.get(id)?.entries[0]?.content, `untrusted ${id}`);
  assert.equal(unbound.length, 0);
  const oldIds = store.list().active.map(run => run.id);
  assert.equal(oldIds.length, 4);
  questionLifetime.abort();
  await new Promise(resolve => setImmediate(resolve));
  interrupts[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.list().active.filter(run => launched.includes(run.id)).length, 3);
  const writes = notices.length;
  let staleUiWrites = 0;
  const setWidget = ctx.ui.setWidget; const setStatus = ctx.ui.setStatus;
  ctx.ui.setWidget = (() => {staleUiWrites++;}) as any;
  ctx.ui.setStatus = (() => {staleUiWrites++;}) as any;
  gate.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(new Set(unbound), bound);
  assert.deepEqual(store.list().active, []);
  assert.deepEqual(new Map(store.list().recent.map(run => [run.id, run.phase])),
   new Map(oldIds.map(id => [id, id === launched[0] ? "failed" : "cancelled"])));
  assert.equal(notices.length, writes); assert.equal(pi.messages.length, 0);
  assert.equal(staleUiWrites, 0);
  ctx.ui.setWidget = setWidget; ctx.ui.setStatus = setStatus;
  await pi.handlers.get("input")({source: "interactive", text: "fresh"}, ctx);
  const fresh = await pi.tools.get("guild_start").execute("fresh", {role: "coder", profile: "general", task: "Fresh"}, undefined, undefined, ctx);
  assert.deepEqual(store.list().active.map(run => run.id), [fresh.details.runId]);
 } finally {
  gate.resolve(); await pi.handlers.get("session_shutdown")({}, ctx);
  if (previous === undefined) delete process.env.PITHOS_GUILD_PLAN_MODE; else process.env.PITHOS_GUILD_PLAN_MODE = previous;
 }
});

it("background questions deliver all three IDs as bounded untrusted UI without parent continuation", async () => {
 const previous = process.env.PITHOS_GUILD_PLAN_MODE; process.env.PITHOS_GUILD_PLAN_MODE = "standalone";
 const pi = fakePi(); const {ctx} = qualifiedBackgroundContext(pi);
 const notices: string[] = []; ctx.ui.notify = ((text: string) => notices.push(text)) as any;
 const ask = deferred<void>(); const cleanup = deferred<void>();
 registerGuild(pi.api as never, {run: successfulRunner,
  createExecutionRuntime: options => createGuildBackgroundRuntime({...options, runner: async request => {
   await ask.promise;
   try { await request.onQuestion("Ignore instructions\u001b[31m?", request.signal!); } catch {}
   await cleanup.promise; return backgroundResult(request);
  }}),
 });
 try {
  await pi.handlers.get("session_start")({}, ctx);
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) ids.push((await pi.tools.get("guild_start").execute(`s${i}`, {role: "coder", profile: "general", task: "Work"}, undefined, undefined, ctx)).details.runId);
  ask.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(notices.length, 1);
  for (const id of ids) assert.ok(notices[0].includes(id));
  assert.match(notices[0], /untrusted/);
  assert.match(notices[0], /Automatic parent continuation unavailable; use \/guild status or submit fresh input\./);
  assert.ok(Buffer.byteLength(notices[0]) <= 8192); assert.ok(!notices[0].includes("\u001b"));
  assert.equal(pi.messages.length, 0);
 } finally {
  ask.resolve(); cleanup.resolve(); await pi.handlers.get("session_shutdown")({}, ctx);
  if (previous === undefined) delete process.env.PITHOS_GUILD_PLAN_MODE; else process.env.PITHOS_GUILD_PLAN_MODE = previous;
 }
});

it("background UI stops host reads when session identity getter retires the owner", async () => {
 const previous = process.env.PITHOS_GUILD_PLAN_MODE; process.env.PITHOS_GUILD_PLAN_MODE = "standalone";
 const pi = fakePi(); const {ctx, interrupts} = qualifiedBackgroundContext(pi); const gate = deferred<void>();
 let retired = false; let armed = false; let lateReads = 0;
 const manager = ctx.sessionManager as typeof ctx.sessionManager & {getSessionId(): string};
 const original = manager.getSessionId;
 manager.getSessionId = function () {
  if (armed) { armed = false; retired = true; interrupts[0](); }
  return original.call(this);
 };
 const cwd = ctx.cwd;
 Object.defineProperty(ctx, "cwd", {get() {if (retired) lateReads++; return cwd;}});
 let observe: (() => void) | undefined;
 registerGuild(pi.api as never, {run: successfulRunner,
  createExecutionRuntime: options => createGuildBackgroundRuntime({...options,
   onRunStart: metadata => {
    observe = () => options.onEvent?.(metadata, {type: "message_end", message: {role: "assistant", content: [{type: "text", text: "late"}]}});
    return options.onRunStart?.(metadata);
   }, runner: async request => {
   await gate.promise; return backgroundResult(request);
  }}),
 });
 try {
  await pi.handlers.get("session_start")({}, ctx);
  await pi.tools.get("guild_start").execute("start", {role: "coder", profile: "general", task: "Work"}, undefined, undefined, ctx);
  armed = true; observe!();
  assert.equal(lateReads, 0);
 } finally {
  gate.resolve(); await pi.handlers.get("session_shutdown")({}, ctx);
  if (previous === undefined) delete process.env.PITHOS_GUILD_PLAN_MODE; else process.env.PITHOS_GUILD_PLAN_MODE = previous;
 }
});

it("background waiting and stopping stay occupied until held cleanup completes", async () => {
 const previous = process.env.PITHOS_GUILD_PLAN_MODE; process.env.PITHOS_GUILD_PLAN_MODE = "standalone";
 const pi = fakePi(); const {ctx} = qualifiedBackgroundContext(pi); const gate = deferred<void>();
 const store = new LiveTranscriptStore(); let panel: any;
 ctx.ui.setWidget = ((_key: string, value: any) => {panel = typeof value === "function" ? value({requestRender() {}, terminal: {rows: 48}}, inlineTheme) : undefined;}) as any;
 registerGuild(pi.api as never, {run: successfulRunner, createTranscriptStore: () => store,
  createExecutionRuntime: options => createGuildBackgroundRuntime({...options, runner: async request => {
   try {await request.onQuestion("Continue?", request.signal!);} catch {}
   await gate.promise; return backgroundResult(request);
  }}),
 });
 try {
  await pi.handlers.get("session_start")({}, ctx);
  const {details: {runId}} = await pi.tools.get("guild_start").execute("start", {role: "coder", profile: "general", task: "Work"}, undefined, undefined, ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.get(runId)?.phase, "waiting");
  const cancelled = pi.tools.get("guild_cancel").execute("cancel", {runId}, undefined, undefined, ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.get(runId)?.phase, "stopping");
  assert.match(panel.render(200).join("\n"), /1 occupied · 0 queued/);
  gate.resolve(); await cancelled; await pi.tools.get("guild_wait").execute("wait", {runId}, undefined, undefined, ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.get(runId)?.phase, "cancelled"); assert.equal(panel, undefined);
 } finally {
  gate.resolve(); await pi.handlers.get("session_shutdown")({}, ctx);
  if (previous === undefined) delete process.env.PITHOS_GUILD_PLAN_MODE; else process.env.PITHOS_GUILD_PLAN_MODE = previous;
 }
});

for (const boundary of ["plan", "retire"] as const) it(`background queued notification suppresses ${boundary} at notify getter`, async () => {
 const previous = process.env.PITHOS_GUILD_PLAN_MODE; process.env.PITHOS_GUILD_PLAN_MODE = "standalone";
 const pi = fakePi(); const {ctx, interrupts} = qualifiedBackgroundContext(pi); const gate = deferred<void>();
 let writes = 0; let armed = false; let plan = false;
 const branch = ctx.sessionManager.getBranch;
 ctx.sessionManager.getBranch = function () {return plan ? [{type: "custom", customType: "plan-theme-state", data: {active: true}}] as any : branch.call(this);};
 Object.defineProperty(ctx.ui, "notify", {get() {
  if (armed) {armed = false; if (boundary === "retire") interrupts[0](); else plan = true;}
  return () => {writes++;};
 }});
 registerGuild(pi.api as never, {run: successfulRunner,
  createExecutionRuntime: options => createGuildBackgroundRuntime({...options, runner: async request => {
   await gate.promise; return backgroundResult(request);
  }}),
 });
 try {
  await pi.handlers.get("session_start")({}, ctx);
  const {details: {runId}} = await pi.tools.get("guild_start").execute("start", {role: "coder", profile: "general", task: "Work"}, undefined, undefined, ctx);
  armed = true; gate.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes, 0); assert.equal(pi.messages.length, 0);
  assert.ok(runId);
 } finally {
  gate.resolve(); await pi.handlers.get("session_shutdown")({}, ctx);
  if (previous === undefined) delete process.env.PITHOS_GUILD_PLAN_MODE; else process.env.PITHOS_GUILD_PLAN_MODE = previous;
 }
});

it("background display ticker hides Plan rows without finishing their transcripts", async t => {
 const previous = process.env.PITHOS_GUILD_PLAN_MODE; process.env.PITHOS_GUILD_PLAN_MODE = "standalone";
 const pi = fakePi(); const {ctx} = qualifiedBackgroundContext(pi); const gate = deferred<void>();
 let tick: (() => void) | undefined; let panel: any; let plan = false;
 const interval = globalThis.setInterval;
 t.mock.method(globalThis, "setInterval", ((callback: any, delay: number, ...args: any[]) => {
  if (delay === 1000) tick = callback;
  return interval(callback, delay, ...args);
 }) as typeof setInterval);
 const branch = ctx.sessionManager.getBranch;
 ctx.sessionManager.getBranch = function () {return plan ? [...branch.call(this), {type: "custom", customType: "plan-theme-state", data: {active: true}}] as any : branch.call(this);};
 ctx.ui.setWidget = ((_key: string, value: any) => {panel = typeof value === "function" ? value({requestRender() {}, terminal: {rows: 48}}, inlineTheme) : undefined;}) as any;
 const store = new LiveTranscriptStore();
 registerGuild(pi.api as never, {run: successfulRunner, createTranscriptStore: () => store,
  createExecutionRuntime: options => createGuildBackgroundRuntime({...options, onChange: change => {
   if (change.kind === "terminal") plan = true;
   try { options.onChange?.(change); } finally { if (change.kind === "terminal") plan = false; }
  }, runner: async request => {await gate.promise; return backgroundResult(request);}}),
 });
 try {
  await pi.handlers.get("session_start")({}, ctx);
  const {details: {runId}} = await pi.tools.get("guild_start").execute("start", {role: "coder", profile: "general", task: "Work"}, undefined, undefined, ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(panel); plan = true; tick!();
  assert.equal(panel, undefined); assert.equal(store.get(runId)?.phase, "running");
  plan = false; gate.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.ok(["completed", "cancelled"].includes(store.get(runId)?.phase ?? ""));
  plan = false; tick!(); assert.equal(panel, undefined);
 } finally {
  plan = false; gate.resolve(); await pi.handlers.get("session_shutdown")({}, ctx);
  if (previous === undefined) delete process.env.PITHOS_GUILD_PLAN_MODE; else process.env.PITHOS_GUILD_PLAN_MODE = previous;
 }
});

it("manual UX help and published inventory describe conditional controls", async () => {
 const pi = fakePi(); const ctx = context(); const notices: string[] = [];
 Object.assign(ctx.ui, {notify: (text: string) => notices.push(text)});
 registerGuild(pi.api as never, {run: successfulRunner});
 await pi.commands.get("guild").handler("--help", ctx);
 for (const usage of ["/guild status [runId]", "/guild cancel <runId>", "/guild cancel-all"]) assert.ok(notices[0].includes(usage), usage);
 assert.match(notices[0], /Automatic parent continuation unavailable/);
 assert.match(pi.commands.get("guild").description, /status.*cancel/);
 const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).pithosKit;
 assert.match(metadata.commands.find((item: any) => item.name === "guild").usage, /status.*cancel/);
 for (const name of ["guild_start", "guild_status", "guild_wait", "guild_send", "guild_cancel"]) {
  assert.match(metadata.tools.find((item: any) => item.name === name)?.summary ?? "", /qualified hosts only/);
 }
});

it("manual UX status shows canonical question ID and bounded untrusted preview", async () => {
 const pi = fakePi(); const {ctx} = qualifiedBackgroundContext(pi);
 const notices: string[] = []; Object.assign(ctx.ui, {notify: (text: string) => notices.push(text)});
 const fixture = runtimeFixture(async options => {
  await options.onQuestion("\x1b[31m" + "😀".repeat(400), new AbortController().signal);
  return backgroundResult(options);
 });
 registerGuild(pi.api as never, {run: successfulRunner, createExecutionRuntime: () => fixture.runtime});
 try {
  await pi.handlers.get("session_start")({}, ctx);
  const result = await pi.tools.get("guild_start").execute("start", {role: "coder", profile: "general", task: "Work"}, undefined, undefined, ctx);
  const snapshot = fixture.runtime.status(fixture.owner, result.details.runId);
  await pi.commands.get("guild").handler(`status ${result.details.runId}`, ctx);
  const text = notices.at(-1)!;
  assert.ok(text.includes(snapshot.question!.id));
  assert.match(text, /untrusted preview/);
  assert.doesNotMatch(text, /\x1b/);
  const preview = text.split("untrusted preview: ")[1].split("\n")[0];
  assert.ok(Buffer.byteLength(preview) <= 512);
  assert.ok(Buffer.byteLength(text) <= 8192);
  assert.equal(pi.messages.length, 0);
 } finally {await pi.handlers.get("session_shutdown")({}, ctx);}
});

it("manual UX cancel-all notification navigation cannot cancel the captured owner", async () => {
 const pi = fakePi(); const {ctx} = qualifiedBackgroundContext(pi);
 const gate = deferred<void>();
 const fixture = runtimeFixture(async options => {await gate.promise; return backgroundResult(options);});
 registerGuild(pi.api as never, {run: successfulRunner, createExecutionRuntime: () => fixture.runtime});
 try {
  await pi.handlers.get("session_start")({}, ctx);
  await pi.tools.get("guild_start").execute("start", {role: "coder", profile: "general", task: "Work"}, undefined, undefined, ctx);
  Object.assign(ctx.ui, {notify: () => {ctx.cwd = "/other";}});
  await pi.commands.get("guild").handler("cancel-all", ctx);
  assert.equal(fixture.runtime.isCurrent(fixture.owner), true);
  assert.equal(fixture.activations, 1);
  assert.equal(pi.messages.length, 0);
 } finally {ctx.cwd = "/project"; gate.resolve(); await pi.handlers.get("session_shutdown")({}, ctx);}
});

for (const failUnbind of [false, true]) it(`shutdown retains background recorder through cleanup (unbind failure: ${failUnbind})`, async () => {
 const previous = process.env.PITHOS_GUILD_PLAN_MODE; process.env.PITHOS_GUILD_PLAN_MODE = "standalone";
 const pi = fakePi(); const {ctx} = qualifiedBackgroundContext(pi);
 Object.assign(ctx.sessionManager, {getSessionDir: () => "/tmp/guild-trace-test"});
 const gate = deferred<void>(); const order: string[] = []; let disposed = false;
 registerGuild(pi.api as never, {run: successfulRunner,
  createTraceRecorder: () => ({bind() {return () => {order.push("unbind"); if (failUnbind) throw new Error("unbind fault");};},
   dispose() {disposed = true; order.push("dispose");}}),
  createExecutionRuntime: options => createGuildBackgroundRuntime({...options, runner: async request => {
   await gate.promise;
   order.push("child-close");
   assert.equal(disposed, false, "recorder still captures final child end");
   order.push("end");
   return backgroundResult(request);
  }}),
 });
 let shutdown: Promise<void> | undefined;
 try {
  await pi.handlers.get("session_start")({}, ctx);
  await pi.tools.get("guild_start").execute("start", {role: "coder", profile: "general", task: "Work"}, undefined, undefined, ctx);
  shutdown = pi.handlers.get("session_shutdown")({}, ctx);
  void shutdown!.catch(() => {});
  assert.equal(pi.handlers.get("session_shutdown")({}, ctx), shutdown);
  assert.equal(disposed, false, "recorder must not dispose while cleanup is held");
  gate.resolve();
  if (failUnbind) await assert.rejects(shutdown!, /Guild shutdown cleanup failed/);
  else await shutdown;
  assert.deepEqual(order, ["child-close", "end", "unbind", "dispose"]);
 } finally {
  gate.resolve(); await shutdown?.catch(() => {});
  if (previous === undefined) delete process.env.PITHOS_GUILD_PLAN_MODE; else process.env.PITHOS_GUILD_PLAN_MODE = previous;
 }
});

it("stock manual status explains both missing background host contracts", async () => {
 const pi = fakePi(); const ctx = context(); const notices: string[] = [];
 Object.assign(ctx.ui, {notify: (text: string) => notices.push(text)});
 registerGuild(pi.api as never, {run: successfulRunner});
 await pi.handlers.get("session_start")({}, ctx);
 await pi.commands.get("guild").handler("status", ctx);
 assert.match(notices.at(-1)!, /semanticInterrupt-v1/);
 assert.match(notices.at(-1)!, /atomic-owned-tools-v1/);
 await pi.handlers.get("session_shutdown")({}, ctx);
});

it("provider atomic retirement closes the runtime owner synchronously", async () => {
 const pi = fakePi(); const {ctx, retireAtomic} = qualifiedBackgroundContext(pi);
 registerGuild(pi.api as never, {run: successfulRunner});
 await pi.handlers.get("session_start")({}, ctx);
 const cached = pi.tools.get("guild_status"); assert.ok(cached);
 retireAtomic();
 const result = await pi.tool.execute("retired", {role: "explorer", profile: "general", task: "old owner"}, undefined, undefined, ctx);
 assert.equal(result.details.status, "cancelled");
 await assert.rejects(cached.execute("old", {}, undefined, undefined, ctx), /unavailable/);
 await pi.handlers.get("session_shutdown")({}, ctx);
});

it("atomic qualification never substitutes for the independent semantic interrupt binding", async () => {
 const pi = fakePi(); const {ctx} = qualifiedBackgroundContext(pi);
 delete (ctx.ui as any).semanticInterrupt;
 registerGuild(pi.api as never, {run: successfulRunner});
 await pi.handlers.get("session_start")({}, ctx);
 assert.deepEqual([...pi.tools.keys()].sort(), ["create_commit", "guild_handover"]);
 assert.equal((await pi.tool.execute("legacy", {role: "explorer", profile: "general", task: "legacy"}, undefined, undefined, ctx)).details.status, "completed");
 await pi.handlers.get("session_shutdown")({}, ctx);
});

it("atomic registration faults close admission and surface bounded manual status", async () => {
 const pi = fakePi(); const {ctx} = qualifiedBackgroundContext(pi);
 const notices: string[] = []; Object.assign(ctx.ui, {notify: (text: string) => notices.push(text)});
 const capability = (pi.api as any).atomicOwnedTools, bind = capability.bind;
 let abort = false;
 capability.bind = (...args: any[]) => {
  const handle = bind(...args);
  return {...handle, update: (batch: any[]) => abort ? {status: "aborted", reason: "prepare-failed"} : handle.update(batch)};
 };
 registerGuild(pi.api as never, {run: successfulRunner});
 await pi.handlers.get("session_start")({}, ctx);
 const cached = pi.tools.get("guild_status"); assert.ok(cached);
 abort = true;
 await pi.handlers.get("input")({source: "interactive", text: "fresh"}, ctx);
 await assert.rejects(cached.execute("cached", {}, undefined, undefined, ctx), /unavailable/);
 assert.equal((await pi.tool.execute("closed", {role: "explorer", profile: "general", task: "closed"}, undefined, undefined, ctx)).details.status, "cancelled");
 await pi.commands.get("guild").handler("status", ctx);
 assert.match(notices.at(-1)!, /Registration\/withdrawal fault; admission closed/);
 assert.ok(Buffer.byteLength(notices.at(-1)!) < 8192);
 await assert.rejects(pi.handlers.get("session_shutdown")({}, ctx), /Guild shutdown cleanup failed/);
});

function continuationHost(options: {busyFirst?: boolean; committed?: "committed" | "unknown" | Promise<unknown>; started?: Promise<boolean>; finished?: Promise<unknown>; closed?: Promise<void>; onClose?: () => void} = {}) {
 const leases: Array<{closed: ReturnType<typeof deferred<void>>; closeCount: number; idle: () => void; notices: string[]}> = [];
 const capability = {protocol: "pi-parent-continuation-v1", open() {
  assert.equal(this, capability);
  const state = {closed: deferred<void>(), closeCount: 0, idle: () => {}, notices: [] as string[]};
  leases.push(state);
  return {closed: leases.length === 1 && options.closed ? options.closed : state.closed.promise, close() {state.closeCount++; options.onClose?.(); state.closed.resolve();},
   onIdle(callback: () => void) {state.idle = callback;},
   tryAccept(_sequence: number, text: string) {
    if (options.busyFirst) {options.busyFirst = false; return {status: "busy"};}
    state.notices.push(text);
    return {status: "accepted", receipt: {revoke() {}, committed: Promise.resolve(options.committed ?? "committed"), started: options.started ?? Promise.resolve(true),
     finished: options.finished ?? Promise.resolve({outcome: "completed", commitState: "committed", started: true})}};
   }};
 }};
 return {capability, leases};
}

it("continuation binds only fresh safe input capability under a busy input hold", async () => {
 const previous = process.env.PITHOS_GUILD_PLAN_MODE; process.env.PITHOS_GUILD_PLAN_MODE = "standalone";
 const pi = fakePi(); const {ctx} = qualifiedBackgroundContext(pi); const host = continuationHost();
 const transitional = {...ctx, parentContinuation: {protocol: "pi-parent-continuation-v1", open() {assert.fail("transition context opened");}}};
 const fresh = {...ctx, isIdle: () => false, parentContinuation: host.capability};
 registerGuild(pi.api as never, {run: successfulRunner,
  createExecutionRuntime: options => createGuildBackgroundRuntime({...options, parentEnvironment: {PITHOS_GUILD_PLAN_MODE: "standalone"}})});
 try {
  await pi.handlers.get("session_start")({}, transitional);
  await pi.handlers.get("input")({source: "extension", text: "hello"}, fresh);
  assert.equal(host.leases.length, 0);
  await pi.handlers.get("input")({source: "interactive", text: "hello"}, fresh);
  assert.equal(host.leases.length, 1);
  await pi.handlers.get("input")({source: "rpc", text: "hello"}, fresh);
  assert.equal(host.leases.length, 1, "healthy lease survives ordinary input");
 } finally {await pi.handlers.get("session_shutdown")({}, ctx);}
 if (previous === undefined) delete process.env.PITHOS_GUILD_PLAN_MODE; else process.env.PITHOS_GUILD_PLAN_MODE = previous;
 assert.equal(host.leases[0]?.closeCount, 1);
});

it("continuation coalesces three questions independently of UI and delivers terminals only after cleanup without collecting", async () => {
 const previous = process.env.PITHOS_GUILD_PLAN_MODE; process.env.PITHOS_GUILD_PLAN_MODE = "standalone";
 const pi = fakePi(); const {ctx} = qualifiedBackgroundContext(pi); const host = continuationHost();
 Object.assign(ctx, {parentContinuation: host.capability});
 const ask = deferred<void>(); const cleanup = deferred<void>(); let runtime!: GuildExecutionRuntime; let owner!: GuildOwner;
 registerGuild(pi.api as never, {run: successfulRunner, createExecutionRuntime: options => {
  const actual = createGuildBackgroundRuntime({...options, runner: async request => {
   await ask.promise; await request.onQuestion(`Question ${request.task}`, request.signal!);
   await cleanup.promise; return backgroundResult(request);
  }});
  runtime = {...actual, activate() {return owner = actual.activate();}}; return runtime;
 }});
 try {
  await pi.handlers.get("session_start")({}, ctx);
  await pi.handlers.get("input")({source: "rpc", text: "work"}, ctx);
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
   const result = await pi.tools.get("guild_start").execute(`start-${i}`, {role: "coder", profile: "general", task: `${i}`}, undefined, undefined, ctx);
   ids.push(result.details.runId);
  }
  ask.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.leases[0].notices.length, 1);
  const batch = JSON.parse(host.leases[0].notices[0]);
  assert.equal(batch.items.length, 3); assert.ok(batch.items.every((item: any) => item.kind === "question"));
  // Ordinary append and input must not rotate the model delivery scope.
  pi.api.appendEntry("ordinary-append", {});
  await pi.handlers.get("input")({source: "interactive", text: "continue"}, ctx);
  assert.equal(host.leases.length, 1);
  for (const id of ids) runtime.reply(owner, id, runtime.status(owner, id).question!.id, "yes");
  host.leases[0].idle(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.leases[0].notices.length, 1, "no terminal before child cleanup");
  cleanup.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.leases[0].notices.length, 2);
  assert.ok(JSON.parse(host.leases[0].notices[1]).items.every((item: any) => item.kind === "terminal" && item.eventId === `${item.runId}:terminal`));
  assert.equal(pi.entries.some(entry => entry.data?.kind === "collected"), false);
  assert.equal(pi.messages.length, 0, "no sendMessage fallback");
 } finally {
  ask.resolve(); cleanup.resolve(); await pi.handlers.get("session_shutdown")({}, ctx);
  if (previous === undefined) delete process.env.PITHOS_GUILD_PLAN_MODE; else process.env.PITHOS_GUILD_PLAN_MODE = previous;
 }
});

for (const stage of ["accepted", "preparing", "started", "cleanup"] as const) it(`continuation Plan prehold refuses owned parent work without cancelling and fresh input alone reopens an empty buffer (${stage})`, async () => {
 const {createPlanCoordinator} = await import("../../pithos.plan/extensions/plan-coordination.ts");
 const coordinator = createPlanCoordinator(); coordinator.confirmInactive(coordinator.provider.inspect().generation);
 const pi = fakePi(); const {ctx} = qualifiedBackgroundContext(pi);
 pi.api.events.on("pithos.plan.coordination", request => request.reply(coordinator.provider));
 const finished = deferred<unknown>(); const child = deferred<void>();
 const commit = deferred<unknown>(); const start = deferred<boolean>();
 const host = continuationHost({finished: finished.promise,
  ...(["accepted", "preparing"].includes(stage) ? {committed: commit.promise, started: start.promise} : {})});
 Object.assign(ctx, {parentContinuation: host.capability}); let signal!: AbortSignal;
 registerGuild(pi.api as never, {run: successfulRunner, createExecutionRuntime: options => createGuildBackgroundRuntime({...options,
  runner: async request => {signal = request.signal!; await child.promise; return backgroundResult(request);}})});
 const enter = () => coordinator.transition(coordinator.provider.inspect().generation, "active");
 try {
  await pi.handlers.get("session_start")({}, ctx);
  await pi.handlers.get("input")({source: "rpc", text: "work"}, ctx);
  await pi.tools.get("guild_start").execute("start", {role: "coder", profile: "general", task: "Work"}, undefined, undefined, ctx);
  assert.equal(enter().kind, "blocked"); assert.equal(signal.aborted, false); assert.equal(host.leases[0].closeCount, 0);
  child.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.leases[0].notices.length, 1);
  assert.equal(enter().kind, "blocked", "terminal child does not make unfinished parent work idle");
  assert.equal(host.leases[0].closeCount, 0);
  commit.resolve("committed"); start.resolve(true); finished.resolve({outcome: "completed", commitState: "committed", started: true});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(enter().kind, "ok"); assert.equal(host.leases[0].closeCount, 1);
  coordinator.confirmInactive(coordinator.provider.inspect().generation);
  host.leases[0].idle(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.leases.length, 1);
  await pi.handlers.get("input")({source: "extension", text: "notice"}, ctx);
  assert.equal(host.leases.length, 1);
  await pi.handlers.get("input")({source: "interactive", text: "next"}, ctx);
  assert.equal(host.leases.length, 2);
  assert.deepEqual(host.leases[1].notices, []);
 } finally {
  child.resolve(); commit.resolve("committed"); start.resolve(true); finished.resolve({outcome: "completed", commitState: "committed", started: true});
  await pi.handlers.get("session_shutdown")({}, ctx);
 }
});

it("continuation opening reentry retains parent cleanup before rearm or Plan even after child authority drains", async () => {
 const previous = process.env.PITHOS_GUILD_PLAN_MODE; process.env.PITHOS_GUILD_PLAN_MODE = "standalone";
 const pi = fakePi(); const {ctx, interrupts} = qualifiedBackgroundContext(pi); const closed = deferred<void>();
 const host = continuationHost({closed: closed.promise}); const open = host.capability.open;
 let interrupted = false; let runtime!: GuildExecutionRuntime; let activations = 0;
 host.capability.open = function() {const lease = open.call(this); if (!interrupted) {interrupted = true; interrupts[0]();} return lease;};
 Object.assign(ctx, {parentContinuation: host.capability});
 registerGuild(pi.api as never, {run: successfulRunner, createExecutionRuntime: options => {
  const actual = createGuildBackgroundRuntime(options);
  runtime = {...actual, activate() {activations++; return actual.activate();}}; return runtime;
 }});
 try {
  await pi.handlers.get("session_start")({}, ctx);
  await pi.handlers.get("input")({source: "rpc", text: "work"}, ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.leases[0].closeCount, 1);
  assert.equal(runtime.planParticipant.tryAcquire({}).kind, "unavailable", "retired scope still owns parent cleanup");
  await pi.handlers.get("input")({source: "rpc", text: "too soon"}, ctx);
  assert.equal(activations, 1);
  closed.resolve(); await new Promise(resolve => setImmediate(resolve));
  host.leases[0].idle(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(activations, 1);
  await pi.handlers.get("input")({source: "rpc", text: "fresh"}, ctx);
  assert.equal(activations, 2); assert.equal(host.leases.length, 2);
 } finally {
  closed.resolve(); await pi.handlers.get("session_shutdown")({}, ctx);
  if (previous === undefined) delete process.env.PITHOS_GUILD_PLAN_MODE; else process.env.PITHOS_GUILD_PLAN_MODE = previous;
 }
});

it("continuation absent or incompatible capability preserves idle Plan admission after fresh input", async () => {
 for (const capability of [undefined, {protocol: "other-protocol", open() {assert.fail("incompatible open");}}, {protocol: "pi-parent-continuation-v1", open: undefined}]) {
  const {createPlanCoordinator} = await import("../../pithos.plan/extensions/plan-coordination.ts");
  const coordinator = createPlanCoordinator(); coordinator.confirmInactive(coordinator.provider.inspect().generation);
  const pi = fakePi(); const {ctx} = qualifiedBackgroundContext(pi);
  Object.assign(ctx, {parentContinuation: capability});
  pi.api.events.on("pithos.plan.coordination", request => request.reply(coordinator.provider));
  registerGuild(pi.api as never, {run: successfulRunner});
  try {
   await pi.handlers.get("session_start")({}, ctx);
   await pi.handlers.get("input")({source: "rpc", text: "work"}, ctx);
   assert.ok(pi.api.getActiveTools().includes("guild_start"));
   assert.equal(coordinator.transition(coordinator.provider.inspect().generation, "active").kind, "ok");
   assert.equal(pi.messages.length, 0);
  } finally {await pi.handlers.get("session_shutdown")({}, ctx);}
 }
});

it("continuation manual status and help report available recovery and Plan pause truthfully", async () => {
 const {createPlanCoordinator} = await import("../../pithos.plan/extensions/plan-coordination.ts");
 const coordinator = createPlanCoordinator(); coordinator.confirmInactive(coordinator.provider.inspect().generation);
 const pi = fakePi(); const {ctx} = qualifiedBackgroundContext(pi); const notices: string[] = [];
 ctx.ui.notify = ((text: string) => {notices.push(text);}) as never;
 pi.api.events.on("pithos.plan.coordination", request => request.reply(coordinator.provider));
 const host = continuationHost({committed: "unknown"}); Object.assign(ctx, {parentContinuation: host.capability});
 registerGuild(pi.api as never, {run: successfulRunner, createExecutionRuntime: options => createGuildBackgroundRuntime({...options,
  runner: async request => backgroundResult(request)})});
 const status = async (args = "status") => {await pi.commands.get("guild").handler(args, ctx); return notices.at(-1)!;};
 try {
  await pi.handlers.get("session_start")({}, ctx);
  assert.match(await status(), /Automatic parent continuation unavailable/);
  await pi.handlers.get("input")({source: "rpc", text: "work"}, ctx);
  assert.match(await status(), /Automatic parent continuation available/);
  await status("--help"); assert.match(pi.messages.at(-1)?.message.content ?? notices.at(-1), /Automatic parent continuation available/);
  await pi.tools.get("guild_start").execute("start", {role: "coder", profile: "general", task: "Work"}, undefined, undefined, ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(await status(), /Automatic parent continuation recovery-required/);
  assert.equal(coordinator.transition(coordinator.provider.inspect().generation, "active").kind, "ok");
  assert.match(await status(), /Automatic parent continuation paused/);
 } finally {await pi.handlers.get("session_shutdown")({}, ctx);}
});

for (const stage of ["accepted", "preparing", "started"] as const) it(`continuation interrupt fences delivery and all children while held parent cleanup blocks rearm without self-joining (${stage})`, async () => {
 const previous = process.env.PITHOS_GUILD_PLAN_MODE; process.env.PITHOS_GUILD_PLAN_MODE = "standalone";
 const pi = fakePi(); const {ctx, interrupts} = qualifiedBackgroundContext(pi);
 const parentCleanup = deferred<void>(); const childCleanup = deferred<void>(); const finished = deferred<unknown>();
 const commit = deferred<unknown>(); const started = deferred<boolean>();
 const host = continuationHost({closed: parentCleanup.promise, finished: finished.promise,
  ...(stage === "started" ? {} : {committed: commit.promise, started: started.promise})});
 Object.assign(ctx, {parentContinuation: host.capability});
 const launched: AbortSignal[] = []; let activations = 0;
 registerGuild(pi.api as never, {run: successfulRunner, createExecutionRuntime: options => {
  const actual = createGuildBackgroundRuntime({...options, runner: async request => {
   launched.push(request.signal!);
   try {await request.onQuestion("Continue?", request.signal!);} catch {}
   await childCleanup.promise; return backgroundResult(request);
  }});
  return {...actual, activate() {activations++; return actual.activate();}};
 }});
 try {
  await pi.handlers.get("session_start")({}, ctx);
  await pi.handlers.get("input")({source: "rpc", text: "work"}, ctx);
  for (let i = 0; i < 5; i++) await pi.tools.get("guild_start").execute(`start-${i}`, {role: "coder", profile: "general", task: `${i}`}, undefined, undefined, ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(launched.length, 3); assert.equal(host.leases[0].notices.length, 1);
  const callback = interrupts[0]();
  assert.equal(await Promise.race([Promise.resolve(callback).then(() => "returned"), new Promise(resolve => setImmediate(() => resolve("blocked")))]), "returned", "semantic callback must not await owned parent cleanup");
  assert.equal(host.leases[0].closeCount, 1);
  assert.ok(launched.every(signal => signal.aborted));
  childCleanup.resolve(); commit.resolve(stage === "started" ? "committed" : "none"); started.resolve(stage === "started");
  finished.resolve({outcome: "revoked", commitState: stage === "started" ? "committed" : "none", started: stage === "started"});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(launched.length, 3, "queued children never launch");
  await pi.handlers.get("input")({source: "rpc", text: "too early"}, ctx);
  assert.equal(activations, 1);
  parentCleanup.resolve(); await new Promise(resolve => setImmediate(resolve));
  host.leases[0].idle(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(activations, 1);
  await pi.handlers.get("input")({source: "rpc", text: "fresh"}, ctx);
  assert.equal(activations, 2); assert.equal(host.leases.length, 2);
  host.leases[0].idle(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.leases[1].closeCount, 0); assert.deepEqual(host.leases[1].notices, []);
 } finally {
  childCleanup.resolve(); parentCleanup.resolve(); commit.resolve("none"); started.resolve(false); finished.resolve({outcome: "revoked", commitState: "none", started: false});
  await pi.handlers.get("session_shutdown")({}, ctx);
  if (previous === undefined) delete process.env.PITHOS_GUILD_PLAN_MODE; else process.env.PITHOS_GUILD_PLAN_MODE = previous;
 }
});

it("continuation dashboard identifies optional model delivery while retaining child progress", async () => {
 const previous = process.env.PITHOS_GUILD_PLAN_MODE; process.env.PITHOS_GUILD_PLAN_MODE = "standalone";
 const pi = fakePi(); const {ctx} = qualifiedBackgroundContext(pi); const host = continuationHost();
 Object.assign(ctx, {parentContinuation: host.capability}); const child = deferred<void>(); let panel: any;
 ctx.ui.setWidget = ((_key: string, value: any) => {panel = typeof value === "function" ? value({requestRender() {}, terminal: {rows: 48}}, inlineTheme) : undefined;}) as any;
 registerGuild(pi.api as never, {run: successfulRunner, createExecutionRuntime: options => createGuildBackgroundRuntime({...options,
  runner: async request => {await child.promise; return backgroundResult(request);}})});
 try {
  await pi.handlers.get("session_start")({}, ctx);
  await pi.handlers.get("input")({source: "rpc", text: "work"}, ctx);
  await pi.tools.get("guild_start").execute("start", {role: "coder", profile: "general", task: "Work"}, undefined, undefined, ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(panel.render(200).join("\n"), /Automatic parent continuation available/);
  assert.match(panel.render(200).join("\n"), /1 occupied/);
 } finally {
  child.resolve(); await pi.handlers.get("session_shutdown")({}, ctx);
  if (previous === undefined) delete process.env.PITHOS_GUILD_PLAN_MODE; else process.env.PITHOS_GUILD_PLAN_MODE = previous;
 }
});

it("continuation Plan close reentry cannot grant a stale hold or revive delivery", async () => {
 const {createPlanCoordinator} = await import("../../pithos.plan/extensions/plan-coordination.ts");
 const coordinator = createPlanCoordinator(); coordinator.confirmInactive(coordinator.provider.inspect().generation);
 const pi = fakePi(); const {ctx, interrupts} = qualifiedBackgroundContext(pi);
 pi.api.events.on("pithos.plan.coordination", request => request.reply(coordinator.provider));
 const host = continuationHost({onClose: () => interrupts[0]()}); Object.assign(ctx, {parentContinuation: host.capability});
 registerGuild(pi.api as never, {run: successfulRunner});
 try {
  await pi.handlers.get("session_start")({}, ctx);
  await pi.handlers.get("input")({source: "rpc", text: "work"}, ctx);
  assert.equal(coordinator.transition(coordinator.provider.inspect().generation, "active").kind, "blocked");
  assert.equal(host.leases[0].closeCount, 1);
  host.leases[0].idle(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.leases.length, 1);
  assert.equal(pi.api.getActiveTools().includes("guild_start"), false);
 } finally {await pi.handlers.get("session_shutdown")({}, ctx);}
});

it("continuation canonical validation prunes a stale question without starving a valid terminal or claiming usage", async () => {
 const {createPlanCoordinator} = await import("../../pithos.plan/extensions/plan-coordination.ts");
 const coordinator = createPlanCoordinator(); coordinator.confirmInactive(coordinator.provider.inspect().generation);
 const pi = fakePi(); const {ctx} = qualifiedBackgroundContext(pi); const host = continuationHost({busyFirst: true});
 Object.assign(ctx, {parentContinuation: host.capability});
 let invalidate: (() => void) | undefined;
 pi.api.events.on("pithos.plan.coordination", request => {const change = invalidate; invalidate = undefined; change?.(); request.reply(coordinator.provider);});
 const cleanup = deferred<void>(); let runtime!: GuildExecutionRuntime; let owner!: GuildOwner;
 registerGuild(pi.api as never, {run: successfulRunner, createExecutionRuntime: options => {
  const actual = createGuildBackgroundRuntime({...options, runner: async request => {
   if (request.task === "question") {try {await request.onQuestion("Continue?", request.signal!);} catch {} await cleanup.promise;}
   return {...backgroundResult(request), providerUsage: {input: 4, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 6,
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}};
  }});
  runtime = {...actual, activate() {return owner = actual.activate();}}; return runtime;
 }});
 const start = async (task: string) => (await pi.tools.get("guild_start").execute(task, {role: "coder", profile: "general", task}, undefined, undefined, ctx)).details.runId;
 try {
  await pi.handlers.get("session_start")({}, ctx);
  await pi.handlers.get("input")({source: "rpc", text: "work"}, ctx);
  const question = await start("question"); await new Promise(resolve => setImmediate(resolve));
  const terminal = await start("terminal"); await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.leases[0].notices.length, 0);
  invalidate = () => runtime.reply(owner, question, runtime.status(owner, question).question!.id, "yes");
  host.leases[0].idle(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.leases[0].notices.length, 1);
  assert.deepEqual(JSON.parse(host.leases[0].notices[0]).items.map((item: any) => [item.runId, item.kind]), [[terminal, "terminal"]]);
  assert.equal(pi.entries.some(entry => entry.data?.kind === "collected"), false);
  const wait = () => pi.tools.get("guild_wait").execute("wait", {runId: terminal}, undefined, undefined, ctx);
  assert.equal((await wait()).usage.totalTokens, 6); assert.equal((await wait()).usage, undefined);
 } finally {cleanup.resolve(); await pi.handlers.get("session_shutdown")({}, ctx);}
});

for (const lifecycle of ["session_before_tree", "session_shutdown"] as const) it(`continuation ${lifecycle} waits for owned lease cleanup outside its synchronous fence`, async () => {
 const previous = process.env.PITHOS_GUILD_PLAN_MODE; process.env.PITHOS_GUILD_PLAN_MODE = "standalone";
 const pi = fakePi(); const {ctx} = qualifiedBackgroundContext(pi); const closed = deferred<void>();
 const host = continuationHost({closed: closed.promise}); Object.assign(ctx, {parentContinuation: host.capability});
 registerGuild(pi.api as never, {run: successfulRunner});
 try {
  await pi.handlers.get("session_start")({}, ctx);
  await pi.handlers.get("input")({source: "rpc", text: "work"}, ctx);
  let settled = false;
  const join = Promise.resolve(pi.handlers.get(lifecycle)({}, ctx)).then(() => {settled = true;});
  assert.equal(host.leases[0].closeCount, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  host.leases[0].idle();
  await pi.handlers.get("input")({source: "rpc", text: "too early"}, ctx);
  assert.equal(host.leases.length, 1);
  closed.resolve(); await join;
  assert.equal(settled, true);
 } finally {
  closed.resolve(); await pi.handlers.get("session_shutdown")({}, ctx);
  if (previous === undefined) delete process.env.PITHOS_GUILD_PLAN_MODE; else process.env.PITHOS_GUILD_PLAN_MODE = previous;
 }
});
