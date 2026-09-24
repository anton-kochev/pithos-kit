import assert from "node:assert/strict";
import { it } from "node:test";
import * as protocol from "../src/protocol.ts";
import { GUILD_ROLES, GUILD_PROFILES } from "../src/agents.ts";
import { Check } from "typebox/value";

it("exposes provider-compatible child schema without losing exact identity and enum validation", () => {
 const task = protocol.buildTask({role: "coder", profile: "general", task: "Work", runId: "run", taskId: "task", practices: [{id: "tdd", policy: "required"}]});
 const schema = protocol.resultSchema(task);
 assert.doesNotMatch(JSON.stringify(schema), /"(?:anyOf|oneOf|const)"\s*:/);
 const claim = {id: "tdd", policy: "required", status: "satisfied", reason: "", cycles: [cycle()], limitations: []};
 const valid = {...report(task), compliance: [claim]};
 assert.equal(Check(schema, valid), true);
 for (const patch of [{version: 1}, {version: 2.5}, {protocol: "guild/1"}, {runId: "other"}, {taskId: "other"}, {taskOutcome: "waived"}, {compliance: [{...claim, status: "waived"}]}, {compliance: [{...claim, id: "other"}]}, {compliance: [{...claim, policy: "optional"}]}, {compliance: [{...claim, cycles: [{...cycle(), red: {...cycle().red, outcome: "waived"}}]}]}]) {
  assert.equal(Check(schema, {...valid, ...patch}), false, JSON.stringify(patch));
  assert.throws(() => protocol.validateResult({...valid, ...patch}, task));
 }
});

it("renders bounded child-reported blocked and satisfied TDD claims without claiming host verification", () => {
 const task = host(required);
 const blocked = protocol.validateResult({...report(task), taskOutcome: "blocked", blockers: ["No executable test"], compliance: [{...satisfied(), status: "blocked", reason: "No preimplementation red", cycles: [], limitations: ["Tests unavailable"]}]}, task);
 const blockedText = protocol.renderReport(blocked);
 assert.match(blockedText, /## taskOutcome\nblocked/);
 assert.match(blockedText, /## compliance\n/);
 assert.match(blockedText, /No preimplementation red/);
 assert.match(blockedText, /Tests unavailable/);
 assert.match(blockedText, /child-reported claims \(not host-verified\)/);
 const successful = protocol.validateResult({...report(task), compliance: [satisfied()]}, task);
 const satisfiedText = protocol.renderReport(successful);
 assert.match(satisfiedText, /## taskOutcome\nsucceeded/);
 assert.match(satisfiedText, /"status":"satisfied"/);
 assert.match(satisfiedText, /"outcome":"expected-failure"/);
 assert.match(satisfiedText, /"outcome":"passed"/);
 assert.ok(Buffer.byteLength(satisfiedText) <= 50 * 1024);
});

it("normalizes exact canonical and legacy inputs with copied coder-only practices", () => {
 const base = {role: "coder", profile: "general", task: " original\n task "};
 const practices = [{id: "tdd", policy: "required"}];
 assert.deepEqual(protocol.validateInput(base), {...base, practices: []});
 assert.deepEqual(protocol.validateInput({member: "typescript-coder", task: base.task}), {...base, profile: "typescript", practices: []});
 const accepted = protocol.validateInput({...base, practices});
 practices[0].id = "changed";
 assert.deepEqual(accepted.practices, [{id: "tdd", policy: "required"}]);
 for (const role of GUILD_ROLES) for (const profile of GUILD_PROFILES) {
  assert.deepEqual(protocol.validateInput({...base, role, profile}).practices, []);
  const required = {...base, role, profile, practices: [{id: "tdd", policy: "required"}]};
  if (role === "coder") assert.equal(protocol.validateInput(required).practices.length, 1);
  else assert.throws(() => protocol.validateInput(required));
 }
 for (const patch of [{extra: true}, {member: "typescript-coder"}, {practices: null}, {practices: {}}, {practices: ["tdd"]}, {practices: [{id: "unknown", policy: "required"}]}, {practices: [{id: "tdd", policy: "optional"}]}, {practices: [{id: "tdd", policy: "required", extra: {}}]}, {practices: Array(2).fill({id: "tdd", policy: "required"})}]) assert.throws(() => protocol.validateInput({...base, ...patch}));
 for (const input of [null, [], {member: "unknown", task: "Work"}, {member: "typescript-coder", task: "Work", practices: []}]) assert.throws(() => protocol.validateInput(input));
});

it("bounds original task and compact canonical JSON in UTF-8 bytes", () => {
 const base = {role: "coder", profile: "general", task: "🙂".repeat(8192)};
 assert.equal(protocol.validateInput(base).task, base.task);
 for (const task of ["", " \n\t", "a\0b", base.task + "x", "\u0001".repeat(7000)]) assert.throws(() => protocol.validateInput({...base, task}));
 const overhead = Buffer.byteLength(JSON.stringify({...base, task: "", practices: []}));
 const escaped = "\u0001".repeat(6000);
 const task = escaped + "a".repeat(40 * 1024 - overhead - 36000);
 assert.equal(Buffer.byteLength(JSON.stringify({...base, task, practices: []})), 40 * 1024);
 assert.equal(protocol.validateInput({...base, task}).task, task);
 assert.throws(() => protocol.validateInput({...base, task: task + "a"}));
});

it("builds and validates exact v2 host envelopes separately from public input", () => {
 const input = {role: "coder" as const, profile: "general" as const, task: " Work ", runId: "🙂".repeat(32), taskId: "task"};
 const task = protocol.buildTask(input);
 assert.equal(task.version, 2);
 assert.deepEqual(task.practices, []);
 assert.deepEqual(protocol.validateTask(task), task);
 assert.throws(() => protocol.validateInput(task));
 for (const patch of [{version: 1}, {protocol: "guild/1"}, {extra: true}, {runId: " "}, {taskId: "🙂".repeat(33)}, {practices: null}, {task: "\0"}]) assert.throws(() => protocol.validateTask({...task, ...patch}));
 const {practices: _practices, ...missing} = task;
 assert.throws(() => protocol.validateTask(missing));
 assert.throws(() => protocol.buildTask({...input, extra: true} as any));
 assert.throws(() => protocol.buildTask({...input, runId: " "}));
});

import { report } from "./protocol-fixtures.ts";
const host = (practices: protocol.GuildPractice[] = []) => protocol.buildTask({role: "coder", profile: "general", task: "Work", runId: "run", taskId: "task", practices});
const required: protocol.GuildPractice[] = [{id: "tdd", policy: "required"}];
const cycle = () => ({behavior: "reject blank input", test: "test/input.ts", red: {command: "npm test", outcome: "expected-failure", exitCode: 1, observed: "Missing expected exception", evidence: ["/tmp/red.log"]}, green: {command: "npm test", outcome: "passed", exitCode: 0, observed: "1 passed", evidence: ["/tmp/green.log"]}});
const satisfied = () => ({id: "tdd", policy: "required", status: "satisfied", reason: "", cycles: [cycle()], limitations: []});
// Static report types must not admit unsupported TypeBox enum strings.
// @ts-expect-error unsupported practice ID
const invalidId: protocol.TddCompliance["id"] = "unknown";
// @ts-expect-error unsupported policy
const invalidPolicy: protocol.TddCompliance["policy"] = "optional";
// @ts-expect-error unsupported status
const invalidStatus: protocol.TddCompliance["status"] = "waived";
// @ts-expect-error unsupported outcome
const invalidOutcome: protocol.GuildReport["taskOutcome"] = "waived";
// @ts-expect-error unsupported protocol version
const invalidVersion: protocol.GuildReport["version"] = 3;
void [invalidId, invalidPolicy, invalidStatus, invalidOutcome, invalidVersion];
it("requires exactly request-correlated compliance on every v2 report", () => {
 for (const task of [host(), host(required)]) {
  const compliance = task.practices.length ? [satisfied()] : [];
  const valid = {...report(task), taskOutcome: "succeeded", compliance};
  assert.deepEqual(protocol.validateResult(valid, task), valid);
  const {compliance: _, ...missing} = valid;
  assert.throws(() => protocol.validateResult(missing, task));
  assert.throws(() => protocol.validateResult({...valid, compliance: task.practices.length ? [] : [satisfied()]}, task));
  assert.throws(() => protocol.validateResult({...valid, compliance: [satisfied(), satisfied()]}, task));
 }
});
it("accepts satisfied TDD only with bounded completed same-command red-green cycles", () => {
 const task = host(required);
 const validate = (claim: unknown) => protocol.validateResult({...report(task), compliance: [claim]}, task);
 assert.doesNotThrow(() => validate(satisfied()));
 for (const patch of [{reason: "waived"}, {cycles: []}, {cycles: Array(9).fill(cycle())}, {limitations: undefined}, {limitations: Array(33).fill("x")}, {id: "other"}, {policy: "optional"}, {status: "waived"}, {extra: true}]) assert.throws(() => validate({...satisfied(), ...patch}));
 for (const field of ["behavior", "test"] as const) for (const value of [" ", "🙂".repeat(513)]) assert.throws(() => validate({...satisfied(), cycles: [{...cycle(), [field]: value}]}));
 for (const side of ["red", "green"] as const) {
  for (const patch of [{command: " "}, {observed: "\n"}, {evidence: []}, {evidence: [" "]}, {evidence: Array(5).fill("ref")}, {exitCode: -1}, {exitCode: 256}, {exitCode: 1.5}, {extra: true}, {command: "different"}, {outcome: side === "red" ? "passed" : "expected-failure"}, {exitCode: side === "red" ? 0 : 1}]) assert.throws(() => validate({...satisfied(), cycles: [{...cycle(), [side]: {...cycle()[side], ...patch}}]}));
 }
 assert.doesNotThrow(() => validate({...satisfied(), cycles: Array(8).fill(cycle())}));
});
it("keeps task outcome consistent with honest blockers and required compliance", () => {
 const task = host(required);
 const blocked = {...satisfied(), status: "blocked", reason: "Cannot execute tests", cycles: []};
 const base = {...report(task), taskOutcome: "blocked", blockers: ["Test execution unavailable"], compliance: [blocked]};
 assert.deepEqual(protocol.validateResult(base, task), base);
 for (const patch of [{taskOutcome: "succeeded"}, {blockers: []}, {blockers: [" "]}, {compliance: [{...blocked, reason: " "}]}]) assert.throws(() => protocol.validateResult({...base, ...patch}, task));
 assert.doesNotThrow(() => protocol.validateResult({...base, compliance: [satisfied()]}, task));
 assert.throws(() => protocol.validateResult({...base, taskOutcome: "succeeded", blockers: []}, task));
 const plain = host();
 assert.throws(() => protocol.validateResult({...report(plain), blockers: ["unrelated blocker"]}, plain));
 const reviewer = protocol.buildTask({role: "reviewer", profile: "general", task: "Review", runId: "r", taskId: "t"});
 assert.doesNotThrow(() => protocol.validateResult({...report(reviewer), payload: {scope: [], findings: [], verdict: "Request changes"}}, reviewer));
});
