import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createGuildTraceRecorder } from "../src/trace-recorder.ts";

const telemetry = channel("pithos.guild.child");
const enabled = { PITHOS_GUILD_TRACE: "1" };

function publisher(runId: string, childId = `${runId}-child`) {
 let sequence = 0;
 return (event: Record<string, unknown>) => telemetry.publish({version: 1, childId, runId, role: "coder", profile: "general", sequence: sequence++, ...event});
}

function chunk(text: string) {
 return {type: "stdout", base64: Buffer.from(text).toString("base64")};
}

function lines(file: string) {
 return readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
}

it("records nothing unless PITHOS_GUILD_TRACE is exactly 1", () => {
 assert.equal(createGuildTraceRecorder({env: {}}), undefined);
 assert.equal(createGuildTraceRecorder({env: {PITHOS_GUILD_TRACE: "true"}}), undefined);
});

it("records a bound child as header, finalized events, stderr and end in private files", () => {
 const root = mkdtempSync(join(tmpdir(), "guild-trace-"));
 const recorder = createGuildTraceRecorder({env: enabled, now: () => 1000})!;
 try {
  recorder.bind("run-1", {sessionDir: root, sessionId: "session-1", sessionFile: join(root, "s.jsonl"), model: "provider/model", thinkingLevel: "high", repoState: {state: "run-1.state", head: "abc", dirty: true, complete: true}});
  const publish = publisher("run-1");
  publish({type: "start"});
  publish(chunk('{"type":"message_start"}\n{"type":"message_upd'));
  publish(chunk('ate","message":{"content":"partial"}}\nnot json\n{"type":"message_end","message":{"role":"assistant"}}\n'));
  publish({type: "stderr", base64: Buffer.from("warning").toString("base64")});
  publish({type: "end", exitCode: 0, aborted: false, selectedSkills: [{id: "tdd"}]});
  const file = join(root, "guild", "session-1", "run-1-child.jsonl");
  assert.deepEqual(lines(file), [
   {kind: "header", version: 1, runId: "run-1", childId: "run-1-child", role: "coder", profile: "general", parentSessionId: "session-1", parentSessionFile: join(root, "s.jsonl"), parentModel: "provider/model", thinkingLevel: "high", repoState: {state: "run-1.state", head: "abc", dirty: true, complete: true}, startedAt: 1000},
   {kind: "event", event: {type: "message_start"}},
   {kind: "stdout", text: "not json"},
   {kind: "event", event: {type: "message_end", message: {role: "assistant"}}},
   {kind: "stderr", text: "warning"},
   {kind: "end", exitCode: 0, aborted: false, selectedSkills: [{id: "tdd"}], endedAt: 1000},
  ]);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(root, "guild", "session-1")).mode & 0o777, 0o700);
 } finally {
  recorder.dispose();
 }
});

it("ignores unbound runs and stops after dispose or unbind", () => {
 const root = mkdtempSync(join(tmpdir(), "guild-trace-"));
 const recorder = createGuildTraceRecorder({env: enabled})!;
 publisher("unbound")({type: "start"});
 const unbind = recorder.bind("unbound-later", {sessionDir: root, sessionId: "s"});
 unbind();
 publisher("unbound-later")({type: "start"});
 recorder.bind("disposed", {sessionDir: root, sessionId: "s"});
 recorder.dispose();
 publisher("disposed")({type: "start"});
 assert.equal(existsSync(join(root, "guild")), false);
});

it("writes one truncation marker at the byte cap and still records the end", () => {
 const root = mkdtempSync(join(tmpdir(), "guild-trace-"));
 const recorder = createGuildTraceRecorder({env: enabled, maxBytes: 600})!;
 try {
  recorder.bind("run-cap", {sessionDir: root, sessionId: "s"});
  const publish = publisher("run-cap");
  publish({type: "start"});
  for (let index = 0; index < 20; index++) publish(chunk(`{"type":"tool_execution_end","result":"${"x".repeat(100)}"}\n`));
  publish({type: "end", exitCode: 1, aborted: true, selectedSkills: []});
  const kinds = lines(join(root, "guild", "s", "run-cap-child.jsonl")).map(line => line.kind);
  assert.equal(kinds.filter(kind => kind === "truncated").length, 1);
  assert.equal(kinds.at(-1), "end");
  assert.ok(kinds.filter(kind => kind === "event").length < 20);
 } finally {
  recorder.dispose();
 }
});

it("reports write failures to the log without throwing into the run", () => {
 const root = mkdtempSync(join(tmpdir(), "guild-trace-"));
 const blocked = join(root, "not-a-directory");
 writeFileSync(blocked, "");
 const warnings: Array<[string, unknown]> = [];
 const recorder = createGuildTraceRecorder({env: enabled, log: {warn: (event, metadata) => warnings.push([event, metadata])}})!;
 try {
  recorder.bind("run-fail", {sessionDir: blocked, sessionId: "s"});
  const publish = publisher("run-fail");
  assert.doesNotThrow(() => {
   publish({type: "start"});
   publish(chunk('{"type":"message_end"}\n'));
   publish({type: "end", exitCode: 0, aborted: false, selectedSkills: []});
  });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], "trace.error");
 } finally {
  recorder.dispose();
 }
});
