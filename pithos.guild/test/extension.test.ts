import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import { describe, it } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { Check } from "typebox/value";
import {
  GUILD_MEMBER_ALIASES,
  GUILD_PROFILES,
  GUILD_ROLE_DEFINITIONS,
  GUILD_ROLES,
  createGuildTarget,
} from "../src/agents";
import { registerGuild, type GuildDependencies } from "../src/guild";
import type { GuildRoleRunResult, RunGuildRoleOptions } from "../src/runner";

import { renderReport, validateResult } from "../src/protocol.ts";
import { buildTask, report } from "./protocol-fixtures.ts";

initTheme();

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
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, any>();
  const messages: Array<{ message: any; options: any }> = [];
  const messageRenderers = new Map<string, any>();
  return {
    api: {
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
        handlers.set(name, handler);
      },
    },
    get tool() {
      return tools.get("guild_handover");
    },
    tools,
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
  return GUILD_ROLES.flatMap((role) =>
    GUILD_PROFILES.map((profile) => createGuildTarget(role, profile)));
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
    assert.equal(completions.length, 33);
    assert.deepEqual(completions.slice(0, 24).map((item: any) => item.value), canonicalTargets());
    assert.deepEqual(completions.slice(24).map((item: any) => item.value), aliases.map(([alias]) => alias));
    aliases.forEach(([, target], index) => {
      assert.match(completions[index + 24].description, new RegExp(target.replace("/", "\\/")));
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
        assert.doesNotMatch(visible, /Implement validation|openai-codex|read, grep/);
        options.onUpdate?.(resultFor(options, {
          output: "Working",
          activity: "Running verification",
          activityTool: "bash",
        }));
        return resultFor(options);
      },
    });
    const ctx: any = context();
    ctx.ui.setWidget = (_key: string, value: any) => {
      const rendered = typeof value === "function"
        ? value(
          { requestRender: () => undefined },
          {
            name: "test-light",
            fg: (_color: string, text: string) => text,
            bg: (_color: string, text: string) => text,
            bold: (text: string) => text,
            getBgAnsi: () => "\u001b[48;2;223;236;243m",
            getColorMode: () => "truecolor",
          },
        ).render(120)
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

  it("uses a role picker, then profile picker, then multiline editor when direct arguments are omitted", async () => {
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
      return pickerTitles.length === 1 ? choices[2] : pickerTitles.length === 2 ? choices[3] : choices[0];
    };
    ctx.ui.editor = async (title: string) => {
      editorTitle = title;
      return "  Implement typed boundaries  ";
    };

    await pi.commands.get("guild-handover").handler("", ctx);

    assert.deepEqual(pickerTitles, ["Choose a Guild role", "Choose a Guild profile", "Choose coder practice"]);
    assert.equal(pickerChoices[0].length, 4);
    assert.equal(pickerChoices[1].length, 6);
    assert.match(pickerChoices[0][0], /^explorer \[read-only\]/);
    assert.match(pickerChoices[0][2], /^coder \[write-enabled\]/);
    assert.match(editorTitle, /coder\/typescript/);
    assert.equal(received?.role, "coder");
    assert.equal(received?.profile, "typescript");
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
      [...roster.matchAll(/^- (explorer|architect|coder|reviewer) \[(.+?)\]/gm)].map((match) => [match[1], match[2]]),
      [
        ["explorer", "read-only"],
        ["architect", "read-only"],
        ["coder", "write-enabled"],
        ["reviewer", "read-only review"],
      ],
    );
    assert.deepEqual(
      [...roster.matchAll(/^- (general|frontend|angular|typescript|dotnet|rust) —/gm)].map((match) => match[1]),
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
 registerGuild(pi.api as never, {run: async options => { events.push(`run:${options.runId}`); return resultFor(options); }, createTraceRecorder: () => { created++; return traceRecorder; }});
 const sessionManager = {getBranch: () => [], getSessionDir: () => "/sessions/project", getSessionId: () => "session-7", getSessionFile: () => "/sessions/project/s.jsonl"};
 assert.equal(created, 0);
 await pi.handlers.get("session_start")({reason: "startup"}, context({sessionManager}));
 await pi.handlers.get("session_start")({reason: "reload"}, context({sessionManager}));
 assert.equal(created, 1);
 await pi.tool.execute("tool-call-1", {role: "coder", profile: "general", task: "Work"}, undefined, undefined, context({sessionManager}));
 assert.deepEqual(events, ["bind:tool-call-1", "run:tool-call-1", "unbind:tool-call-1"]);
 assert.deepEqual(bindings[0].binding, {sessionDir: "/sessions/project", sessionId: "session-7", sessionFile: "/sessions/project/s.jsonl", model: "openai-codex/gpt-5.6-sol", thinkingLevel: "xhigh"});
 await pi.commands.get("guild-handover").handler("coder/general Work", context({sessionManager}));
 assert.equal(bindings.length, 2);
 assert.equal(bindings[1].binding.sessionId, "session-7");
 await pi.handlers.get("session_shutdown")({reason: "quit"}, context({sessionManager}));
 assert.equal(events.at(-1), "dispose");
 await pi.handlers.get("session_start")({reason: "new"}, context({sessionManager}));
 assert.equal(created, 2);
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
  assert.equal(calls, stopAt === "queued" ? 0 : 1);
 }
});
