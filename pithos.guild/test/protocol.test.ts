import assert from "node:assert/strict";
import { it } from "node:test";
import { GUILD_ROLES, GUILD_PROFILES } from "../src/agents.ts";
import { buildTask, validateResult } from "../src/protocol.ts";

import { report } from "./protocol-fixtures.ts";

it("builds one original-text task and validates all 24 role/profile result contracts", () => {
 for (const role of GUILD_ROLES) for (const profile of GUILD_PROFILES) {
  const task = buildTask({ role, profile, task: " original task ", runId: "run", taskId: "task" });
  assert.equal(task.task, " original task ");
  assert.equal(task.protocol, "guild/2");
  assert.equal(task.taskId, "task");
  assert.deepEqual(validateResult(report(task), task), report(task));
 }
});

it("rejects wrong identity, unknown nested keys and UTF-8/list/total overflow", () => {
 const task = buildTask({ role: "coder", profile: "general", task: "Do work", runId: "run", taskId: "task" });
 const base = report(task);
 for (const patch of [{protocol: "guild/1"}, {version: 1}, {runId: "other"}, {taskId: "other"}, {role: "reviewer"}, {profile: "rust"}, {extra: true}, {payload: {changes: [], verification: [], extra: true}}, {summary: "🙂".repeat(513)}, {blockers: Array(33).fill("x")}, {blockers: Array(32).fill("x".repeat(2048))}]) {
  assert.throws(() => validateResult({...base, ...patch}, task));
 }
 assert.equal(validateResult({...base, summary: "🙂".repeat(512)}, task).summary.length, 1024);
});
it("keeps the task builder deterministic for host-assigned identities", () => {
 const input = {role: "coder" as const, profile: "general" as const, task: "Work", runId: "run", taskId: "task"};
 assert.deepEqual(buildTask(input), buildTask(input));
 assert.equal(buildTask(input).taskId, "task");
});
it("rejects unknown nested record fields and out-of-contract role payloads", () => {
 const invalidPayloads = {
  explorer: {observations: [{reference: "src/a.ts:1", observation: "Seen", certified: true}], unknowns: []},
  architect: {decisions: [], contracts: [], handoff: [], lease: true},
  coder: {changes: [], verification: [{command: "not run", outcome: "not run", passed: true}]},
  reviewer: {scope: [], findings: [{severity: "Medium", reference: "src/a.ts:1", finding: "Issue", verified: true}], verdict: "Approve"},
 };
 for (const role of GUILD_ROLES) {
  const task = buildTask({role, profile: "general", task: "Work", runId: "run", taskId: "task"});
  assert.throws(() => validateResult({...report(task), payload: invalidPayloads[role]}, task), role);
 }
 const task = buildTask({role: "reviewer", profile: "general", task: "Work", runId: "run", taskId: "task"});
 assert.throws(() => validateResult({...report(task), payload: {scope: [], findings: [], verdict: "Certified"}}, task));
});
