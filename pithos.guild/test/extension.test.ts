import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { GuildRunResult } from "../src/runner";
import { registerGuild, type GuildDependencies } from "../src/guild";

initTheme();

function successfulResult(source: "builtin" | "user" | "project" = "builtin"): GuildRunResult {
  return {
    member: "csharp-coder",
    memberSource: source,
    task: "Implement validation",
    output: "### Status\nCompleted",
    exitCode: 0,
    stderr: "",
    model: "gpt-5.6-sol",
    stopReason: "stop",
    activity: "Completed",
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 3, turns: 1 },
  };
}

function builtInCoder() {
  return {
    name: "csharp-coder" as const,
    description: "C# coder",
    tools: ["read", "grep", "find", "ls", "edit", "write", "bash"],
    systemPrompt: "Implement C#.",
    source: "builtin" as const,
    filePath: "/package/agents/csharp-coder.md",
  };
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

async function runCustom<T>(factory: (tui: any, theme: any, keybindings: any, done: (value: T) => void) => any): Promise<T> {
  let component: any;
  try {
    return await new Promise<T>((resolve) => {
      component = factory(
        { requestRender: () => undefined },
        { fg: (_color: string, text: string) => text, bold: (text: string) => text },
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
    waitForIdle: async () => undefined,
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

describe("guild extension", () => {
  it("registers the Guild tool, roster command, and direct handover command without legacy public identifiers", () => {
    const pi = fakePi();
    registerGuild(pi.api as never, {
      discover: () => ({ members: [], warnings: [] }),
      run: async () => successfulResult(),
    });

    assert.equal(pi.tool.name, "guild_handover");
    assert.match(pi.tool.description, /guild member/i);
    assert.deepEqual(Object.keys(pi.tool.parameters.properties), ["member", "task"]);
    assert.equal(typeof pi.tool.renderCall, "function");
    assert.equal(typeof pi.tool.renderResult, "function");
    assert.ok(pi.commands.has("guild"));
    assert.ok(pi.commands.has("guild-handover"));
    assert.equal(pi.commands.has("specialists"), false);

    const handover = pi.commands.get("guild-handover");
    assert.match(handover.description, /directly/i);
    assert.deepEqual(
      handover.getArgumentCompletions("").map((item: any) => item.value),
      ["dotnet-architect", "frontend-architect", "typescript-architect", "csharp-coder", "angular-coder", "typescript-coder", "rust-coder", "rust-architect", "code-reviewer"],
    );
    assert.deepEqual(
      handover.getArgumentCompletions("csharp").map((item: any) => item.value),
      ["csharp-coder"],
    );
    assert.equal(handover.getArgumentCompletions("csharp-coder "), null);
  });

  it("registers Guild as the confirmed commit workflow owner", async () => {
    const pi = fakePi();
    registerGuild(pi.api as never, {
      discover: () => ({ members: [], warnings: [] }),
      run: async () => successfulResult(),
    });

    assert.ok(pi.commands.has("commit"));
    assert.ok(pi.tools.has("create_commit"));
    assert.ok(pi.handlers.has("input"));
    assert.ok(pi.handlers.has("tool_call"));

    const notifications: string[] = [];
    await pi.commands.get("commit").handler("--help", context({
      isIdle: () => true,
      sessionManager: { getBranch: () => [] },
      ui: { ...context().ui, notify: (message: string) => notifications.push(message) },
    }));

    assert.equal(pi.messages.length, 0);
    assert.match(notifications[0] ?? "", /Usage: \/commit \[instructions\]/);
  });

  it("handles conventional-commit skill help without starting an agent turn", async () => {
    const pi = fakePi();
    registerGuild(pi.api as never, {
      discover: () => ({ members: [], warnings: [] }),
      run: async () => successfulResult(),
    });
    const notifications: string[] = [];
    const ctx = context({
      ui: { ...context().ui, notify: (message: string) => notifications.push(message) },
    });

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
    registerGuild(pi.api as never, {
      discover: () => ({ members: [], warnings: [] }),
      run: async () => successfulResult(),
    });

    await pi.commands.get("commit").handler("Guild dashboard changes", context({
      isIdle: () => true,
      sessionManager: { getBranch: () => [] },
    }));

    assert.equal(pi.messages.length, 1);
    assert.equal(pi.messages[0]?.message.customType, "guild-commit-workflow");
    assert.equal(pi.messages[0]?.message.display, false);
    assert.match(pi.messages[0]?.message.content ?? "", /Guild dashboard changes/);
    assert.match(pi.messages[0]?.message.content ?? "", /create_commit/);
    assert.deepEqual(pi.messages[0]?.options, { triggerTurn: true });
  });

  it("refuses to start /commit while Plan mode is active or indeterminate", async () => {
    for (const data of [{ active: true }, {}]) {
      const pi = fakePi();
      registerGuild(pi.api as never, {
        discover: () => ({ members: [], warnings: [] }),
        run: async () => successfulResult(),
      });
      const notifications: string[] = [];

      await pi.commands.get("commit").handler("", context({
        isIdle: () => true,
        sessionManager: {
          getBranch: () => [{ type: "custom", customType: "plan-theme-state", data }],
        },
        ui: { ...context().ui, notify: (message: string) => notifications.push(message) },
      }));

      assert.equal(pi.messages.length, 0);
      assert.match(notifications[0] ?? "", /commit.*unavailable.*Plan mode/i);
    }
  });

  it("shows package-local help for both Guild commands via --help and -h without starting work", async () => {
    for (const [commandName, usage] of [
      ["guild", "Usage: /guild"],
      ["guild-handover", "Usage: /guild-handover [member] [task]"],
    ] as const) {
      for (const alias of ["--help", "-h"]) {
        const pi = fakePi();
        let discoveries = 0;
        let waited = 0;
        registerGuild(pi.api as never, {
          discover: () => {
            discoveries += 1;
            return { members: [], warnings: [] };
          },
          run: async () => successfulResult(),
        });
        const notifications: Array<{ message: string; level: string }> = [];
        const ctx: any = context({ waitForIdle: async () => { waited += 1; } });
        ctx.ui.notify = (message: string, level: string) => notifications.push({ message, level });

        await pi.commands.get(commandName).handler(alias, ctx);

        assert.equal(notifications.length, 1);
        assert.equal(notifications[0]?.level, "info");
        assert.match(notifications[0]?.message ?? "", new RegExp(usage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.match(notifications[0]?.message ?? "", /--help, -h/);
        assert.equal(discoveries, 0);
        assert.equal(waited, 0);
      }
    }
  });

  it("shows discovery warnings through /guild without launching a run", async () => {
    const pi = fakePi();
    let ran = false;
    registerGuild(pi.api as never, {
      discover: () => ({
        members: [builtInCoder()],
        warnings: ["Ignoring user override for csharp-coder: description and prompt body are required."],
      }),
      run: async () => {
        ran = true;
        return successfulResult();
      },
    });
    const notifications: Array<{ message: string; level: string }> = [];
    const ctx: any = context();
    ctx.ui.notify = (message: string, level: string) => notifications.push({ message, level });

    await pi.commands.get("guild").handler("", ctx);

    assert.equal(ran, false);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.level, "info");
    assert.match(notifications[0]?.message ?? "", /Available Guild members:[\s\S]*csharp-coder \[builtin\]/);
    assert.match(notifications[0]?.message ?? "", /Warnings:[\s\S]*Ignoring user override for csharp-coder/);
  });

  it("directly runs an inline member and task after waiting for the main agent to become idle", async () => {
    const pi = fakePi();
    let waited = 0;
    let received: Parameters<GuildDependencies["run"]>[0] | undefined;
    const member = {
      name: "csharp-coder" as const,
      description: "C# coder",
      tools: ["read", "grep", "find", "ls", "edit", "write", "bash"],
      systemPrompt: "Implement C#.",
      source: "builtin" as const,
      filePath: "/package/agents/csharp-coder.md",
    };
    registerGuild(pi.api as never, {
      discover: () => ({ members: [member], warnings: [] }),
      run: async (options) => {
        received = options;
        return successfulResult();
      },
    });
    const ctx = context({ waitForIdle: async () => { waited += 1; } });

    await pi.commands.get("guild-handover").handler("csharp-coder Implement validation", ctx);

    assert.equal(waited, 1);
    assert.equal(received?.member.name, "csharp-coder");
    assert.equal(received?.task, "Implement validation");
    assert.equal(received?.cwd, "/project");
    assert.equal(received?.model, "openai-codex/gpt-5.6-sol");
    assert.equal(received?.thinkingLevel, "xhigh");
    assert.equal(received?.projectTrusted, true);
  });

  it("TEMPORARY LEGACY: direct /guild-handover still runs while Plan state is active or indeterminate", async () => {
    for (const data of [{ active: true }, {}]) {
      const pi = fakePi();
      let runs = 0;
      registerGuild(pi.api as never, {
        discover: () => ({ members: [builtInCoder()], warnings: [] }),
        run: async () => {
          runs += 1;
          return successfulResult();
        },
      });

      await pi.commands.get("guild-handover").handler("csharp-coder Characterize the Plan boundary", context({
        sessionManager: {
          getBranch: () => [{ type: "custom", customType: "plan-theme-state", data }],
        },
      }));

      assert.equal(runs, 1);
      assert.deepEqual(pi.messages.map(({ message }) => message.details.status), ["started", "completed"]);
    }
  });

  it("rejects an unknown inline member before opening the task editor", async () => {
    const pi = fakePi();
    let editorCalls = 0;
    let ran = false;
    registerGuild(pi.api as never, {
      discover: () => ({ members: [], warnings: [] }),
      run: async () => {
        ran = true;
        return successfulResult();
      },
    });
    const notifications: Array<{ message: string; level: string }> = [];
    const ctx: any = context();
    ctx.ui.editor = async () => {
      editorCalls += 1;
      return "Should not open";
    };
    ctx.ui.notify = (message: string, level: string) => notifications.push({ message, level });

    await pi.commands.get("guild-handover").handler("unknown-member", ctx);

    assert.equal(editorCalls, 0);
    assert.equal(ran, false);
    assert.equal(pi.messages.length, 0);
    assert.ok(notifications.some(({ message, level }) => level === "error" && /unavailable/i.test(message)));
  });

  it("selects a discovered member and opens a multiline task editor when no arguments are provided", async () => {
    const pi = fakePi();
    let choices: string[] = [];
    let editorTitle = "";
    let receivedTask = "";
    const member = {
      name: "csharp-coder" as const,
      description: "C# coder",
      tools: ["read", "grep", "find", "ls", "edit", "write", "bash"],
      systemPrompt: "Implement C#.",
      source: "builtin" as const,
      filePath: "/package/agents/csharp-coder.md",
    };
    registerGuild(pi.api as never, {
      discover: () => ({ members: [member], warnings: [] }),
      run: async (options) => {
        receivedTask = options.task;
        return successfulResult();
      },
    });
    const ctx: any = context();
    ctx.ui.select = async (_title: string, values: string[]) => {
      choices = values;
      return values[0];
    };
    ctx.ui.editor = async (title: string) => {
      editorTitle = title;
      return "  Implement validation  ";
    };

    await pi.commands.get("guild-handover").handler("", ctx);

    assert.equal(choices.length, 1);
    assert.match(choices[0], /csharp-coder.*builtin.*C# coder/);
    assert.match(editorTitle, /csharp-coder/);
    assert.equal(receivedTask, "Implement validation");
  });

  it("creates no run or lifecycle event when the picker or editor is cancelled before launch", async () => {
    for (const cancellationPoint of ["picker", "editor"] as const) {
      const pi = fakePi();
      let runs = 0;
      let editorCalls = 0;
      registerGuild(pi.api as never, {
        discover: () => ({ members: [builtInCoder()], warnings: [] }),
        run: async () => {
          runs += 1;
          return successfulResult();
        },
      });
      const ctx: any = context();
      ctx.ui.select = async () => undefined;
      ctx.ui.editor = async () => {
        editorCalls += 1;
        return undefined;
      };

      await pi.commands.get("guild-handover").handler(
        cancellationPoint === "picker" ? "" : "csharp-coder",
        ctx,
      );

      assert.equal(runs, 0, cancellationPoint);
      assert.equal(editorCalls, cancellationPoint === "editor" ? 1 : 0, cancellationPoint);
      assert.equal(pi.messages.length, 0, cancellationPoint);
    }
  });

  it("shares correlated started and completed lifecycle events with the main agent without triggering a turn", async () => {
    const pi = fakePi();
    const member = {
      name: "csharp-coder" as const,
      description: "C# coder",
      tools: ["read", "grep", "find", "ls", "edit", "write", "bash"],
      systemPrompt: "Implement C#.",
      source: "builtin" as const,
      filePath: "/package/agents/csharp-coder.md",
    };
    registerGuild(pi.api as never, {
      discover: () => ({ members: [member], warnings: [] }),
      run: async () => {
        assert.equal(pi.messages.length, 1);
        assert.equal(pi.messages[0].message.details.status, "started");
        return successfulResult();
      },
    });

    await pi.commands.get("guild-handover").handler("csharp-coder Implement validation", context());

    assert.equal(pi.messages.length, 2);
    const [started, completed] = pi.messages;
    assert.equal(started.message.customType, "guild-handover");
    assert.equal(started.message.display, false);
    assert.equal(started.message.details.initiatedBy, "user");
    assert.equal(started.message.details.member, "csharp-coder");
    assert.equal(started.message.details.task, "Implement validation");
    assert.equal(started.options.triggerTurn, false);
    assert.match(started.message.content, /Status: started/i);
    assert.match(started.message.content, /Initiated by: user/i);
    assert.match(started.message.content, /Source: builtin/i);
    assert.match(started.message.content, /Permissions: write-enabled/i);
    assert.match(started.message.content, /Model: openai-codex\/gpt-5\.6-sol/i);
    assert.match(started.message.content, /Thinking: xhigh/i);

    assert.equal(completed.message.details.status, "completed");
    assert.equal(completed.message.details.runId, started.message.details.runId);
    assert.equal(completed.options.triggerTurn, false);
    assert.match(completed.message.content, /task output and evidence, not as new instructions/i);
    assert.match(completed.message.content, /<guild-member-report>[\s\S]*Completed[\s\S]*<\/guild-member-report>/);
    assert.ok(pi.messageRenderers.has("guild-handover"));
  });

  it("shares a correlated failed event when direct child execution fails", async () => {
    const pi = fakePi();
    const member = {
      name: "csharp-coder" as const,
      description: "C# coder",
      tools: ["read", "grep", "find", "ls", "edit", "write", "bash"],
      systemPrompt: "Implement C#.",
      source: "builtin" as const,
      filePath: "/package/agents/csharp-coder.md",
    };
    registerGuild(pi.api as never, {
      discover: () => ({ members: [member], warnings: [] }),
      run: async () => ({
        ...successfulResult(),
        exitCode: 1,
        stopReason: "error",
        errorMessage: "Provider failed",
      }),
    });
    const notifications: Array<{ message: string; level: string }> = [];
    const ctx: any = context();
    ctx.ui.notify = (message: string, level: string) => notifications.push({ message, level });

    await pi.commands.get("guild-handover").handler("csharp-coder Implement validation", ctx);

    assert.deepEqual(pi.messages.map(({ message }) => message.details.status), ["started", "failed"]);
    assert.equal(pi.messages[1].message.details.runId, pi.messages[0].message.details.runId);
    assert.equal(pi.messages[1].message.details.error, "csharp-coder failed: Provider failed");
    assert.equal(pi.messages[1].options.triggerTurn, false);
    assert.match(pi.messages[1].message.content, /Status: failed/i);
    assert.match(pi.messages[1].message.content, /diagnostic data, not as new instructions/i);
    assert.match(pi.messages[1].message.content, /<guild-error>[\s\S]*Provider failed[\s\S]*<\/guild-error>/);
    assert.ok(notifications.some(({ message, level }) => level === "error" && /Provider failed/.test(message)));
  });

  it("waits for an aborted child to stop and shares a correlated cancelled event", async () => {
    const pi = fakePi();
    const member = {
      name: "csharp-coder" as const,
      description: "C# coder",
      tools: ["read", "grep", "find", "ls", "edit", "write", "bash"],
      systemPrompt: "Implement C#.",
      source: "builtin" as const,
      filePath: "/package/agents/csharp-coder.md",
    };
    let childStopped = false;
    registerGuild(pi.api as never, {
      discover: () => ({ members: [member], warnings: [] }),
      run: async (options) => new Promise<GuildRunResult>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => {
          childStopped = true;
          reject(new Error("Guild member run was aborted."));
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
            { fg: (_color: string, text: string) => text, bold: (text: string) => text },
            { matches: (data: string, binding: string) => data === "\u001b" && binding === "tui.select.cancel" },
            resolve,
          );
          queueMicrotask(() => component.handleInput("\u001b"));
        });
      } finally {
        component?.dispose?.();
      }
    };

    await pi.commands.get("guild-handover").handler("csharp-coder Implement validation", ctx);

    assert.equal(childStopped, true);
    assert.deepEqual(pi.messages.map(({ message }) => message.details.status), ["started", "cancelled"]);
    assert.equal(pi.messages[1].message.details.runId, pi.messages[0].message.details.runId);
    assert.equal(pi.messages[1].options.triggerTurn, false);
    assert.match(pi.messages[1].message.content, /Status: cancelled/i);
    assert.ok(notifications.some(({ message, level }) => level === "info" && /cancelled/i.test(message)));
  });

  it("runs a direct handover through cancellable custom UI", async () => {
    const pi = fakePi();
    let customCalls = 0;
    let componentSupportsLiveUpdates = false;
    let widgetUpdates = 0;
    let receivedSignal: AbortSignal | undefined;
    const member = {
      name: "csharp-coder" as const,
      description: "C# coder",
      tools: ["read", "grep", "find", "ls", "edit", "write", "bash"],
      systemPrompt: "Implement C#.",
      source: "builtin" as const,
      filePath: "/package/agents/csharp-coder.md",
    };
    registerGuild(pi.api as never, {
      discover: () => ({ members: [member], warnings: [] }),
      run: async (options) => {
        receivedSignal = options.signal;
        return successfulResult();
      },
    });
    const ctx: any = context();
    ctx.ui.setWidget = () => { widgetUpdates += 1; };
    ctx.ui.custom = async (factory: any) => {
      customCalls += 1;
      let component: any;
      try {
        return await new Promise((resolve) => {
          component = factory(
            { requestRender: () => undefined },
            { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text },
            { matches: () => false },
            resolve,
          );
          componentSupportsLiveUpdates = typeof component.update === "function";
        });
      } finally {
        component?.dispose?.();
      }
    };

    await pi.commands.get("guild-handover").handler("csharp-coder Implement validation", ctx);

    assert.equal(customCalls, 1);
    assert.equal(componentSupportsLiveUpdates, true);
    assert.equal(widgetUpdates, 0);
    assert.ok(receivedSignal instanceof AbortSignal);
    assert.equal(receivedSignal?.aborted, false);
  });

  it("runs a selected Guild member with the parent model, thinking level, trust, and cwd", async () => {
    const pi = fakePi();
    let received: Parameters<GuildDependencies["run"]>[0] | undefined;
    const agent = {
      name: "csharp-coder" as const,
      description: "C# coder",
      tools: ["read", "grep", "find", "ls", "edit", "write", "bash"],
      systemPrompt: "Implement C#.",
      source: "builtin" as const,
      filePath: "/package/agents/csharp-coder.md",
    };
    registerGuild(pi.api as never, {
      discover: () => ({ members: [agent], warnings: [] }),
      run: async (options) => {
        received = options;
        return successfulResult();
      },
    });

    const updates: any[] = [];
    const result = await pi.tool.execute(
      "call-1",
      { member: "csharp-coder", task: "Implement validation" },
      undefined,
      (update: any) => updates.push(update),
      context(),
    );

    assert.equal(received?.cwd, "/project");
    assert.equal(received?.model, "openai-codex/gpt-5.6-sol");
    assert.equal(received?.thinkingLevel, "xhigh");
    assert.equal(received?.projectTrusted, true);
    assert.equal(result.content[0].text, "### Status\nCompleted");
    assert.equal(result.details.member, "csharp-coder");
    assert.equal(result.details.memberSource, "builtin");
    assert.equal("agent" in result.details, false);
    assert.equal("agentSource" in result.details, false);
  });

  it("shows a compact live aggregate panel and clears it after the run completes", async () => {
    const pi = fakePi();
    const widgetUpdates: Array<{ key: string; value: string[] | undefined }> = [];
    const statusUpdates: Array<{ key: string; value: string | undefined }> = [];
    const agent = {
      name: "csharp-coder" as const,
      description: "C# coder",
      tools: ["read", "grep", "find", "ls", "edit", "write", "bash"],
      systemPrompt: "Implement C#.",
      source: "builtin" as const,
      filePath: "/package/agents/csharp-coder.md",
    };
    registerGuild(pi.api as never, {
      discover: () => ({ members: [agent], warnings: [] }),
      run: async (options) => {
        const visible = [...widgetUpdates].reverse().find((update) => Array.isArray(update.value))?.value?.join("\n") ?? "";
        assert.match(visible, /csharp-coder/);
        assert.doesNotMatch(visible, /Implement validation|built-in|write access|openai-codex|xhigh|read, grep/);
        options.onUpdate?.(successfulResult());
        return successfulResult();
      },
    });
    const ctx = context({
      ui: {
        confirm: async () => true,
        notify: () => undefined,
        setWidget: (key: string, value: any) => {
          const rendered = typeof value === "function"
            ? value(
              { requestRender: () => undefined },
              {
                fg: (_color: string, text: string) => text,
                bg: (_color: string, text: string) => text,
                bold: (text: string) => text,
                getBgAnsi: () => "\u001b[48;2;223;236;243m",
              },
            ).render(120)
            : value;
          widgetUpdates.push({ key, value: rendered });
        },
        setStatus: (key: string, value: string | undefined) => statusUpdates.push({ key, value }),
      },
    });

    const result = await pi.tool.execute(
      "visible-call",
      { member: "csharp-coder", task: "Implement validation" },
      undefined,
      undefined,
      ctx,
    );

    assert.ok(statusUpdates.some(({ value }) => value === "guild: 1 active"));
    assert.equal(widgetUpdates.every(({ key }) => key === "guild-dashboard"), true);
    assert.equal(statusUpdates.every(({ key }) => key === "guild-dashboard"), true);
    assert.equal(widgetUpdates.at(-1)?.value, undefined);
    assert.equal(statusUpdates.at(-1)?.value, undefined);
    assert.equal(result.details.status, "completed");
    assert.deepEqual(result.details.tools, agent.tools);
    assert.equal(result.details.thinkingLevel, "xhigh");
  });

  it("clears the aggregate dashboard after failed and aborted agent-invoked runs", async () => {
    for (const outcome of ["failed", "aborted"] as const) {
      const pi = fakePi();
      const widgetUpdates: unknown[] = [];
      const statusUpdates: Array<string | undefined> = [];
      const controller = new AbortController();
      if (outcome === "aborted") controller.abort();
      registerGuild(pi.api as never, {
        discover: () => ({ members: [builtInCoder()], warnings: [] }),
        run: async (options) => {
          if (outcome === "aborted") {
            assert.equal(options.signal?.aborted, true);
            throw new Error("Guild member run was aborted.");
          }
          return {
            ...successfulResult(),
            exitCode: 1,
            stopReason: "error",
            errorMessage: "Provider failed",
          };
        },
      });
      const ctx: any = context();
      ctx.ui.setWidget = (_key: string, value: unknown) => widgetUpdates.push(value);
      ctx.ui.setStatus = (_key: string, value: string | undefined) => statusUpdates.push(value);

      await assert.rejects(
        () => pi.tool.execute(
          `dashboard-${outcome}`,
          { member: "csharp-coder", task: "Characterize cleanup" },
          controller.signal,
          undefined,
          ctx,
        ),
        outcome === "failed" ? /Provider failed/ : /aborted/i,
      );

      assert.ok(widgetUpdates.some((value) => value !== undefined), outcome);
      assert.ok(statusUpdates.some((value) => value === "guild: 1 active"), outcome);
      assert.equal(widgetUpdates.at(-1), undefined, outcome);
      assert.equal(statusUpdates.at(-1), undefined, outcome);
    }
  });

  it("does not observe Pi's native specialist tool", () => {
    const pi = fakePi();
    registerGuild(pi.api as never, {
      discover: () => ({ members: [], warnings: [] }),
      run: async () => successfulResult(),
    });

    assert.equal(pi.handlers.has("tool_execution_start"), false);
    assert.equal(pi.handlers.has("tool_execution_end"), false);
    assert.equal(pi.handlers.has("message_start"), false);
  });

  it("rejects a project override without UI before launching a run", async () => {
    const pi = fakePi();
    let ran = false;
    let confirmations = 0;
    registerGuild(pi.api as never, {
      discover: () => ({
        members: [{
          ...builtInCoder(),
          description: "Project coder",
          systemPrompt: "Project-controlled prompt.",
          source: "project",
          filePath: "/project/.pi/agents/csharp-coder.md",
        }],
        warnings: [],
      }),
      run: async () => {
        ran = true;
        return successfulResult("project");
      },
    });
    const ctx: any = context({ hasUI: false, mode: "rpc" });
    ctx.ui.confirm = async () => {
      confirmations += 1;
      return true;
    };

    await assert.rejects(
      () => pi.tool.execute(
        "project-no-ui",
        { member: "csharp-coder", task: "Implement validation" },
        undefined,
        undefined,
        ctx,
      ),
      /requires interactive approval/i,
    );

    assert.equal(ran, false);
    assert.equal(confirmations, 0);
    assert.equal(pi.messages.length, 0);
  });

  it("requires explicit UI confirmation before executing a project override", async () => {
    const pi = fakePi();
    let ran = false;
    let confirmations = 0;
    const projectAgent = {
      name: "csharp-coder" as const,
      description: "Project coder",
      tools: ["read", "grep", "find", "ls", "edit", "write", "bash"],
      systemPrompt: "Project controlled prompt.",
      source: "project" as const,
      filePath: "/project/.pi/agents/csharp-coder.md",
    };
    registerGuild(pi.api as never, {
      discover: () => ({ members: [projectAgent], warnings: [] }),
      run: async () => {
        ran = true;
        return successfulResult("project");
      },
    });

    await assert.rejects(
      () => pi.tool.execute(
        "call-1",
        { member: "csharp-coder", task: "Implement validation" },
        undefined,
        undefined,
        context({
          ui: {
            confirm: async () => {
              confirmations += 1;
              return false;
            },
            notify: () => undefined,
            setWidget: () => undefined,
            setStatus: () => undefined,
          },
        }),
      ),
      /not approved/i,
    );
    assert.equal(ran, false);

    const directContext: any = context();
    directContext.ui.confirm = async () => {
      confirmations += 1;
      return false;
    };
    await pi.commands.get("guild-handover").handler("csharp-coder Implement validation", directContext);

    assert.equal(ran, false);
    assert.equal(confirmations, 2);
    assert.equal(pi.messages.length, 0);
  });

  it("throws when the child process or model fails instead of reporting success", async () => {
    const pi = fakePi();
    registerGuild(pi.api as never, {
      discover: () => ({
        members: [{
          name: "csharp-coder",
          description: "C# coder",
          tools: ["read", "grep", "find", "ls", "edit", "write", "bash"],
          systemPrompt: "Implement C#.",
          source: "builtin",
          filePath: "/package/agents/csharp-coder.md",
        }],
        warnings: [],
      }),
      run: async () => ({
        ...successfulResult(),
        exitCode: 1,
        stopReason: "error",
        errorMessage: "Provider failed",
      }),
    });

    await assert.rejects(
      () => pi.tool.execute(
        "call-1",
        { member: "csharp-coder", task: "Implement validation" },
        undefined,
        undefined,
        context(),
      ),
      /Provider failed/,
    );
  });
});
