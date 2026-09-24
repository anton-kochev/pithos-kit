import assert from "node:assert/strict";
import { mkdtemp, rm, stat, mkdir, readFile, writeFile, readdir, symlink, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { performance } from "node:perf_hooks";
import { loadDevelopmentBank } from "../src/bank.ts";
import { digest } from "../src/manifest.ts";
import { createSchedule } from "../src/runner.ts";
import { createCampaign, openCampaign } from "../src/campaign.ts";
import { transaction, createStore } from "../src/campaign-store.ts";
import { NATIVE_POLICY_V1 } from "../src/native-policy.ts";

function specification() {
  const bank = loadDevelopmentBank(), schedule = createSchedule(bank, 1, "campaign-test");
  return {
    version: 1 as const, schedule,
    bindings: { bankDigest: digest(bank), scheduleDigest: digest(schedule), implementationDigest: digest("implementation"), runtimeDigest: digest("runtime"), policyDigest: digest("policy"), model: "test/fake", thinking: "high" },
    limits: { maxTrials: 12, estimatedUsd: 10, activeMs: 3600000, workflowMs: 300000 },
  };
}
async function temporary(run: (directory: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "guild-campaign-test-"));
  try { await run(join(root, "campaign")); }
  finally { await rm(root, { recursive: true, force: true }); }
}

function nativeSpecification() {
  const legacy = specification();
  return { ...legacy, version: 2 as const,
    bindings: { ...legacy.bindings, model: "openai-codex/gpt-6-astra", thinking: "high" },
    nativePolicy: structuredClone(NATIVE_POLICY_V1),
    pricing: { version: 1 as const, model: "openai-codex/gpt-6-astra", api: "openai-codex-responses", serviceTier: "base" as const,
      cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 } } };
}

test("persists an explicit version-2 native policy without mutating it through caller state", async () => {
  await temporary(async directory => {
    const spec = nativeSpecification(), frozen = structuredClone(spec), campaign = await createCampaign(directory, spec);
    assert.equal((await campaign.status()).started, 0);
    (spec.nativePolicy as any).transport = "websocket";
    assert.equal((await campaign.status()).started, 0);
    await openCampaign(directory, frozen);
    assert.deepEqual(JSON.parse(await readFile(join(directory, "spec.json"), "utf8")), frozen);
  });
});

test("version-2 native admission and execution history stay disabled before receipt binding", async () => {
  await temporary(async directory => {
    const spec = nativeSpecification(), campaign = await createCampaign(directory, spec);
    await assert.rejects(campaign.admit(spec.bindings), /Native campaign admission is disabled/);
    assert.equal((await campaign.status()).started, 0);
    assert.deepEqual(await readdir(join(directory, "events")), []);
    await transaction(directory, spec, async (_events, append) => append({ type: "started", admission: {
      id: "00000000-0000-4000-8000-000000000000", slot: 0, scheduled: spec.schedule[0], allowanceMs: spec.limits.workflowMs, activeAllowanceMs: spec.limits.activeMs,
    } }));
    await assert.rejects(openCampaign(directory, spec), /native execution history is not supported/);
  });
});

test("the reviewed native cohort cannot create or admit through the legacy contract", async () => {
  await temporary(async directory => {
    const { nativePolicy: _policy, ...native } = nativeSpecification(), legacy = { ...native, version: 1 as const };
    await assert.rejects(createCampaign(directory, legacy), /Native cohort requires campaign version 2/);
    await assert.rejects(stat(directory), /ENOENT/);
    await createStore(directory, legacy); // Simulate an existing historical record, without upgrading/backfilling it.
    const before = await readFile(join(directory, "spec.json"), "utf8"), campaign = await openCampaign(directory, legacy);
    assert.equal((await campaign.status()).started, 0);
    await assert.rejects(campaign.admit(legacy.bindings), /Native campaign admission is disabled/);
    assert.equal(await readFile(join(directory, "spec.json"), "utf8"), before);
    assert.equal((await campaign.status()).started, 0);
  });
});

test("rejects missing, unknown or unsupported native requirements before creating any campaign", async () => {
  const changes: ((s: any) => void)[] = [
    s => delete s.nativePolicy, s => s.nativePolicy = undefined, s => s.nativePolicy = null,
    s => s.nativePolicy = {}, s => s.nativePolicy = [], s => s.nativePolicy.extra = true,
    s => s.nativePolicy.version = 2, s => delete s.nativePolicy.authentication,
    s => s.nativePolicy.node = "v24.19.0", s => s.nativePolicy.pi = "0.83.0", s => s.nativePolicy.piAi = "0.83.0",
    s => s.nativePolicy.transport = "websocket", s => s.nativePolicy.authentication = "ambient-auth",
    s => s.nativePolicy.evidence = "summary-only", s => s.nativePolicy.serviceTier = "priority",
    s => delete s.pricing, s => s.pricing = undefined, s => s.pricing = null,
    s => s.pricing.api = "other-api", s => s.pricing.model = "test/fake", s => s.pricing.serviceTier = "flex",
    s => s.bindings.model = "test/fake", s => s.bindings.thinking = "medium",
    s => s.version = 3, s => s.extra = "unapproved",
  ];
  for (const change of changes) await temporary(async directory => {
    const spec = nativeSpecification(); change(spec);
    await assert.rejects(createCampaign(directory, spec), /Invalid campaign/);
    await assert.rejects(stat(directory), /ENOENT/);
  });
});

test("a frozen native campaign cannot remove or change its policy, pricing, version or bindings on reopen", async () => {
  await temporary(async directory => {
    const original = nativeSpecification(); await createCampaign(directory, original);
    const before = await readFile(join(directory, "spec.json"), "utf8");
    for (const change of [
      (s: any) => delete s.nativePolicy,
      (s: any) => s.nativePolicy.authentication = "ambient-auth",
      (s: any) => s.nativePolicy.version = 2,
      (s: any) => { s.version = 1; delete s.nativePolicy; },
      (s: any) => { s.version = 1; delete s.nativePolicy; delete s.pricing; s.bindings.model = "test/fake"; },
      (s: any) => s.pricing.cost.input++,
      (s: any) => s.bindings.runtimeDigest = digest("different-runtime"),
      (s: any) => s.bindings.policyDigest = digest("different-policy"),
    ]) {
      const changed = structuredClone(original); change(changed);
      await assert.rejects(openCampaign(directory, changed), /Invalid campaign|Frozen campaign mismatch/);
      assert.equal(await readFile(join(directory, "spec.json"), "utf8"), before);
    }
    assert.equal((await (await openCampaign(directory, original)).status()).started, 0);
  });
});

test("historical native ledgers remain inspectable but cannot append inspection or settlement events", async () => {
  await temporary(async directory => {
    const { nativePolicy: _policy, ...native } = nativeSpecification(), legacy = { ...native, version: 1 as const };
    await createStore(directory, legacy);
    for (let slot = 0; slot < 2; slot++) {
      const id = `00000000-0000-4000-8000-00000000000${slot}`;
      await transaction(directory, legacy, async (_events, append) => append({ type: "started", admission: { id, slot,
        scheduled: legacy.schedule[slot], allowanceMs: legacy.limits.workflowMs, activeAllowanceMs: legacy.limits.activeMs } }));
      await transaction(directory, legacy, async (_events, append) => append({ type: "finished", id, elapsedMs: 0,
        receipt: { resultDigest: digest(slot), outcome: "recorded", estimatedUsd: 0.25, integrity: "ok" } }));
    }
    const campaign = await openCampaign(directory, legacy), before = await readFile(join(directory, "head.json"), "utf8");
    assert.equal((await campaign.status()).finished, 2);
    await assert.rejects(campaign.inspectFirstPair(digest("not a new native approval")), /Native campaign admission is disabled/);
    await assert.rejects(campaign.finish("unowned", { resultDigest: digest("inert"), outcome: "failed", estimatedUsd: null, integrity: "failed" }), /Native campaign admission is disabled/);
    assert.equal(await readFile(join(directory, "head.json"), "utf8"), before);
  });
});

test("a fresh Node process reopens native policy but still cannot admit", async () => {
  await temporary(async directory => {
    const spec = nativeSpecification(); await createCampaign(directory, spec);
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import {readFileSync} from 'node:fs';
      const {directory,spec} = JSON.parse(readFileSync(0,'utf8'));
      const {openCampaign} = await import(${JSON.stringify(pathToFileURL(resolve("evaluation/src/campaign.ts")).href)});
      const campaign = await openCampaign(directory,spec);
      let blocked = false;
      try { await campaign.admit(spec.bindings); } catch(e) { blocked = e.message === 'Native campaign admission is disabled pending launch and receipt binding'; }
      console.log(JSON.stringify({started:(await campaign.status()).started,blocked}));
    `], { input: JSON.stringify({ directory, spec }), encoding: "utf8", timeout: 3000, env: { PATH: process.env.PATH } });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { started: 0, blocked: true });
    assert.deepEqual(await readdir(join(directory, "events")), []);
  });
});

test("rejects malformed or changed frozen inputs, schedules, and smoke limits", async () => {
  const bad: ((spec: any) => void)[] = [
    s => s.version = 2, s => s.extra = "unapproved", s => s.bindings.extra = "unapproved",
    s => s.bindings.runtimeDigest = "not-a-digest", s => s.bindings.model = "bare-model",
    s => s.bindings.thinking = "unknown", s => s.bindings.scheduleDigest = digest("different schedule"),
    s => s.schedule[1] = s.schedule[0], s => s.schedule[0].repetition = 2,
    s => s.limits.maxTrials = 13, s => s.limits.estimatedUsd = 11,
    s => s.limits.estimatedUsd = NaN, s => s.limits.activeMs = 3600001,
    s => s.limits.workflowMs = 300001, s => s.limits.workflowMs = 0,
  ];
  for (const change of bad) await temporary(async directory => {
    const spec = specification(); change(spec);
    await assert.rejects(createCampaign(directory, spec), /Invalid campaign/);
    await assert.rejects(stat(directory), /ENOENT/);
  });
  await temporary(async directory => {
    const original = specification();
    await createCampaign(directory, original);
    for (const change of [
      (s: any) => s.bindings.bankDigest = digest("changed bank"),
      (s: any) => s.bindings.implementationDigest = digest("changed code"),
      (s: any) => s.bindings.runtimeDigest = digest("changed runtime"),
      (s: any) => s.bindings.policyDigest = digest("changed policy"),
      (s: any) => s.bindings.model = "test/other", (s: any) => s.limits.estimatedUsd = 9,
    ]) {
      const changed = structuredClone(original); change(changed);
      await assert.rejects(openCampaign(directory, changed), /Frozen campaign mismatch/);
    }
  });
});

test("freezes optional pricing without permitting repricing, removal, model mismatch, or caller mutation", async () => {
  const pricing = { version: 1 as const, model: "test/fake", api: "test-api", serviceTier: "base" as const,
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } };
  await temporary(async directory => {
    const spec = { ...specification(), pricing: structuredClone(pricing) }, frozen = structuredClone(spec);
    await createCampaign(directory, spec);
    spec.pricing.cost.input = 99;
    await openCampaign(directory, frozen);
    assert.deepEqual(JSON.parse(await readFile(join(directory, "spec.json"), "utf8")).pricing, pricing);
    await assert.rejects(openCampaign(directory, spec), /Frozen campaign mismatch/);
    const { pricing: _pricing, ...unpriced } = frozen;
    await assert.rejects(openCampaign(directory, unpriced), /Frozen campaign mismatch/);
  });
  for (const bad of [{ ...pricing, model: "test/other" }, { ...pricing, serviceTier: "flex" }, null, undefined]) {
    await temporary(async directory => {
      await assert.rejects(createCampaign(directory, { ...specification(), pricing: bad } as any), /Invalid campaign/);
      await assert.rejects(stat(directory), /ENOENT/);
    });
  }
});

test("persists admission before returning it and consumes failed slots exactly once across clean resumes", async () => {
  await temporary(async directory => {
    const spec = specification(), campaign = await createCampaign(directory, spec);
    const first = await campaign.admit(spec.bindings);
    assert.deepEqual(first.scheduled, spec.schedule[0]);
    const interrupted = await (await openCampaign(directory, spec)).status();
    assert.equal(interrupted.started, 1);
    assert.equal(interrupted.pending?.id, first.id);
    await campaign.finish(first.id, { resultDigest: digest("failure evidence"), outcome: "failed", estimatedUsd: 2, integrity: "ok" });
    await assert.rejects(campaign.finish(first.id, { resultDigest: digest("duplicate"), outcome: "recorded", estimatedUsd: 0, integrity: "ok" }), /pending|settled/);
    const resumed = await openCampaign(directory, spec);
    assert.equal((await resumed.status()).estimatedUsd, 2);
    const second = await resumed.admit(spec.bindings);
    assert.notEqual(first.id, second.id);
    assert.deepEqual(second.scheduled, spec.schedule[1]);
    assert.equal((await resumed.status()).started, 2);
  });
});

test("blocks changed observed inputs, unknown spend, and reached trial or estimated-usage limits", async () => {
  await temporary(async directory => {
    const spec = specification(), campaign = await createCampaign(directory, spec);
    await assert.rejects(campaign.admit({ ...spec.bindings, implementationDigest: digest("drift") }), /Frozen campaign mismatch/);
    assert.equal((await campaign.status()).started, 0);
    const first = await campaign.admit(spec.bindings);
    await campaign.finish(first.id, { resultDigest: digest("partial evidence"), outcome: "failed", estimatedUsd: null, integrity: "ok" });
    const resumed = await openCampaign(directory, spec);
    await assert.rejects(resumed.admit(spec.bindings), /unknown_spend/);
    assert.equal((await resumed.status()).estimatedUsd, null);
    assert.equal((await resumed.status()).started, 1);
  });
  for (const cap of ["trials", "spend"]) await temporary(async directory => {
    const spec = specification();
    if (cap === "trials") spec.limits.maxTrials = 1;
    const campaign = await createCampaign(directory, spec), first = await campaign.admit(spec.bindings);
    await campaign.finish(first.id, { resultDigest: digest("evidence"), outcome: "recorded", estimatedUsd: cap === "spend" ? 10 : 0, integrity: "ok" });
    await assert.rejects((await openCampaign(directory, spec)).admit(spec.bindings), cap === "trials" ? /trial_limit/ : /spend_limit/);
  });
});

test("rejects malformed settlements without erasing the pending attempt", async () => {
  await temporary(async directory => {
    const spec = specification(), campaign = await createCampaign(directory, spec), first = await campaign.admit(spec.bindings);
    const valid = { resultDigest: digest("receipt"), outcome: "failed" as const, estimatedUsd: 1, integrity: "ok" as const };
    for (const bad of [
      { ...valid, estimatedUsd: -1 }, { ...valid, estimatedUsd: Infinity }, { ...valid, estimatedUsd: NaN },
      { ...valid, resultDigest: "not a digest" }, { ...valid, extra: "not allowed" }, { ...valid, integrity: "maybe" },
    ]) {
      await assert.rejects(campaign.finish(first.id, bad as any), /Invalid campaign/);
      assert.equal((await campaign.status()).pending?.id, first.id);
    }
    await campaign.finish(first.id, valid);
  });
});

test("requires a persisted first-pair inspection and never lets it clear integrity failures", async () => {
  await temporary(async directory => {
    const spec = specification(), campaign = await createCampaign(directory, spec);
    await assert.rejects(campaign.inspectFirstPair(digest("too early")), /first pair/i);
    for (let i = 0; i < 2; i++) {
      const admitted = await campaign.admit(spec.bindings);
      await campaign.finish(admitted.id, { resultDigest: digest(i), outcome: "failed", estimatedUsd: 0.25, integrity: "ok" });
    }
    const resumed = await openCampaign(directory, spec);
    await assert.rejects(resumed.admit(spec.bindings), /first_pair_inspection/);
    await resumed.inspectFirstPair(digest("human inspection record"));
    await assert.rejects(resumed.inspectFirstPair(digest("duplicate")), /already/);
    const third = await (await openCampaign(directory, spec)).admit(spec.bindings);
    assert.equal(third.slot, 2);
  });
  await temporary(async directory => {
    const spec = specification(), campaign = await createCampaign(directory, spec), first = await campaign.admit(spec.bindings);
    await campaign.finish(first.id, { resultDigest: digest("preservation failure"), outcome: "failed", estimatedUsd: 0.1, integrity: "failed" });
    await assert.rejects((await openCampaign(directory, spec)).admit(spec.bindings), /integrity_failure/);
    await assert.rejects(campaign.inspectFirstPair(digest("cannot clear failure")));
    assert.ok((await campaign.status()).blocked.includes("integrity_failure"));
  });
});

test("meters in-flight monotonic time, carries settled time over resume, and cannot certify orphaned attempts", async t => {
  let time = 0;
  t.mock.method(performance, "now", () => time);
  await temporary(async directory => {
    const spec = specification(); spec.limits.activeMs = 1000; spec.limits.workflowMs = 700;
    const campaign = await createCampaign(directory, spec), first = await campaign.admit(spec.bindings);
    assert.equal(first.remainingMs(), 700);
    assert.equal(first.remainingActiveMs(), 1000, "trusted grading shares active time, not the workflow deadline");
    time = 600;
    assert.equal(first.remainingMs(), 100);
    assert.equal(first.remainingActiveMs(), 400);
    assert.equal((await campaign.status()).activeMs, 600);
    const orphanView = await openCampaign(directory, spec);
    assert.equal((await orphanView.status()).estimatedUsd, null);
    assert.equal((await orphanView.status()).activeMs, null);
    await assert.rejects(orphanView.admit(spec.bindings), /pending_attempt/);
    await assert.rejects(orphanView.finish(first.id, { resultDigest: digest("cannot certify orphan"), outcome: "failed", estimatedUsd: 0, integrity: "ok" }), /admitting handle/);
    await campaign.finish(first.id, { resultDigest: digest("first"), outcome: "recorded", estimatedUsd: 0.1, integrity: "ok" });
    assert.equal(first.remainingMs(), 0);
    time = 100000; // Inactive operator pause does not reset or consume active allowance.
    const resumed = await openCampaign(directory, spec), second = await resumed.admit(spec.bindings);
    assert.equal(second.remainingMs(), 400);
    time += 450; // Cooperative caller settled late; retain overshoot, never clamp accounting.
    assert.equal(second.remainingMs(), 0);
    await resumed.finish(second.id, { resultDigest: digest("second"), outcome: "failed", estimatedUsd: 0.1, integrity: "ok" });
    assert.equal((await resumed.status()).activeMs, 1050);
    await assert.rejects(resumed.admit(spec.bindings), /active_time_limit/);
    await assert.rejects(resumed.inspectFirstPair(digest("cannot clear exhausted time")));
  });
});

test("honors an exclusive transaction lock and never auto-clears a stale one", async () => {
  await temporary(async directory => {
    const spec = specification(), campaign = await createCampaign(directory, spec);
    await mkdir(join(directory, ".lock"));
    await assert.rejects(campaign.admit(spec.bindings), /locked/);
    assert.ok((await stat(join(directory, ".lock"))).isDirectory());
    await rm(join(directory, ".lock"), { recursive: true }); // This test's inert lock only.
    const other = await openCampaign(directory, spec);
    const outcomes = await Promise.allSettled([campaign.admit(spec.bindings), other.admit(spec.bindings)]);
    assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
    assert.equal((await campaign.status()).started, 1);
  });
});

test("rejects altered, missing, malformed, oversized, or symlink journal evidence without repairing it", async () => {
  for (const mutation of ["alter", "remove-start", "malformed", "oversized", "symlink", "extra"]) await temporary(async directory => {
    const spec = specification(), campaign = await createCampaign(directory, spec);
    await campaign.admit(spec.bindings);
    const events = join(directory, "events"), names = await readdir(events), file = join(events, names[0]);
    if (mutation === "alter") {
      const data = JSON.parse(await readFile(file, "utf8")); data.unapproved = true;
      await writeFile(file, JSON.stringify(data));
    } else if (mutation === "remove-start") await rm(file);
    else if (mutation === "malformed") await writeFile(file, '{"unfinished":');
    else if (mutation === "oversized") await truncate(file, 1024 * 1024);
    else if (mutation === "symlink") { await rm(file); await symlink(join(directory, "spec.json"), file); }
    else await writeFile(join(events, "unexpected.json"), "{}");
    const before = await readdir(events);
    await assert.rejects(openCampaign(directory, spec), /Invalid campaign/);
    assert.deepEqual(await readdir(events), before);
  });
});

test("validates event meaning and transitions even when journal checksums are valid", async () => {
  for (const badEvent of [
    (spec: ReturnType<typeof specification>) => ({ type: "started", admission: { id: "00000000-0000-4000-8000-000000000000", slot: 99, scheduled: spec.schedule[0], allowanceMs: 300000, activeAllowanceMs: 3600000 } }),
    () => ({ type: "unknown" }),
    () => ({ type: "first_pair_inspected", receiptDigest: digest("premature") }),
    () => ({ type: "finished", id: "missing", elapsedMs: 0, receipt: { resultDigest: digest("unstarted"), estimatedUsd: 0, outcome: "recorded", integrity: "ok" } }),
  ]) await temporary(async directory => {
    const spec = specification(); await createCampaign(directory, spec);
    await transaction(directory, spec, async (_events, append) => append(badEvent(spec)));
    await assert.rejects(openCampaign(directory, spec), /Invalid campaign/);
  });
  await temporary(async directory => {
    const spec = specification(), campaign = await createCampaign(directory, spec), first = await campaign.admit(spec.bindings);
    await transaction(directory, spec, async (_events, append) => append({ type: "finished", id: first.id, elapsedMs: -1, receipt: { resultDigest: digest("negative time"), estimatedUsd: -10, outcome: "recorded", integrity: "ok" } }));
    await assert.rejects(openCampaign(directory, spec), /Invalid campaign/);
  });
});

test("stops at a decimal spend threshold despite floating-point summation", async () => {
  await temporary(async directory => {
    const spec = specification(); spec.limits.estimatedUsd = 0.9;
    const campaign = await createCampaign(directory, spec);
    for (const estimatedUsd of [0.3, 0.6]) {
      const attempt = await campaign.admit(spec.bindings);
      await campaign.finish(attempt.id, { resultDigest: digest(estimatedUsd), outcome: "recorded", estimatedUsd, integrity: "ok" });
    }
    assert.ok((await campaign.status()).blocked.includes("spend_limit"));
    await assert.rejects(campaign.inspectFirstPair(digest("cannot clear spend cap")));
  });
});

test("returned admission data cannot mutate the handle's frozen schedule", async () => {
  await temporary(async directory => {
    const spec = specification(), campaign = await createCampaign(directory, spec), attempt = await campaign.admit(spec.bindings);
    attempt.scheduled.taskId = "caller-mutation";
    assert.equal((await campaign.status()).pending?.scheduled.taskId, spec.schedule[0].taskId);
  });
});

test("retains all twelve workflow slots and the inspection across a fresh Node process", async () => {
  await temporary(async directory => {
    const spec = specification(); await createCampaign(directory, spec);
    for (let i = 0; i < 12; i++) {
      const campaign = await openCampaign(directory, spec);
      if (i === 2) await campaign.inspectFirstPair(digest("inspected first pair"));
      const attempt = await campaign.admit(spec.bindings);
      assert.equal(attempt.slot, i);
      await campaign.finish(attempt.id, { resultDigest: digest(i), outcome: i % 3 ? "recorded" : "failed", estimatedUsd: 0.1, integrity: "ok" });
    }
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import {readFileSync} from 'node:fs';
      const {directory,spec} = JSON.parse(readFileSync(0,'utf8'));
      const {openCampaign} = await import(${JSON.stringify(pathToFileURL(resolve("evaluation/src/campaign.ts")).href)});
      const campaign = await openCampaign(directory,spec);
      const {started,finished,firstPairInspected,blocked} = await campaign.status();
      console.log(JSON.stringify({started,finished,firstPairInspected,blocked}));
    `], { input: JSON.stringify({ directory, spec }), encoding: "utf8", timeout: 3000, env: { PATH: process.env.PATH } });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { started: 12, finished: 12, firstPairInspected: true, blocked: ["trial_limit"] });
    assert.equal((await readdir(join(directory, "events"))).length, 25);
  });
});

test("cannot admit against a stale evidence-audit history", async () => {
  await temporary(async directory => {
    const spec = specification(), campaign = await createCampaign(directory, spec);
    const audited = digest((await campaign.status()).events);
    const other = await openCampaign(directory, spec), attempt = await other.admit(spec.bindings);
    await other.finish(attempt.id, { resultDigest: digest("concurrent result"), outcome: "recorded", estimatedUsd: 0.1, integrity: "ok" });
    await assert.rejects(campaign.admit(spec.bindings, audited), /history changed/i);
    assert.equal((await campaign.status()).started, 1);
  });
});

test("creates a private campaign once and reopens it against the same frozen specification", async () => {
  await temporary(async directory => {
    const spec = specification();
    const campaign = await createCampaign(directory, spec);
    assert.equal((await campaign.status()).started, 0);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, "spec.json"))).mode & 0o777, 0o600);
    await assert.rejects(createCampaign(directory, spec), /exist/i);
    assert.equal((await (await openCampaign(directory, spec)).status()).started, 0);
  });
});
