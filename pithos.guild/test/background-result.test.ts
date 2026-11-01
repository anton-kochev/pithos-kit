import assert from "node:assert/strict";
import test from "node:test";
import { buildTask, validateResult, LIMITS } from "../src/protocol.ts";
import { createEmptyGuildRoleRunResult } from "../src/runner.ts";
import { projectBackgroundResult } from "../src/background-result.ts";
import { BackgroundRunRegistry } from "../src/background-runs.ts";

const task = buildTask({role: "coder", profile: "typescript", task: "private task", runId: "run", taskId: "task"});
function fixture() {
 const result = createEmptyGuildRoleRunResult(task.role, task.profile, task.task);
 Object.assign(result, {runId: task.runId, taskId: task.taskId, status: "completed", model: undefined, errorMessage: undefined,
  report: validateResult({protocol: "guild/2", version: 2, runId: task.runId, taskId: task.taskId, role: task.role, profile: task.profile,
   taskOutcome: "succeeded", compliance: [], summary: "Done", blockers: [], limitations: [], payload: {changes: [], verification: []}}, task)});
 result.output = "duplicate rendered report";
 result.stderr = "raw stderr";
 return result;
}

test("projects ordinary success without undefined optionals or raw run content", () => {
 const source = fixture();
 const dto = projectBackgroundResult(source, task);
 assert.equal(dto.status, "completed");
 assert.equal(dto.role, task.role);
 assert.equal(dto.profile, task.profile);
 assert.deepEqual(dto.report, source.report);
 assert.deepEqual(dto.usage, source.usage);
 assert.deepEqual(JSON.parse(JSON.stringify(dto)), dto);
 for (const key of ["task", "output", "stderr", "activity", "providerUsage", "model", "diagnostic"]) assert.equal(Object.hasOwn(dto, key), false);
});

test("retains a maximum-size validated report and reasonable metadata through the real registry", async () => {
 const source = fixture();
 const report = source.report!;
 // Fill to the existing protocol budget, not a smaller projection-specific limit.
 report.limitations = Array.from({length: 23}, () => "x".repeat(2048));
 const remaining = LIMITS.result - Buffer.byteLength(JSON.stringify(report));
 report.summary += "x".repeat(remaining);
 assert.equal(Buffer.byteLength(JSON.stringify(report)), LIMITS.result);
 validateResult(report, task);
 source.model = "provider/model";
 source.usageKnown = false;
 source.usageFields = ["input", "cost"];
 const dto = projectBackgroundResult(source, task);
 assert.equal(dto.model, source.model);
 assert.equal(dto.usageKnown, false);
 assert.deepEqual(dto.usageFields, source.usageFields);
 const registry = new BackgroundRunRegistry(() => dto);
 try {
  const started = registry.start({role: task.role, profile: task.profile, task: task.task});
  assert.equal((await registry.wait(started.id, 1000)).reason, "terminal");
  const snapshot = registry.status(started.id);
  assert.equal(snapshot.status, "completed");
  assert.deepEqual(snapshot.result, dto);
  assert.deepEqual((snapshot.result as typeof dto).report, report);
 } finally { await registry.shutdown(); }
});

test("rejects invalid identity, reports, numeric usage and non-JSON or oversized terminal payloads", () => {
 const mutations: Array<(value: ReturnType<typeof fixture>) => void> = [
  value => { value.runId = "other"; },
  value => { value.taskId = undefined; },
  value => { value.profile = "general"; },
  value => { value.role = "reviewer"; },
  value => { value.status = undefined; },
  value => { value.report = undefined; },
  value => { value.report!.runId = "other"; },
  value => { value.report!.summary = "x".repeat(2049); },
  value => { value.report!.limitations = Array(25).fill("x".repeat(2048)); },
  value => { value.report!.payload = {} as never; },
  value => { value.report!.compliance = [{id: "tdd"}] as never; },
  value => { value.report!.summary = undefined as never; },
  value => { Object.defineProperty(value.report!, "summary", {get: () => "Done"}); },
  value => { Object.defineProperty(value.report!, "hidden", {value: 1}); },
  value => { (value.report as any).extra = Symbol("not JSON"); },
  value => { (value.report as any).extra = value.report; },
  value => { value.report!.limitations = new Array(1); },
  value => { value.report = new Proxy(value.report!, {}); },
  value => { value.usage.input = NaN; },
  value => { value.usage.cost = Infinity; },
  value => { value.usage.turns = "1" as never; },
  value => { value.usage = new Date() as never; },
  value => { (value.usage as any).toJSON = () => ({}); },
  value => { value.usageFields = ["unknown"] as never; },
  value => { value.usageKnown = "yes" as never; },
  value => { value.exitCode = NaN; },
  value => { value.model = "x".repeat(64 * 1024); },
 ];
 for (const [index, mutate] of mutations.entries()) {
  const value = fixture();
  mutate(value);
  assert.throws(() => projectBackgroundResult(value, task), `mutation ${index}`);
 }
});

test("failure and cancellation retain reports without becoming registry success, with bounded diagnostics", async () => {
 for (const status of ["failed", "cancelled"] as const) {
  const source = fixture();
  source.status = status;
  source.errorMessage = "😀".repeat(600);
  const dto = projectBackgroundResult(source, task);
  assert.equal(dto.status, status);
  assert.equal(dto.diagnostic, "😀".repeat(512));
  assert.equal(Buffer.byteLength(dto.diagnostic!), 2048);
  assert.deepEqual(dto.report, source.report);
  const registry = new BackgroundRunRegistry(() => dto);
  try {
   const {id} = registry.start({role: task.role, profile: task.profile, task: task.task});
   await registry.wait(id, 1000);
   assert.equal(registry.status(id).status, status);
   assert.deepEqual(registry.status(id).result, dto);
  } finally { await registry.shutdown(); }
  source.report = undefined;
  assert.equal(projectBackgroundResult(source, task).status, status);
 }
 const inconsistent = fixture();
 inconsistent.exitCode = 1;
 assert.throws(() => projectBackgroundResult(inconsistent, task), /completed/i);
});

test("projection owns an independent deep copy", () => {
 const source = fixture();
 source.usageFields = ["input"];
 const dto = projectBackgroundResult(source, task);
 source.report!.summary = "changed";
 source.usage.input = 42;
 source.usageFields.push("cost");
 assert.equal(dto.report!.summary, "Done");
 assert.equal(dto.usage.input, 0);
 assert.deepEqual(dto.usageFields, ["input"]);
 dto.report!.limitations.push("local");
 assert.deepEqual(source.report!.limitations, []);
});

test("rejects executable top-level input without invoking getters or proxy traps", () => {
 let invoked = false;
 const source = fixture();
 Object.defineProperty(source, "report", {get() { invoked = true; return fixture().report; }});
 assert.throws(() => projectBackgroundResult(source, task));
 assert.equal(invoked, false);
 assert.throws(() => projectBackgroundResult(new Proxy(fixture(), {get() { invoked = true; }}), task));
 assert.equal(invoked, false);
});
