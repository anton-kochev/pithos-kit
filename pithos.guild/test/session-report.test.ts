import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { analyzeSessions, findSessionFiles, formatReport } from "../tools/session-report.ts";

const cost = (total: number) => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } });
const header = (id: string, timestamp = "2026-10-01T10:00:00.000Z") => ({ type: "session", version: 3, id, timestamp, cwd: "/project" });
const user = (text = "Do it") => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (toolCalls: Array<[string, string, unknown]> = [], total = 0.1) => ({
	type: "message",
	message: { role: "assistant", content: toolCalls.map(([id, name, args]) => ({ type: "toolCall", id, name, arguments: args })), usage: cost(total) },
});
const toolResult = (toolCallId: string, toolName: string, details: unknown, extra: Record<string, unknown> = {}) => ({
	type: "message", message: { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: "report" }], details, isError: false, ...extra },
});

function currentDetails(overrides: Record<string, unknown> = {}) {
	return {
		status: "completed", role: "coder", profile: "general", runId: "call-1", startedAt: 1, elapsedMs: 5000,
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.5, contextTokens: 15, turns: 3 },
		usageKnown: true, usageFields: ["input", "output", "cost"], practices: [{ id: "tdd", policy: "required" }], taskOutcome: "succeeded",
		report: { payload: { changes: [{ path: "src/a.ts", change: "Added" }] }, compliance: [{ id: "tdd", status: "satisfied" }] },
		...overrides,
	};
}

function writeSession(dir: string, name: string, entries: unknown[]) {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, name);
	writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
	return file;
}

it("reports a current tool handover with Pi usage, TDD, trace submissions and possible rework", () => {
	const root = mkdtempSync(join(tmpdir(), "guild-report-"));
	const file = writeSession(root, "s1.jsonl", [
		header("s1"), user(),
		assistant([["call-1", "guild_handover", { role: "coder", profile: "general", task: "Work" }]], 0.2),
		toolResult("call-1", "guild_handover", currentDetails(), { usage: cost(0.6) }),
		assistant([["edit-1", "edit", { path: "/project/src/a.ts" }]], 0.3),
	]);
	writeSession(join(root, "guild", "s1"), "child-1.jsonl", [
		{ kind: "header", version: 1, runId: "call-1", childId: "child-1" },
		{ kind: "event", event: { type: "tool_execution_end", toolName: "guild_submit_result", isError: true } },
		{ kind: "event", event: { type: "tool_execution_end", toolName: "guild_submit_result", isError: false } },
		{ kind: "end", exitCode: 0, aborted: false },
	]);
	assert.deepEqual(findSessionFiles([root]), [file]);
	const { handovers, summary } = analyzeSessions([file]);
	assert.equal(handovers.length, 1);
	assert.deepEqual(handovers[0], {
		sessionId: "s1", file, startedAt: "2026-10-01T10:00:00.000Z", entry: "tool", runId: "call-1", target: "coder/general",
		status: "completed", taskOutcome: "succeeded", tdd: "satisfied", durationMs: 5000, turns: 3, childCost: 0.6,
		outputBytes: 6, rework: true, trace: { file: join(root, "guild", "s1", "child-1.jsonl"), rejectedSubmissions: 1, exitCode: 0, truncated: false },
	});
	assert.equal(summary.sessions, 1);
	assert.equal(summary.sessionsWithHandovers, 1);
	assert.equal(summary.cost.parent, 0.5);
	assert.equal(summary.cost.child, 0.6);
	assert.equal(summary.cost.excludedSessions, 0);
	assert.equal(summary.rework.flagged, 1);
	assert.equal(summary.rework.eligible, 1);
});

it("counts a direct handover once from its terminal lifecycle message", () => {
	const root = mkdtempSync(join(tmpdir(), "guild-report-"));
	const lifecycle = (status: string, extra = {}) => ({ type: "custom_message", customType: "guild-handover", display: false, content: "", details: { ...currentDetails({ runId: "direct-1", status, report: undefined, taskOutcome: undefined, practices: [] }), initiatedBy: "user", ...extra } });
	const file = writeSession(root, "s2.jsonl", [header("s2"), lifecycle("started"), lifecycle("failed", { error: "boom" })]);
	const { handovers } = analyzeSessions([file]);
	assert.equal(handovers.length, 1);
	assert.equal(handovers[0].entry, "direct");
	assert.equal(handovers[0].status, "failed");
	assert.equal(handovers[0].childCost, 0.5);
	assert.equal(handovers[0].rework, undefined);
});

it("reads legacy member details, thrown legacy failures and unknown usage without inventing zero cost", () => {
	const root = mkdtempSync(join(tmpdir(), "guild-report-"));
	const legacy = { member: "typescript-coder", status: "completed", elapsedMs: 900, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 1.8, contextTokens: 2, turns: 10 } };
	const file = writeSession(root, "s3.jsonl", [
		header("s3"), user(),
		assistant([["old-1", "guild_handover", { member: "typescript-coder", task: "Work" }], ["old-2", "guild_handover", { member: "rust-coder", task: "Work" }], ["new-1", "guild_handover", { role: "reviewer", profile: "general", task: "Review" }]]),
		toolResult("old-1", "guild_handover", legacy),
		toolResult("old-2", "guild_handover", {}, { isError: true }),
		toolResult("new-1", "guild_handover", currentDetails({ role: "reviewer", runId: "new-1", usageKnown: false, usageFields: [], report: undefined, taskOutcome: undefined, practices: [] })),
	]);
	const { handovers, summary } = analyzeSessions([file]);
	assert.deepEqual(handovers.map(handover => [handover.target, handover.status, handover.childCost]), [
		["typescript-coder", "completed", 1.8],
		["rust-coder", "failed", undefined],
		["reviewer/general", "completed", undefined],
	]);
	assert.equal(handovers[0].rework, undefined);
	assert.equal(summary.cost.excludedSessions, 1);
	assert.equal(summary.cost.child, undefined);
});

it("does not flag rework on other paths or after the next user message", () => {
	const root = mkdtempSync(join(tmpdir(), "guild-report-"));
	const file = writeSession(root, "s4.jsonl", [
		header("s4"), user(),
		assistant([["call-1", "guild_handover", { role: "coder", profile: "general", task: "Work" }]]),
		toolResult("call-1", "guild_handover", currentDetails()),
		assistant([["edit-1", "edit", { path: "src/other.ts" }]]),
		user("Next"),
		assistant([["edit-2", "write", { path: "src/a.ts" }]]),
	]);
	const { handovers } = analyzeSessions([file]);
	assert.equal(handovers[0].rework, false);
});

it("filters sessions by start date and formats a readable summary", () => {
	const root = mkdtempSync(join(tmpdir(), "guild-report-"));
	const old = writeSession(root, "old.jsonl", [header("old", "2026-09-01T00:00:00.000Z"), user(), assistant([["c", "guild_handover", { role: "coder", profile: "general", task: "x" }]]), toolResult("c", "guild_handover", currentDetails({ runId: "c" }))]);
	const recent = writeSession(root, "new.jsonl", [header("new"), user(), assistant()]);
	const report = analyzeSessions([old, recent], { since: "2026-09-15" });
	assert.equal(report.summary.sessions, 1);
	assert.equal(report.handovers.length, 0);
	const text = formatReport(analyzeSessions([old, recent]));
	assert.match(text, /Sessions\s+2/);
	assert.match(text, /Handovers\s+1/);
	assert.match(text, /coder\/general\s+1/);
	assert.match(text, /completed\s+1/);
});
