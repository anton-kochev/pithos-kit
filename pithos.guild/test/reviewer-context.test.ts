import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { buildTask, validateResult } from "../src/protocol.ts";
import { report } from "./protocol-fixtures.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// These checks protect the instruction contract, not a model's reasoning quality.
for (const path of ["agents/roles/reviewer.md", "skills/code-review-standards/SKILL.md"]) {
  it(`${path} requires independent judgment and honest context limits`, () => {
    const text = read(path);
    for (const contract of [
      /original (?:user )?(?:needs|requirement)/i,
      /plan[^\n]*(?:optional|not mandatory)/i,
      /planning\/design gaps/,
      /tests[^\n]*implementation assumptions/i,
      /explicit user decisions[^\n]*consequential evidence/i,
      /missing essentials[^\n]*blocked/i,
      /retain independently supported findings/i,
      /never silently narrow/i,
      /missing context[^\n]*not[^\n]*severity/i,
      /taskOutcome[^\n]*verdict/,
      /guild_submit_result/,
    ]) assert.match(text, contract, `${path}: ${contract}`);
  });
}

it("both parent entry points carry the review brief and gap-closure contract", () => {
  const source = read("src/guild.ts");
  const help = source.slice(source.indexOf("const GUILD_HANDOVER_HELP"), source.indexOf("const GUILD_HANDOVER_PARAMETERS"));
  const guidelines = source.slice(source.indexOf("promptGuidelines:"), source.indexOf("parameters: GUILD_HANDOVER_PARAMETERS"));
  for (const text of [help, guidelines, read("README.md")]) {
    for (const contract of [/original requirement/i, /verbatim/i, /user constraints and decisions/i,
      /implementer assumptions/i, /scope and comparison/i, /plan[^\n]*optional/i,
      /verification evidence and limitations/i, /explicit local (?:file )?paths/i,
      /read (?:them|those files)/i, /secrets/i, /another review/i, /limited review as complete/i]) {
      assert.match(text, contract);
    }
  }
});

it("existing guild/2 reports retain supported findings when essential context blocks completion", () => {
  const task = buildTask({role: "reviewer", profile: "typescript", task: "Review retry safety and product intent", runId: "review", taskId: "context"});
  const blocked = {...report(task), taskOutcome: "blocked", blockers: ["Missing original retry semantics requirement; parent must supply it."],
    limitations: ["Cannot assess product intent; duplicate-write path independently inspectable."],
    payload: {scope: ["src/retry.ts against HEAD; product intent unassessed"], findings: [{severity: "Medium", reference: "src/retry.ts:12", finding: "Implementation bug: retry repeats a committed write after response loss; use an idempotency key."}], verdict: "Request changes"}};
  assert.deepEqual(validateResult(blocked, task), blocked);
  const missingOnly = {...blocked, payload: {...blocked.payload, findings: [], verdict: "Comment"}};
  assert.deepEqual(validateResult(missingOnly, task), missingOnly);
  assert.throws(() => validateResult({...blocked, blockers: []}, task));
  assert.throws(() => validateResult({...blocked, payload: {...blocked.payload, reviewContext: {}}}, task));
});
