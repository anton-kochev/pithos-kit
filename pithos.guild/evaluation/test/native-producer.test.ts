import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { digest } from "../src/manifest.ts";
import { createCandidateNativeEnvelope } from "../src/native-producer.ts";

const context = { trialId: randomUUID(), configurationSha256: digest("configuration"),
  runtimeRequirementSha256: digest("requirement"), invocationDigest: digest("invocation"),
  supervisorPid: 6, pid: 24, ppid: 6, actor: "parent" as const };

test("candidate producer envelope closes and binds retained events without authorizing execution", () => {
  const event = { type: "process_start", node: "v24.20.0" };
  const row = createCandidateNativeEnvelope(context, 0, event);
  assert.deepEqual(row, { version: 2, ...context, sequence: 0, event });
  assert.equal(Object.isFrozen(row), true); assert.equal(Object.isFrozen(row.event), true);
  event.node = "changed"; assert.equal(row.event.node, "v24.20.0");
  for (const changed of [{ ...context, actor: "other" }, { ...context, pid: 1 },
    { ...context, ppid: 24 }, { ...context, configurationSha256: "bad" }, { ...context, extra: true }])
    assert.throws(() => createCandidateNativeEnvelope(changed as any, 0, event), /Candidate native producer context mismatch/);
  assert.throws(() => createCandidateNativeEnvelope(context, -1, event), /Candidate native producer context mismatch/);
});
