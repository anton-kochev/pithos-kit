import assert from "node:assert/strict";
import { it } from "node:test";
import { GUILD_PROFILES } from "../src/agents.ts";
import { buildTask, childTools, validateInput, validateResult, validateTask } from "../src/protocol.ts";

const input = {role: "writer" as const, profile: "general" as const, task: "Write an article at docs/article.md using notes.md"};
const task = () => buildTask({...input, runId: "writer-run", taskId: "writer-task"});
function report() {
 const {task: _task, practices: _practices, ...header} = task();
 return {...header, taskOutcome: "succeeded", compliance: [], summary: "Drafted article", blockers: [], limitations: ["No web access"],
  payload: {artifacts: [{path: "docs/article.md", description: "Complete draft"}], sources: [{reference: "notes.md", usage: "Supplied background"}], checks: [{check: "Audience and length", outcome: "Reviewed against brief"}]}};
}

it("admits writer/general only at every input and task envelope boundary", () => {
 assert.deepEqual(validateInput(input), {...input, practices: []});
 assert.deepEqual(validateTask(task()), task());
 for (const profile of GUILD_PROFILES.filter(profile => profile !== "general")) {
  assert.throws(() => validateInput({...input, profile}), /unsupported/i);
  assert.throws(() => buildTask({...input, profile, runId: "r", taskId: "t"}), /unsupported/i);
  assert.throws(() => validateTask({...task(), profile}), /unsupported/i);
 }
 assert.throws(() => validateInput({...input, practices: [{id: "tdd", policy: "required"}]}), /practices/i);
 assert.deepEqual(childTools("writer"), ["read", "grep", "find", "ls", "git_read", "edit", "write", "guild_submit_result"]);
});

it("validates bounded writer artifacts, sources and editorial checks without changing guild/2", () => {
 assert.deepEqual(validateResult(report(), task()), report());
 assert.equal(task().version, 2);
 const blocked = {...report(), taskOutcome: "blocked", blockers: ["Output destination missing"], payload: {artifacts: [], sources: [], checks: []}};
 assert.deepEqual(validateResult(blocked, task()), blocked);
 for (const payload of [
  {artifacts: [], sources: [], checks: []},
  {...report().payload, artifacts: [{path: "  ", description: "Draft"}]},
  {...report().payload, artifacts: [{path: "docs/a.md", description: ""}]},
  {...report().payload, sources: [{reference: "notes.md", usage: "Read", invented: true}]},
  {...report().payload, checks: [{check: "Read", outcome: "Yes", certified: true}]},
  {...report().payload, content: "Not an inline transport"},
  {...report().payload, artifacts: [{path: "docs/a.md", description: "🙂".repeat(513)}]},
  {...report().payload, artifacts: Array(33).fill({path: "docs/a.md", description: "Draft"})},
 ]) assert.throws(() => validateResult({...report(), payload}, task()));
 assert.throws(() => validateResult({...report(), blockers: ["Missing evidence"]}, task()));
});
