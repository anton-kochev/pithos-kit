import assert from "node:assert/strict";
import { test } from "node:test";
import { digest, validateBank } from "../src/manifest.ts";

export function sampleBank(): any {
  const fixture = { files: { "README.md": "A fixture\n" }, staged: {}, untracked: {} };
  return { version: 1, tasks: [{
    id: "fact-01", split: "development", prompt: "Read README.md without edits.",
    fixture, fixtureDigest: digest(fixture), allowedChanges: [], grader: "unchanged",
    rubric: ["Report the observed fact with path evidence."], delegation: "abstain",
  }] };
}

test("accepts a content-addressed development task bank", () => {
  assert.equal(validateBank(sampleBank()).tasks[0].id, "fact-01");
});

test("rejects malformed contracts and changed fixture content before execution", () => {
  const mutations = [
    (b: any) => { b.version = 2; },
    (b: any) => { b.extra = true; },
    (b: any) => { b.tasks.push(b.tasks[0]); },
    (b: any) => { b.tasks[0].fixture.files["README.md"] = "changed"; },
    (b: any) => { b.tasks[0].grader = "shell-command"; },
    (b: any) => { b.tasks[0].prompt = " "; },
    (b: any) => { b.tasks[0].split = "test"; },
    (b: any) => { b.tasks[0].allowedChanges = ["../user.txt"]; },
  ];
  for (const mutate of mutations) {
    const bank = sampleBank(); mutate(bank);
    assert.throws(() => validateBank(bank));
  }
});

test("rejects unsafe, colliding, and reserved fixture paths even with a valid digest", () => {
  for (const name of ["../escape", "/absolute", "a/../b", ".git/config", ".pi/settings.json", "a\\\\b", "C:/x", "a//b", "README.md/x"]) {
    const bank = sampleBank();
    bank.tasks[0].fixture.files[name] = "bad";
    bank.tasks[0].fixtureDigest = digest(bank.tasks[0].fixture);
    assert.throws(() => validateBank(bank), name);
  }
});
