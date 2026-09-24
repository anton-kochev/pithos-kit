import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { performance } from "node:perf_hooks";
import { prepareAdmittedNativeLaunch } from "../src/admitted-native-launch.ts";
import { bindAdmittedNativeRuntimeRequirement } from "../src/native-runtime-observation.ts";
import { deriveAdmittedTrialInput } from "../src/native-trial-binding.ts";
import { NATIVE_POLICY_V1 } from "../src/native-policy.ts";
import { loadDevelopmentBank } from "../src/bank.ts";
import { digest } from "../src/manifest.ts";
import { createSchedule } from "../src/runner.ts";
import { createCampaign, openCampaign, readCampaignAdmissionOrigin, type CampaignAdmissionOrigin } from "../src/campaign.ts";

test("origin identity cannot be cloned or used outside its successful or failed scope", async () => {
  await fixture(async ({ campaign, spec }) => {
    const admission = await campaign.admit(spec.bindings);
    let escaped: CampaignAdmissionOrigin;
    for (const fail of [false, true]) {
      const pending = campaign.withAdmissionOrigin(admission.id, async origin => {
        escaped = origin;
        for (const fake of [{}, structuredClone(origin), null]) assert.throws(() => readCampaignAdmissionOrigin(fake as any), /Campaign admission origin mismatch/);
        if (fail) throw Error("inert callback failure");
      });
      if (fail) await assert.rejects(pending, /inert callback failure/); else await pending;
      assert.throws(() => readCampaignAdmissionOrigin(escaped!), /Campaign admission origin mismatch/);
    }
  });
});

test("wrong, reopened and settled admissions cannot supply origins", async () => {
  await fixture(async ({ campaign, spec, directory }) => {
    const admission = await campaign.admit(spec.bindings), reopened = await openCampaign(directory, spec);
    const visit = async () => { assert.fail("visitor must not run"); };
    await assert.rejects(campaign.withAdmissionOrigin("not-admitted", visit), /Campaign admission origin mismatch/);
    await assert.rejects(reopened.withAdmissionOrigin(admission.id, visit), /Campaign admission origin mismatch/);
    await campaign.finish(admission.id, { resultDigest: digest("inert"), outcome: "recorded", estimatedUsd: 0, integrity: "ok" });
    await assert.rejects(campaign.withAdmissionOrigin(admission.id, visit), /Campaign admission origin mismatch/);
  });
});

test("deadline expiry invalidates reads and prevents successful scope completion", async t => {
  let now = 0; t.mock.method(performance, "now", () => now);
  await fixture(async ({ campaign, spec }) => {
    const admission = await campaign.admit(spec.bindings);
    await assert.rejects(campaign.withAdmissionOrigin(admission.id, async origin => {
      now = admission.allowanceMs - 1; assert.equal(readCampaignAdmissionOrigin(origin).admission.id, admission.id);
      now++; assert.throws(() => readCampaignAdmissionOrigin(origin), /Campaign admission origin mismatch/);
    }), /Campaign admission origin mismatch/);
  });
});

test("scope entry rereads the frozen store instead of trusting the handle's cached spec", async () => {
  await fixture(async ({ campaign, spec, directory }) => {
    const admission = await campaign.admit(spec.bindings);
    await writeFile(join(directory, "spec.json"), JSON.stringify({ ...spec, changed: true }));
    await assert.rejects(campaign.withAdmissionOrigin(admission.id, async () => assert.fail("visitor must not run")), /Frozen campaign mismatch/);
  });
});

test("native origin issuance remains disabled without writing admission history", async () => {
  await fixture(async ({ directory, spec }) => {
    const native = { ...spec, version: 2 as const, bindings: { ...spec.bindings, model: NATIVE_POLICY_V1.model }, nativePolicy: NATIVE_POLICY_V1,
      pricing: { version: 1 as const, model: NATIVE_POLICY_V1.model, api: NATIVE_POLICY_V1.api, serviceTier: "base" as const, cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 } } };
    const campaign = await createCampaign(directory + "-native", native);
    await assert.rejects(campaign.withAdmissionOrigin("unissued", async () => assert.fail("visitor must not run")), /Native campaign admission is disabled/);
    assert.deepEqual((await campaign.status()).events, []);
  });
});

test("derives parent trial inputs from actual admission and a matching private bank", async () => {
  await fixture(async ({ campaign, spec, bank, directory }) => {
    const admission = await campaign.admit(spec.bindings), scheduled = structuredClone(admission.scheduled);
    admission.scheduled.taskId = "caller-mutated";
    await campaign.withAdmissionOrigin(admission.id, async origin => {
      const input = deriveAdmittedTrialInput(origin, bank);
      assert.equal(input.admission.scheduled.taskId, scheduled.taskId);
      assert.deepEqual(input.request, { task: bank.tasks.find(t => t.id === scheduled.taskId), arm: scheduled.arm, repetition: 1,
        cohort: { model: spec.bindings.model, thinking: spec.bindings.thinking }, timeoutMs: spec.limits.workflowMs });
      assert.deepEqual(input.trialIdentity, { version: 1, id: admission.id, requestDigest: digest(input.request) });
      assert.equal(input.retentionRoot, directory); assert.equal(input.cwd, join(directory, "trials", admission.id, "repo"));
      assert.ok(Object.isFrozen(input) && Object.isFrozen(input.bank.tasks) && Object.isFrozen(input.request.task));
      const bad = structuredClone(bank); bad.tasks[0].prompt += " drift";
      assert.throws(() => deriveAdmittedTrialInput(origin, bad), /Admitted trial input mismatch/);
    });
  });
});

test("native runtime derivation rejects forged origins and cannot upgrade an inert admission", async () => {
  await fixture(async ({ campaign, spec, bank }) => {
    assert.throws(() => bindAdmittedNativeRuntimeRequirement({} as any, bank, null as any), /Native admitted runtime binding mismatch/);
    const admission = await campaign.admit(spec.bindings);
    await campaign.withAdmissionOrigin(admission.id, async origin => {
      let runtimeReads = 0;
      const runtime = new Proxy({}, { ownKeys() { runtimeReads++; throw Error("unexpected runtime access"); } });
      assert.throws(() => bindAdmittedNativeRuntimeRequirement(origin, bank, runtime as any), /Native admitted runtime binding mismatch/);
      assert.equal(runtimeReads, 0);
    });
  });
});

test("admitted launch refuses forged and inert origins before accessing launch or auth inputs", async () => {
  await fixture(async ({ campaign, spec, bank }) => {
    let reads = 0;
    const options = new Proxy({}, { get() { reads++; throw Error("must not inspect launch inputs"); } });
    await assert.rejects(prepareAdmittedNativeLaunch({} as any, bank, options as any), /^Error: Native admitted launch mismatch$/);
    const admission = await campaign.admit(spec.bindings);
    await campaign.withAdmissionOrigin(admission.id, async origin => {
      await assert.rejects(prepareAdmittedNativeLaunch(origin, bank, options as any), /^Error: Native admitted launch mismatch$/);
    });
    assert.equal(reads, 0);
  });
});

async function fixture(action: (f: { directory: string; bank: ReturnType<typeof loadDevelopmentBank>; spec: Parameters<typeof createCampaign>[1]; campaign: Awaited<ReturnType<typeof createCampaign>> }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "guild-origin-test-")), directory = join(root, "campaign");
  try {
    const bank = loadDevelopmentBank(), schedule = createSchedule(bank, 1, "origin-inert");
    const spec = { version: 1 as const, schedule, bindings: { bankDigest: digest(bank), scheduleDigest: digest(schedule), implementationDigest: digest("inert"), runtimeDigest: digest("inert"), policyDigest: digest("inert"), model: "test/fake", thinking: "high" }, limits: { maxTrials: 12, estimatedUsd: 10, activeMs: 3600000, workflowMs: 300000 } };
    await action({ directory, bank, spec, campaign: await createCampaign(directory, spec) });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("reads frozen admission inputs from the locked journal without appending an event", async () => {
  await fixture(async ({ campaign, spec, directory }) => {
    const admission = await campaign.admit(spec.bindings), before = await campaign.status();
    await campaign.withAdmissionOrigin(admission.id, async origin => {
      const snapshot = readCampaignAdmissionOrigin(origin);
      assert.deepEqual(snapshot.spec, spec);
      assert.deepEqual(snapshot.admission, before.pending);
      assert.equal(snapshot.directory, directory); assert.equal(snapshot.historyDigest, digest(before.events));
      assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.spec.bindings) && Object.isFrozen(snapshot.admission.scheduled));
      await assert.rejects(campaign.status(), /Campaign locked/);
    });
    assert.deepEqual((await campaign.status()).events, before.events);
  });
});
