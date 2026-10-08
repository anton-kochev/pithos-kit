import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { GuildRunTracker } from "../src/visibility";

describe("Guild member run visibility", () => {
  it("prefers canonical identity and distinguishes queued from running without exposing run internals", () => {
    const tracker = new GuildRunTracker();
    const queuedRun = {
      id: "run-1",
      role: "architect" as const,
      profile: "dotnet" as const,
      phase: "queued" as const,
      member: "dotnet-architect" as const,
      startedAt: 1_000,
      task: "Inspect task · queued",
      model: "do-not-show-this-model",
      tools: ["read"],
    };
    tracker.start(queuedRun);
    tracker.start({
      id: "run-2",
      role: "coder",
      profile: "angular",
      phase: "queued",
      startedAt: 2_000,
    });
    tracker.update("run-1", { turns: 2 });
    tracker.update("run-2", { phase: "running" });

    const lines = tracker.formatLines(6_000);

    assert.deepEqual(lines, [
      "Guild · 2 active",
      "⏳ architect/dotnet · queued · 5s · 2 turns · Inspect task · queued",
      "⏳ coder/angular · running · 4s",
    ]);
    assert.doesNotMatch(lines.join("\n"), /do-not-show|\bread\b/);
  });

  it("formats long elapsed times as readable units", () => {
    const tracker = new GuildRunTracker();
    tracker.start({
      id: "long-run",
      role: "coder",
      profile: "angular",
      phase: "running",
      startedAt: 2_000,
    });

    const text = tracker.formatLines(2_980_000).join("\n");

    assert.match(text, /coder\/angular.*49m 38s/);
    assert.doesNotMatch(text, /2978s/);
  });

  it("renders legacy member-only inputs and removes finished runs from active-only state", () => {
    const tracker = new GuildRunTracker();
    const base = {
      startedAt: 0,
    };
    tracker.start({ ...base, id: "one", member: "dotnet-architect" });
    tracker.start({ ...base, id: "two", member: "frontend-architect" });

    tracker.finish("one");
    assert.equal(tracker.size, 1);
    assert.doesNotMatch(tracker.formatLines(1_000).join("\n"), /dotnet-architect|recent|completed/);
    assert.match(tracker.formatLines(1_000).join("\n"), /⏳ frontend-architect/);

    tracker.finish("two");
    assert.equal(tracker.size, 0);
    assert.deepEqual(tracker.formatLines(2_000), []);

    tracker.start({ ...base, id: "three", member: "dotnet-architect", startedAt: 3_000 });
    assert.match(tracker.formatLines(4_000)[0], /^Guild · 1 active$/);
    assert.doesNotMatch(tracker.formatLines(4_000).join("\n"), /frontend-architect|recent|completed/);
  });
});

it("sanitizes and bounds previews without changing the original task", () => {
  const tracker = new GuildRunTracker();
  const task = "\x1b[31mInspect\x1b[0m\n\t" + "界".repeat(100) + "\x00\x07";
  const run = { id: "preview", role: "coder" as const, profile: "typescript" as const,
    phase: "queued" as const, startedAt: 0, task };
  tracker.start(run);
  const preview = tracker.formatLines(0)[1].split(" · ").slice(3).join(" · ");
  assert.equal(run.task, task);
  assert.match(preview, /^Inspect 界/);
  assert.match(preview, /…$/);
  assert.ok(visibleWidth(preview) <= 80);
  assert.doesNotMatch(preview, /[\x00-\x1f\x7f-\x9f]/);
});
