import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  createGuildHandoverProgress,
  createGuildPanel,
  renderGuildCall,
  renderGuildLifecycleMessage,
  renderGuildResult,
} from "../src/ui";

initTheme();

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

describe("Guild visual presentation", () => {
  it("renders canonical queued and running entries distinctly with balanced half-row edges", () => {
    const backgrounds: string[] = [];
    const panelTheme = {
      name: "auric-light",
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
      bg: (color: string, text: string) => {
        backgrounds.push(color);
        return text;
      },
      bold: (_text: string) => {
        throw new Error("the aggregate dashboard should not request bold text");
      },
      getBgAnsi: () => "\u001b[48;2;223;236;243m",
      getColorMode: () => "truecolor",
    } as any;
    const panel = createGuildPanel([
      "Guild · 2 active",
      "⏳ architect/dotnet · queued · 5s · 2 turns",
      "⏳ coder/angular · running · 49m 38s",
    ], panelTheme);

    const lines = panel.render(400);
    const rendered = lines.join("\n");
    assert.equal(lines.length, 5);
    assert.match(lines[0] ?? "", /^\u001b\[38;2;233;221;242m▄+/);
    assert.match(lines[1] ?? "", /^\u001b\[48;2;233;221;242m <accent>Guild<\/accent><muted> · 2 active<\/muted>/);
    assert.match(lines[2] ?? "", /^\u001b\[48;2;233;221;242m <muted>○<\/muted> <accent>architect\/dotnet<\/accent><dim> · queued · 5s · 2 turns<\/dim>/);
    assert.match(lines[3] ?? "", /^\u001b\[48;2;233;221;242m <warning>●<\/warning> <accent>coder\/angular<\/accent><dim> · running · 49m 38s<\/dim>/);
    assert.match(lines[4] ?? "", /^\u001b\[38;2;233;221;242m▀+/);
    assert.deepEqual(backgrounds, []);
    assert.doesNotMatch(rendered, /Design order cancellation|openai-codex|read, grep|built-in|read only/);
  });

  it("uses a dedicated Guild background for dark themes", () => {
    const panelTheme = {
      name: "auric-dark",
      fg: (_color: string, text: string) => text,
      bg: () => {
        throw new Error("the Guild panel should not use a standard theme background");
      },
      getBgAnsi: () => "\u001b[48;2;30;30;36m",
      getColorMode: () => "truecolor",
    } as any;

    const lines = createGuildPanel(["Guild · 1 active", "⏳ csharp-coder · 3s"], panelTheme).render(80);
    assert.match(lines[0] ?? "", /^\u001b\[38;2;45;37;56m▄+/);
    assert.match(lines[1] ?? "", /^\u001b\[48;2;45;37;56m Guild · 1 active/);
    assert.match(lines[2] ?? "", /^\u001b\[48;2;45;37;56m ● csharp-coder · 3s/);
    assert.match(lines[3] ?? "", /^\u001b\[38;2;45;37;56m▀+/);
  });

  it("renders a fancy, width-capped lifecycle card with real Markdown", () => {
    const details = {
      runId: "guild-command-123",
      initiatedBy: "user",
      role: "architect",
      profile: "dotnet",
      source: "package",
      task: "Explore the repository and report any .NET artifacts",
      inheritedModel: "openai-codex/gpt-5.6-sol",
      thinkingLevel: "xhigh",
      elapsedMs: 40_800,
      usage: { turns: 4, cost: 0.1121 },
      status: "completed",
      output: "### Summary\n\nI found **no actual .NET artifacts**.",
    };

    const lines = renderGuildLifecycleMessage(
      { content: "lifecycle", details },
      { expanded: false },
      theme,
    ).render(180);
    const rendered = lines.join("\n");

    assert.ok(lines.every((line) => visibleWidth(line) <= 110));
    assert.match(rendered, /╭─.*Guild Relay.*\[✓ Completed\].*─╮/);
    assert.match(rendered, /architect\/dotnet.*package.*read-only/i);
    assert.match(rendered, /Request.*Explore the repository/);
    assert.doesNotMatch(rendered, /USER|MISSION|dotnet-architect|built-in/i);
    assert.match(rendered, /REPORT/);
    assert.match(rendered, /Summary/);
    assert.match(rendered, /no actual \.NET artifacts/);
    assert.match(rendered, /expand report/);
    assert.doesNotMatch(rendered, /###|\*\*|◇|◆/);
  });

  it("labels reviewer handovers as read-only review", () => {
    const rendered = renderGuildLifecycleMessage(
      {
        content: "lifecycle",
        details: {
          role: "reviewer",
          profile: "general",
          source: "package",
          status: "completed",
          task: "Review the current change",
          output: "No findings.",
        },
      },
      { expanded: false },
      theme,
    ).render(100).join("\n");

    assert.match(rendered, /reviewer\/general.*package.*read-only review/i);
    assert.doesNotMatch(rendered, /code-reviewer/i);
    assert.doesNotMatch(rendered, /write enabled/i);
  });

  it("shows canonical queued and running phases in lifecycle and result presentations", () => {
    const base = {
      role: "explorer",
      profile: "general",
      source: "package",
      task: "Inspect repository facts",
    };
    const queuedLifecycle = renderGuildLifecycleMessage(
      { content: "lifecycle", details: { ...base, status: "started", phase: "queued" } },
      { expanded: false },
      theme,
    ).render(100).join("\n");
    assert.match(queuedLifecycle, /\[○ Queued\]/);
    assert.match(queuedLifecycle, /explorer\/general.*package.*read-only/i);

    const runningLifecycle = renderGuildLifecycleMessage(
      { content: "lifecycle", details: { ...base, status: "started", phase: "running" } },
      { expanded: false },
      theme,
    ).render(100).join("\n");
    assert.match(runningLifecycle, /\[● Running\]/);

    const queuedResult = renderGuildResult(
      { details: { ...base, status: "queued", phase: "queued" } },
      { expanded: false, isPartial: true },
      theme,
    ).render(100).join("\n");
    assert.match(queuedResult, /○ Queued.*explorer\/general/);
    assert.match(queuedResult, /package.*READ-ONLY/i);

    const runningResult = renderGuildResult(
      { details: { ...base, status: "running", phase: "running" } },
      { expanded: false, isPartial: true },
      theme,
    ).render(100).join("\n");
    assert.match(runningResult, /● Running.*explorer\/general/);
  });

  it("uses compact framed treatments for failed and cancelled handovers", () => {
    const base = {
      runId: "guild-command-123",
      initiatedBy: "user",
      role: "coder",
      profile: "dotnet",
      source: "package",
      task: "Implement validation",
      elapsedMs: 2500,
    };
    const failed = renderGuildLifecycleMessage(
      { content: "lifecycle", details: { ...base, status: "failed", error: "Provider failed" } },
      { expanded: false },
      theme,
    ).render(100).join("\n");
    assert.match(failed, /\[✗ Failed\]/);
    assert.match(failed, /DIAGNOSTICS/);
    assert.match(failed, /Provider failed/);

    const cancelled = renderGuildLifecycleMessage(
      { content: "lifecycle", details: { ...base, status: "cancelled" } },
      { expanded: false },
      theme,
    ).render(100).join("\n");
    assert.match(cancelled, /\[■ Cancelled\]/);
    assert.match(cancelled, /Request.*Implement validation/);
    assert.ok(cancelled.split("\n").length <= 5);
  });

  it("renders animated live activity and exposes cancellable progress", () => {
    let renders = 0;
    const progress = createGuildHandoverProgress({
      role: "architect",
      profile: "dotnet",
      source: "package",
      phase: "queued",
      task: "Explore the repository and report any .NET artifacts",
      startedAt: Date.now(),
    }, {
      requestRender: () => { renders += 1; },
    } as any, theme, {
      matches: (data: string, binding: string) => data === "escape" && binding === "tui.select.cancel",
    } as any);

    try {
      const initial = progress.render(180);
      assert.ok(initial.every((line) => visibleWidth(line) <= 110));
      assert.match(initial.join("\n"), /Guild Relay.*\[○ Queued\s+00:00\]/);
      assert.match(initial.join("\n"), /architect\/dotnet.*package.*read-only/i);
      assert.match(initial.join("\n"), /Request.*Explore the repository/);
      assert.match(initial.join("\n"), /Starting handover.*cancel/);
      assert.ok(initial.length <= 5);
      assert.doesNotMatch(initial.join("\n"), /USER|MISSION|◇|◆|openai-codex/);

      progress.update({ phase: "running", activity: "Scanning repository", activityTool: "find", turns: 2 });
      const active = progress.render(100).join("\n");
      assert.match(active, /Guild Relay.*\[● Running\s+00:00\]/);
      assert.match(active, /Scanning repository/);
      assert.match(active, /find · 2 turns/);
      assert.ok(renders > 0);

      progress.handleInput("escape");
      assert.equal(progress.signal.aborted, true);
      assert.match(progress.render(100).join("\n"), /Cancelling/);
    } finally {
      progress.dispose();
    }
  });

  it("uses color and spacing instead of bold direct-handover chrome", () => {
    const lightweightTheme = {
      ...theme,
      bold: (_text: string) => {
        throw new Error("direct handover chrome should not request bold text");
      },
    } as any;
    const details = {
      status: "completed",
      role: "architect",
      profile: "typescript",
      source: "package",
      task: "Inspect repository",
      elapsedMs: 1000,
      output: "Inspection complete.",
    };

    assert.doesNotThrow(() => renderGuildLifecycleMessage(
      { content: "lifecycle", details },
      { expanded: false },
      lightweightTheme,
    ).render(90));

    const progress = createGuildHandoverProgress({
      role: "architect",
      profile: "typescript",
      source: "package",
      task: "Inspect repository",
      startedAt: Date.now(),
    }, { requestRender: () => undefined } as any, lightweightTheme, { matches: () => false } as any);
    try {
      assert.doesNotThrow(() => progress.render(90));
    } finally {
      progress.dispose();
    }
  });

  it("renders legacy persisted identities, calls, and progress options as compatibility fallbacks", () => {
    const legacyDetails = {
      member: "dotnet-architect",
      memberSource: "builtin",
      role: "architect",
    };
    const lifecycle = renderGuildLifecycleMessage(
      { content: "persisted lifecycle", details: legacyDetails },
      { expanded: false },
      theme,
    ).render(100).join("\n");
    assert.match(lifecycle, /dotnet-architect.*built-in.*read-only/i);

    const result = renderGuildResult(
      { details: legacyDetails },
      { expanded: false, isPartial: false },
      theme,
    ).render(100).join("\n");
    assert.match(result, /Completed.*dotnet-architect/i);
    assert.match(result, /built-in.*READ-ONLY/i);

    const call = renderGuildCall({ member: "dotnet-architect", task: "Resume history" }, theme)
      .render(100).join("\n");
    assert.match(call, /Guild.*dotnet-architect/);
    assert.match(call, /Resume history/);

    const progress = createGuildHandoverProgress({
      member: "dotnet-architect",
      memberSource: "builtin",
      role: "architect",
      task: "Resume in-flight handover",
      startedAt: Date.now(),
    }, { requestRender: () => undefined } as any, theme, { matches: () => false } as any);
    try {
      assert.match(progress.render(100).join("\n"), /dotnet-architect.*built-in.*read-only/i);
    } finally {
      progress.dispose();
    }
  });

  it("renders canonical calls and expandable completion cards without legacy member fields", () => {
    const call = renderGuildCall({
      role: "coder",
      profile: "dotnet",
      task: "Implement order validation",
    }, theme);
    const renderedCall = call.render(100).join("\n");
    assert.match(renderedCall, /✦ Guild.*coder\/dotnet.*package.*write-enabled/i);
    assert.match(renderedCall, /Implement order validation/);
    assert.doesNotMatch(renderedCall, /csharp-coder|selecting/);

    const details = {
      status: "completed",
      phase: "running",
      role: "coder",
      profile: "dotnet",
      source: "package",
      tools: ["read", "edit", "bash"],
      inheritedModel: "openai-codex/gpt-5.6-sol",
      thinkingLevel: "xhigh",
      elapsedMs: 2500,
      usage: { turns: 2, cost: 0.01 },
      output: "## Status\nCompleted successfully.",
    };
    const result = renderGuildResult(
      { content: [{ type: "text", text: details.output }], details },
      { expanded: true, isPartial: false },
      theme,
    );
    const rendered = result.render(100).join("\n");
    assert.match(rendered, /✓ Completed.*coder\/dotnet/);
    assert.match(rendered, /package.*WRITE-ENABLED/i);
    assert.match(rendered, /2 turns/);
    assert.match(rendered, /Completed successfully/);
    assert.doesNotMatch(rendered, /csharp-coder/);
  });
});

it("shows blocked warning and only selected skill IDs, preserving historical v1 display", () => {
 const details = {status: "completed", taskOutcome: "blocked", role: "coder", profile: "general", output: "Missing red", selectedSkills: [{id: "tdd", source: "package", path: "secret/path", bytes: 42, sha256: "privatehash"}]};
 const tool = renderGuildResult({details}, {expanded: true}, theme).render(100).join("\n");
 const direct = renderGuildLifecycleMessage({details}, {expanded: true}, theme).render(100).join("\n");
 for (const text of [tool, direct]) {assert.match(text, /Blocked/); assert.match(text, /tdd/); assert.doesNotMatch(text, /secret\/path|privatehash|✓ Completed/);}
 const historical = renderGuildResult({details: {status: "completed", member: "dotnet-architect", memberSource: "builtin", output: "Legacy"}}, {}, theme).render(100).join("\n");
 assert.match(historical, /✓ Completed.*dotnet-architect/);
 assert.doesNotMatch(historical, /Blocked|tdd/);
});

it("renders cancelled tool results distinctly even when Pi marks the tool result as an error", () => {
 const rendered = renderGuildResult({content: [{type: "text", text: "Stopped"}], details: {status: "cancelled", role: "coder", profile: "general", usageKnown: false}}, {}, theme, {isError: true}).render(100).join("\n");
 assert.match(rendered, /■ Cancelled/);
 assert.match(rendered, /usage unknown/);
 assert.doesNotMatch(rendered, /Completed|Failed/);
});
