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
		{ kind: "header", version: 1, runId: "call-1", childId: "child-1", repoState: { state: "call-1.state", head: "abc", dirty: true, complete: true } },
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
		outputBytes: 6, rework: true, trace: { file: join(root, "guild", "s1", "child-1.jsonl"), rejectedSubmissions: 1, exitCode: 0, truncated: false, repoState: { state: "call-1.state", head: "abc", dirty: true, complete: true } },
	});
	assert.equal(summary.sessions, 1);
	assert.equal(summary.sessionsWithHandovers, 1);
	assert.equal(summary.cost.parent, 0.5);
	assert.equal(summary.cost.child, 0.6);
	assert.equal(summary.cost.excludedSessions, 0);
	assert.equal(summary.rework.flagged, 1);
	assert.equal(summary.rework.eligible, 1);
	assert.equal(summary.traces.replayable, 1);
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

const bgIdentity = (runId: string) => ({version: 1, sessionId: "bg", runId, taskId: `task-${runId}`, role: "coder", profile: "typescript"});
const journal = (id: string, parentId: string | null, data: unknown, timestamp?: number) => ({type: "custom", customType: "pithos.guild.background.v1", id, parentId, data, ...(timestamp === undefined ? {} : {timestamp: new Date(timestamp).toISOString()})});
const bgTerminal = (runId: string) => ({status: "failed", runId, taskId: `task-${runId}`, role: "coder", profile: "typescript", exitCode: 1, usage: {input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.5, contextTokens: 2, turns: 1}, usageKnown: true, usageFields: ["cost"], providerUsage: cost(0.5)});

it("joins admitted background runs once and separates journal latency from overlapping trace execution", () => {
	const root = mkdtempSync(join(tmpdir(), "guild-report-"));
	const entries: unknown[] = [header("bg")];
	for (const [runId, start, end] of [["a", 0, 10], ["b", 5, 15]] as const) {
		entries.push(journal(runId, null, {...bgIdentity(runId), kind: "admitted"}, 1000));
		entries.push(journal(`${runId}-end`, runId, {...bgIdentity(runId), kind: "terminal", originEntryId: runId, report: bgTerminal(runId)}, 1100));
		writeSession(join(root, "guild", "bg"), `${runId}.jsonl`, [{kind: "header", version: 1, runId, parentSessionId: "bg", startedAt: start}, {kind: "end", endedAt: end}]);
	}
	const file = writeSession(root, "bg.jsonl", entries);
	const report = analyzeSessions([file, file]);
	assert.equal(report.handovers.length, 2);
	assert.equal(report.handovers[0].admissionToTerminalMs, 100);
	assert.equal(report.handovers[0].durationMs, 10);
	assert.equal(report.handovers[0].originEntryId, "a");
	assert.equal(report.handovers[0].childCost, undefined);
	assert.equal(report.handovers[0].informationalChildCost, 0.5);
	assert.deepEqual(report.summary.backgroundExecution, {measured: 2, unknown: 0, sumMs: 20, unionMs: 15, overlapMs: 5});
});

it("skips orphan, invalid and non-descendant journal terminals with diagnostics and keeps timing unknown", () => {
	const root = mkdtempSync(join(tmpdir(), "guild-report-"));
	const file = writeSession(root, "bg.jsonl", [header("bg"),
		journal("orphan", null, {...bgIdentity("orphan"), kind: "terminal", originEntryId: "missing", report: bgTerminal("orphan")}),
		journal("a", null, {...bgIdentity("a"), kind: "admitted"}),
		journal("wrong-branch", null, {...bgIdentity("a"), kind: "terminal", originEntryId: "a", report: bgTerminal("a")}),
		journal("invalid", "a", {...bgIdentity("a"), kind: "terminal", originEntryId: "a", report: {...bgTerminal("a"), exitCode: "bad"}}),
	]);
	const report = analyzeSessions([file]);
	assert.equal(report.handovers.length, 1);
	assert.equal(report.handovers[0].status, "unknown");
	assert.equal(report.handovers[0].durationMs, undefined);
	assert.equal(report.handovers[0].admissionToTerminalMs, undefined);
	assert.equal(report.diagnostics?.length, 3);
	assert.deepEqual(report.summary.backgroundExecution, {measured: 0, unknown: 1});
	assert.match(formatReport(report), /Background execution/);
	assert.match(formatReport(report), /Unknown\s+1/);
});

it("measures disjoint, touching and triply nested intervals without pairwise multiplicity", () => {
	for (const [intervals, expected] of [
		[[[0, 10], [20, 30]], [20, 20, 0]],
		[[[0, 10], [10, 20]], [20, 20, 0]],
		[[[0, 20], [5, 15], [7, 12]], [35, 20, 10]],
	] as Array<[number[][], number[]]>) {
		const root = mkdtempSync(join(tmpdir(), "guild-report-"));
		const entries: unknown[] = [header("bg")];
		intervals.forEach(([startedAt, endedAt], i) => {
			const runId = String(i);
			entries.push(journal(runId, null, {...bgIdentity(runId), kind: "admitted"}));
			writeSession(join(root, "guild", "bg"), `${i}.jsonl`, [{kind: "header", version: 1, runId, startedAt}, {kind: "end", endedAt}]);
		});
		const timing = analyzeSessions([writeSession(root, "bg.jsonl", entries)]).summary.backgroundExecution!;
		assert.deepEqual([timing.sumMs, timing.unionMs, timing.overlapMs], expected);
	}
});

it("counts native usage only for the first collection and never substitutes journal provider cost", () => {
	const root = mkdtempSync(join(tmpdir(), "guild-report-"));
	const correlation = {version: 1, sessionId: "bg", runId: "a", taskId: "task-a", collectionId: "collection"};
	const entries = [header("bg"), journal("a", null, {...bgIdentity("a"), kind: "admitted"}),
		journal("end", "a", {...bgIdentity("a"), kind: "terminal", originEntryId: "a", report: bgTerminal("a")}),
		journal("receipt", "end", {...bgIdentity("a"), kind: "collected", originEntryId: "a", collectionId: "collection", toolCallId: "wait", native: "claimed"}),
		toolResult("wait", "guild_wait", {guildBackground: correlation}, {usage: cost(0.6)}),
		toolResult("wait", "guild_wait", {guildBackground: correlation}, {usage: cost(0.6)}),
	];
	const report = analyzeSessions([writeSession(root, "bg.jsonl", entries)]);
	assert.equal(report.handovers.length, 1);
	assert.equal(report.summary.cost.child, 0.6);
	assert.equal(report.handovers[0].informationalChildCost, undefined);
});

it("ignores malformed custom type values without executing or throwing", () => {
	const root = mkdtempSync(join(tmpdir(), "guild-report-"));
	const file = writeSession(root, "bg.jsonl", [header("bg"), {type: "custom", customType: {startsWith: 1}}]);
	assert.equal(analyzeSessions([file]).handovers.length, 0);
});

it("preserves child-reported blocked outcomes and cancelled status while incomplete traces stay unknown", () => {
	const root = mkdtempSync(join(tmpdir(), "guild-report-"));
	const blocked = {protocol: "guild/2", version: 2, runId: "a", taskId: "task-a", role: "coder", profile: "typescript", taskOutcome: "blocked", compliance: [], summary: "Cannot proceed", blockers: ["Missing input"], limitations: [], payload: {changes: [], verification: []}};
	const entries = [header("bg"), journal("a", null, {...bgIdentity("a"), kind: "admitted"}),
		journal("end-a", "a", {...bgIdentity("a"), kind: "terminal", originEntryId: "a", report: {...bgTerminal("a"), status: "completed", exitCode: 0, report: blocked}}),
		journal("b", null, {...bgIdentity("b"), kind: "admitted"}),
		journal("end-b", "b", {...bgIdentity("b"), kind: "terminal", originEntryId: "b", report: {...bgTerminal("b"), status: "cancelled", exitCode: 130}}),
	];
	writeSession(join(root, "guild", "bg"), "a.jsonl", [{kind: "header", version: 1, runId: "a", startedAt: 0}]);
	writeSession(join(root, "guild", "bg"), "b.jsonl", [{kind: "header", version: 1, runId: "b"}, {kind: "end", endedAt: 10}]);
	const report = analyzeSessions([writeSession(root, "bg.jsonl", entries)]);
	assert.equal(report.handovers[0].taskOutcome, "blocked");
	assert.deepEqual(report.summary.byStatus, {completed: 1, cancelled: 1});
	assert.deepEqual(report.summary.backgroundExecution, {measured: 0, unknown: 2});
});

function collectedRuns(collision?: "collectionId" | "toolCallId" | "entryId", sessionId = "bg") {
	return ["a", "b"].flatMap(runId => {
		const identity = {...bgIdentity(runId), sessionId};
		const collectionId = collision === "collectionId" ? "shared" : `collection-${runId}`;
		const toolCallId = collision === "toolCallId" ? "shared" : `wait-${runId}`;
		return [journal(runId, null, {...identity, kind: "admitted"}),
			journal(`end-${runId}`, runId, {...identity, kind: "terminal", originEntryId: runId, report: bgTerminal(runId)}),
			journal(collision === "entryId" ? "shared" : `receipt-${runId}`, `end-${runId}`, {...identity, kind: "collected", originEntryId: runId, collectionId, toolCallId, native: "claimed"}),
			toolResult(toolCallId, "guild_wait", {guildBackground: {version: 1, sessionId, runId, taskId: identity.taskId, collectionId}}, {usage: cost(0.6)})];
	});
}

for (const field of ["collectionId", "toolCallId", "entryId"] as const) {
	it(`withholds both runs' native credit for a cross-run ${field} conflict`, () => {
		const root = mkdtempSync(join(tmpdir(), "guild-report-"));
		const entries = collectedRuns(field);
		for (const ordered of [entries, entries.slice(4).concat(entries.slice(0, 4))]) {
			const report = analyzeSessions([writeSession(root, "bg.jsonl", [header("bg"), ...ordered])]);
			assert.equal(report.handovers.length, 2);
			assert.deepEqual(report.handovers.map(run => run.childCost), [undefined, undefined]);
			assert.match(report.diagnostics?.join("\n") ?? "", new RegExp(`conflict.*${field}`, "i"));
		}
	});
}

it("credits distinct same-role runs and permits identical IDs in separate sessions", () => {
	const root = mkdtempSync(join(tmpdir(), "guild-report-"));
	const files = ["bg", "other"].map(sessionId => writeSession(root, `${sessionId}.jsonl`, [header(sessionId), ...collectedRuns(undefined, sessionId)]));
	const report = analyzeSessions(files);
	assert.equal(report.handovers.length, 4);
	assert.deepEqual(report.handovers.map(run => run.childCost), [0.6, 0.6, 0.6, 0.6]);
	assert.equal(report.summary.cost.child, 2.4);
	assert.equal(report.diagnostics, undefined);
});

it("skips malformed collision candidates without poisoning valid receipts or limiting offline history", () => {
	const root = mkdtempSync(join(tmpdir(), "guild-report-"));
	const entries = [header("bg"), ...collectedRuns(),
		journal("bad", null, {...bgIdentity("bad"), kind: "collected", collectionId: "collection-a", toolCallId: "wait-a", native: "claimed"}),
		...Array.from({length: 17}, (_, i) => journal(`old-${i}`, null, {...bgIdentity(`old-${i}`), kind: "admitted"}))];
	const report = analyzeSessions([writeSession(root, "bg.jsonl", entries)]);
	assert.equal(report.handovers.length, 19);
	assert.deepEqual(report.handovers.slice(0, 2).map(run => run.childCost), [0.6, 0.6]);
	assert.equal(report.diagnostics?.length, 1);
	assert.match(report.diagnostics![0], /skipped/);
});
