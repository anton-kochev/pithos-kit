import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digest } from "../src/manifest.ts";
import { createCampaign, openCampaign, readCampaignAdmissionOrigin, replayCampaignJournal } from "../src/campaign.ts";
import { createStore, transaction } from "../src/campaign-store.ts";
import { NATIVE_POLICY_V1 } from "../src/native-policy.ts";
import type { prepareAdmittedNativeLaunch } from "../src/admitted-native-launch.ts";
import type { PreparedLaunch } from "../src/campaign.ts";

// Compile-only contract: the parent constructor supplies a commitment, but the
// driver callback must still receive only its environment after journal commit.
type PreparedContract<T extends { environment: Record<string, string>; launch: PreparedLaunch }> = T;
type ConstructorContract = PreparedContract<Awaited<ReturnType<typeof prepareAdmittedNativeLaunch>>>;

function fixture() {
  const schedule = ["main-only", "guild-available"].map(arm => ({ taskId: "task-01", arm, repetition: 1 }));
  const spec: any = { version: 2, nativePolicy: structuredClone(NATIVE_POLICY_V1), schedule,
    bindings: { bankDigest: digest("bank"), scheduleDigest: digest(schedule), implementationDigest: digest("implementation"),
      runtimeDigest: digest("runtime"), policyDigest: digest("policy"), model: NATIVE_POLICY_V1.model, thinking: "high" },
    limits: { maxTrials: 2, estimatedUsd: 10, activeMs: 10000, workflowMs: 1000 },
    pricing: { version: 1, model: NATIVE_POLICY_V1.model, api: "openai-codex-responses", serviceTier: "base",
      cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 } } };
  const admission = { id: "00000000-0000-4000-8000-000000000001", slot: 0, scheduled: schedule[0], allowanceMs: 1000, activeAllowanceMs: 10000 };
  const start = { type: "started", admission };
  const launch = { version: 1, historyDigest: digest([start]), configurationSha256: digest("configuration"),
    runtimeRequirementSha256: digest("requirement"), invocationDigest: digest("invocation"), scopedAuthIdentityDigest: digest("identity"),
    implementationDigest: spec.bindings.implementationDigest, supervisorPid: 6 };
  const prepared = { type: "launch_prepared", id: admission.id, launch };
  return { spec, start, prepared };
}

test("rejects altered, unbound and duplicate launch records", () => {
  for (const mutate of [
    (e: any) => e.launch.historyDigest = digest([]),
    (e: any) => e.launch.implementationDigest = digest("other implementation"),
    (e: any) => e.launch.configurationSha256 = "invalid",
    (e: any) => delete e.launch.runtimeRequirementSha256,
    (e: any) => e.launch.invocationDigest = "A".repeat(64),
    (e: any) => e.launch.scopedAuthIdentityDigest = null,
    (e: any) => e.launch.supervisorPid = 1,
    (e: any) => e.launch.version = 2,
    (e: any) => e.launch.extra = "not permitted",
    (e: any) => e.extra = true,
    (e: any) => e.id = "00000000-0000-4000-8000-000000000002",
  ]) {
    const { spec, start, prepared } = fixture(); mutate(prepared);
    assert.throws(() => replayCampaignJournal(spec, [start, prepared] as any), /Invalid campaign/);
  }
  const { spec, start, prepared } = fixture();
  assert.throws(() => replayCampaignJournal(spec, [prepared] as any), /Invalid campaign/);
  assert.throws(() => replayCampaignJournal(spec, [start, prepared, prepared] as any), /Invalid campaign/);
});

test("journal preparation cannot downgrade native receipts to ordinary settlements", () => {
  const { spec, start, prepared } = fixture();
  const finish = { type: "finished", id: start.admission.id, elapsedMs: 1,
    receipt: { resultDigest: digest("result"), outcome: "recorded", estimatedUsd: 1, integrity: "ok" } };
  for (const prefix of [[start], [start, prepared]]) {
    assert.throws(() => replayCampaignJournal(spec, [...prefix, finish] as any), /Native trial evidence contract is required/);
  }
});

test("operational preparation rejects native and inert attempts before the visitor", async () => {
  const root = await mkdtemp(join(tmpdir(), "guild-launch-transaction-test-"));
  try {
    for (const native of [true, false]) {
      const { spec, start } = fixture();
      if (!native) { spec.version = 1; delete spec.nativePolicy; spec.bindings.model = "test/fake"; spec.pricing.model = "test/fake"; }
      const campaign = await createCampaign(join(root, native ? "native" : "inert"), spec);
      const id = native ? start.admission.id : (await campaign.admit(spec.bindings)).id;
      let calls = 0;
      await assert.rejects(campaign.prepareLaunch(id, async () => { calls++; throw Error("must not prepare"); }),
        native ? /Native campaign admission is disabled/ : /Native admitted launch mismatch/);
      assert.equal(calls, 0);
      assert.equal((await campaign.status()).events.length, native ? 0 : 1);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("storage bounds allow twelve native preparations without increasing the legacy event cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "guild-launch-capacity-test-"));
  try {
    for (const [version, limit] of [[2, 37], [1, 25]]) {
      const directory = join(root, String(version)), spec = { version };
      // Storage-envelope test only: these are not semantically valid campaign events.
      await createStore(directory, spec);
      for (let index = 0; index < limit; index++) await transaction(directory, spec, async (events, append) => {
        assert.equal(events.length, index); await append({ index });
      });
      await assert.rejects(transaction(directory, spec, async (_events, append) => append({ excess: true })), /Invalid campaign/);
      assert.equal(await transaction(directory, spec, async events => events.length), limit);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("prepared metadata does not open native history or become an inert launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "guild-launch-history-test-"));
  try {
    const { spec, start, prepared } = fixture(), directory = join(root, "campaign");
    await createStore(directory, spec);
    for (const event of [start, prepared]) await transaction(directory, spec, async (_events, append) => append(event));
    await assert.rejects(openCampaign(directory, spec), /native execution history is not supported/);
    const inert = structuredClone(spec); inert.version = 1; delete inert.nativePolicy;
    inert.bindings.model = "test/fake"; inert.pricing.model = "test/fake";
    assert.throws(() => replayCampaignJournal(inert, [start, prepared] as any), /invalid prepared launch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("validates a pending native launch record without granting an origin or certifying execution", () => {
  // Pure synthetic JSON records, not a native admission, file observation or host run.
  const { spec, start, prepared } = fixture();
  const state = replayCampaignJournal(spec, [start, prepared] as any);
  assert.deepEqual(state.preparedLaunch, prepared.launch);
  assert.throws(() => readCampaignAdmissionOrigin(state as any), /Campaign admission origin mismatch/);
  assert.equal(state.pending?.id, start.admission.id);
  assert.equal(state.finished, 0);
  assert.equal(state.estimatedUsd, null);
  assert.equal(state.activeMs, null);
  assert.deepEqual(state.blocked, ["pending_attempt", "unknown_active_time", "unknown_spend"]);
});
