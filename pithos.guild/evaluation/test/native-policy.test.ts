import assert from "node:assert/strict";
import { test } from "node:test";
import { CANDIDATE_NATIVE_POLICY_V2, NATIVE_POLICY_V1, validateNativePolicy } from "../src/native-policy.ts";

// Approval pin: these are requirements, not values to copy from a new runtime.
test("native policy v1 pins the reviewed runtime, cohort, auth and transport requirements", () => {
  const approved = { version: 1, node: "v24.20.0", pi: "0.85.1", piAi: "0.85.1",
    model: "openai-codex/gpt-6-astra", api: "openai-codex-responses", thinking: "high", serviceTier: "base",
    transport: "auto", authentication: "scoped-codex-access-only", evidence: "native-v1" };
  assert.deepEqual(NATIVE_POLICY_V1, approved);
  assert.equal(Object.isFrozen(NATIVE_POLICY_V1), true);
  const validated = validateNativePolicy(structuredClone(approved));
  assert.deepEqual(validated, approved); assert.notEqual(validated, NATIVE_POLICY_V1);
});

test("candidate native policy v2 is explicit and does not relabel reviewed native-v1 evidence", () => {
  assert.deepEqual(CANDIDATE_NATIVE_POLICY_V2, { ...NATIVE_POLICY_V1, version: 2, evidence: "candidate-native-v2" });
  assert.equal(Object.isFrozen(CANDIDATE_NATIVE_POLICY_V2), true);
  assert.deepEqual(validateNativePolicy(structuredClone(CANDIDATE_NATIVE_POLICY_V2)), CANDIDATE_NATIVE_POLICY_V2);
  assert.throws(() => validateNativePolicy({ ...NATIVE_POLICY_V1, version: 2 }), /Invalid native policy/);
});

test("runtime migration has a distinct unreviewed policy identity", async () => {
  const { CANDIDATE_NATIVE_POLICY_V3 } = await import("../src/native-policy.ts");
  assert.deepEqual(CANDIDATE_NATIVE_POLICY_V3, { ...CANDIDATE_NATIVE_POLICY_V2, version: 3, pi: "0.87.0", piAi: "0.87.0" });
  assert.deepEqual(validateNativePolicy(CANDIDATE_NATIVE_POLICY_V3), CANDIDATE_NATIVE_POLICY_V3);
  assert.throws(() => validateNativePolicy({ ...CANDIDATE_NATIVE_POLICY_V2, pi: "0.87.0", piAi: "0.87.0" }));
});
