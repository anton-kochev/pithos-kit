import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createPiDriver } from "../src/pi-driver.ts";
import { loadDevelopmentBank } from "../src/bank.ts";
import { digest } from "../src/manifest.ts";
import { createSchedule, runTrial, type Driver } from "../src/runner.ts";
import { deriveTrialReceipt } from "../src/trial-receipt.ts";
import { createCampaign, openCampaign } from "../src/campaign.ts";
import { deriveCampaignTrialReceipt, runCampaignNext } from "../src/campaign-execution.ts";
import { CANDIDATE_NATIVE_POLICY_V2, NATIVE_POLICY_V1 } from "../src/native-policy.ts";
import { createStore } from "../src/campaign-store.ts";

const raw = JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "test", model: "fake", stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } }, content: [{ type: "text", text: "Offline report" }] } }) + '\n{"type":"agent_end"}\n';
const observer = '{"version":1,"type":"observer_ready"}\n{"version":1,"type":"observer_end"}\n';
function inputs() {
  const bank = loadDevelopmentBank(), schedule = createSchedule(bank, 1, "bridge-test");
  const spec = { version: 1 as const, schedule,
    bindings: { bankDigest: digest(bank), scheduleDigest: digest(schedule), implementationDigest: digest("code"), runtimeDigest: digest("runtime"), policyDigest: digest("policy"), model: "test/fake", thinking: "high" },
    limits: { maxTrials: 12, estimatedUsd: 10, activeMs: 60000, workflowMs: 3000 } };
  return { bank, spec };
}
async function temporary(run: (root: string, directory: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "guild-execution-test-"));
  try { await run(root, join(root, "campaign")); } finally { await rm(root, { recursive: true, force: true }); }
}
const complete: Driver = async ({ emit, artifactDirectory }) => {
  emit(raw); await writeFile(join(artifactDirectory, "children.jsonl"), observer, { mode: 0o600 }); return { exitCode: 0 };
};

test("shared campaign receipt route selects committed launch and rejects native-v1 for candidate evidence", async () => {
  await temporary(async (_root, directory) => {
    const nativeRequest = { ...inputs().bank.tasks[0] };
    const request = { task: nativeRequest, arm: "main-only" as const, repetition: 1,
      cohort: { model: NATIVE_POLICY_V1.model, thinking: "high" }, timeoutMs: 3000 };
    const result = await runTrial(join(directory, "trials"), request, async context => {
      context.emit(raw); await writeFile(join(context.artifactDirectory, "children.jsonl"), observer, { mode: 0o600 });
      const supervisor = { version: 1 as const, kind: "guild-eval-supervisor-spawn" as const, trialIdentity: context.trialIdentity,
        invocationDigest: digest("invocation"), configurationSha256: digest("configuration"), supervisorPid: 6, parentPid: 24 };
      await writeFile(join(context.artifactDirectory, "supervisor.json"), JSON.stringify(supervisor) + "\n", { mode: 0o600 });
      return { exitCode: 0, supervisor };
    });
    const schedule = [{ taskId: request.task.id, arm: "main-only" as const, repetition: 1 }, { taskId: request.task.id, arm: "guild-available" as const, repetition: 1 }];
    const spec: any = { version: 2, schedule, nativePolicy: structuredClone(NATIVE_POLICY_V1),
      bindings: { bankDigest: digest("bank"), scheduleDigest: digest(schedule), implementationDigest: digest("implementation"),
        runtimeDigest: digest("runtime"), policyDigest: digest("policy"), model: NATIVE_POLICY_V1.model, thinking: "high" },
      limits: { maxTrials: 2, estimatedUsd: 10, activeMs: 60000, workflowMs: 3000 },
      pricing: { version: 1, model: NATIVE_POLICY_V1.model, api: NATIVE_POLICY_V1.api, serviceTier: "base",
        cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 } } };
    const launch = { version: 1 as const, historyDigest: digest("history"), configurationSha256: result.supervisor!.configurationSha256!,
      runtimeRequirementSha256: digest("runtime requirement"), invocationDigest: result.supervisor!.invocationDigest,
      scopedAuthIdentityDigest: digest("auth"), implementationDigest: spec.bindings.implementationDigest, supervisorPid: result.supervisor!.supervisorPid };
    const events: any[] = [{ type: "started", admission: { id: result.id } }, { type: "launch_prepared", id: result.id, launch }];
    await assert.rejects(deriveCampaignTrialReceipt(spec, events, join(directory, "trials", result.id), request, result, { mode: "fresh", expectedResultDigest: digest(JSON.parse(JSON.stringify(result))) }), /Candidate native-v2 policy is required/);
    spec.nativePolicy = structuredClone(CANDIDATE_NATIVE_POLICY_V2);
    await assert.rejects(deriveCampaignTrialReceipt(spec, events, join(directory, "trials", result.id), request, result, { mode: "fresh", expectedResultDigest: digest(JSON.parse(JSON.stringify(result))) }), /Bound producer evidence mismatch/);
    await assert.rejects(deriveCampaignTrialReceipt(spec, events.slice(0, 1), join(directory, "trials", result.id), request, result, { mode: "fresh", expectedResultDigest: digest(JSON.parse(JSON.stringify(result))) }), /Committed native launch evidence is required/);
    await assert.rejects(deriveCampaignTrialReceipt(spec, [...events, events[1]], join(directory, "trials", result.id), request, result, { mode: "fresh", expectedResultDigest: digest(JSON.parse(JSON.stringify(result))) }), /Committed native launch evidence mismatch/);
    const changed = { ...launch, invocationDigest: digest("other invocation") };
    await assert.rejects(deriveCampaignTrialReceipt(spec, events, join(directory, "trials", result.id), request, result, { mode: "fresh", expectedResultDigest: digest(JSON.parse(JSON.stringify(result))), preparedLaunch: changed }), /Committed native launch evidence mismatch/);
  });
});

test("rereads the ledger after the final observation and stops before driver entry on drift", async () => {
  await temporary(async (_root, directory) => {
    const { bank, spec } = inputs(); await createCampaign(directory, spec);
    let observations = 0, calls = 0;
    const changed = JSON.stringify({ ...spec, changed: "retained-inert-drift" });
    await assert.rejects(runCampaignNext({ directory, bank, spec,
      observe: async () => {
        if (++observations === 2) await writeFile(join(directory, "spec.json"), changed);
        return spec.bindings;
      },
      driver: async context => { calls++; return complete(context); },
    }), /Frozen campaign mismatch/);
    assert.equal(calls, 0);
    assert.equal(await readFile(join(directory, "spec.json"), "utf8"), changed);
  });
});

test("hands the exact admitted inputs to the driver after releasing the ledger scope", async () => {
  await temporary(async (_root, directory) => {
    const { bank, spec } = inputs(); await createCampaign(directory, spec);
    let calls = 0;
    const outcome = await runCampaignNext({ directory, bank, spec, observe: async () => spec.bindings,
      driver: async context => {
        calls++;
        const state = await (await openCampaign(directory, spec)).status();
        assert.equal(context.trialIdentity.id, state.pending!.id);
        assert.equal(context.trialIdentity.requestDigest, digest(context.request));
        assert.equal(context.request.task.id, state.pending!.scheduled.taskId);
        assert.equal(context.request.arm, state.pending!.scheduled.arm);
        assert.deepEqual(context.request.cohort, { model: spec.bindings.model, thinking: spec.bindings.thinking });
        assert.equal(context.request.timeoutMs, spec.limits.workflowMs);
        assert.equal(context.retentionRoot, directory);
        assert.equal(context.artifactDirectory, join(directory, "trials", state.pending!.id));
        assert.equal(context.cwd, join(context.artifactDirectory, "repo"));
        return complete(context);
      },
    });
    assert.equal(calls, 1); assert.equal(outcome.receipt.estimatedUsd, 0.25); assert.equal(outcome.receipt.integrity, "ok");
  });
});

test("offers configuration preparation only during the driver's admitted window", async () => {
  await temporary(async (_root, directory) => {
    const { bank, spec } = inputs(); await createCampaign(directory, spec);
    let prepare: NonNullable<Parameters<Driver>[0]["prepareNativeLaunch"]>;
    let reads = 0;
    const invalid = new Proxy({}, { get() { reads++; throw Error("launch input must not be read"); } });
    const result = await runCampaignNext({ directory, bank, spec, observe: async () => spec.bindings,
      driver: async context => {
        assert.equal(typeof context.prepareNativeLaunch, "function"); prepare = context.prepareNativeLaunch!;
        // An inert campaign cannot create a native configuration.
        await assert.rejects(prepare(invalid as any), /^Error: Native admitted launch mismatch$/);
        return complete(context);
      },
    });
    assert.equal(result.result?.error, undefined, result.result?.error);
    assert.equal(result.receipt.integrity, "ok"); assert.equal(reads, 0);
    await assert.rejects(prepare!(invalid as any), /Native configuration window closed/);
    assert.equal(reads, 0);
  });
});

const pricing = { version: 1 as const, model: "test/fake", api: "test-api", serviceTier: "base" as const,
  cost: { input: 125000, output: 250000, cacheRead: 62500, cacheWrite: 500000 } };

test("native policy cannot enter the bridge before launch and receipt binding", async () => {
  await temporary(async (_root, directory) => {
    const input = inputs(), spec = { ...input.spec, version: 2 as const, nativePolicy: structuredClone(NATIVE_POLICY_V1),
      bindings: { ...input.spec.bindings, model: "openai-codex/gpt-6-astra" },
      pricing: { ...pricing, model: "openai-codex/gpt-6-astra", api: "openai-codex-responses" } };
    await createCampaign(directory, spec);
    let observations = 0, calls = 0;
    await assert.rejects(runCampaignNext({ directory, spec, bank: input.bank,
      observe: async () => { observations++; return spec.bindings; },
      driver: async context => { calls++; return complete(context); },
    }), /Native campaign admission is disabled/);
    assert.equal(observations, 0); assert.equal(calls, 0);
    assert.equal((await (await openCampaign(directory, spec)).status()).started, 0);
  });
});

test("the bridge refuses a legacy native cohort before observation or driver entry", async () => {
  await temporary(async (_root, directory) => {
    const { bank, spec } = inputs(); spec.bindings.model = "openai-codex/gpt-6-astra";
    await createStore(directory, spec); // Read-only historical format, not a new native campaign.
    let observations = 0, calls = 0;
    await assert.rejects(runCampaignNext({ directory, spec, bank,
      observe: async () => { observations++; return spec.bindings; },
      driver: async context => { calls++; return complete(context); },
    }), /Native campaign admission is disabled/);
    assert.equal(observations, 0); assert.equal(calls, 0);
    assert.equal((await (await openCampaign(directory, spec)).status()).started, 0);
  });
});

test("settles under frozen per-turn pricing and blocks unexplained spend before another driver call", async () => {
  for (const wrong of [false, true]) await temporary(async (_root, directory) => {
    const input = inputs(), spec = { ...input.spec, pricing };
    await createCampaign(directory, spec);
    let calls = 0;
    const driver: Driver = async ({ emit, artifactDirectory }) => {
      calls++;
      const event = JSON.parse(raw.split("\n")[0]);
      event.message.api = pricing.api;
      event.message.usage.totalTokens = 2;
      event.message.usage.cost = { input: 0.125, output: 0.25, cacheRead: 0, cacheWrite: 0, total: wrong ? 0.25 : 0.375 };
      emit(JSON.stringify(event) + '\n{"type":"agent_end"}\n');
      await writeFile(join(artifactDirectory, "children.jsonl"), observer, { mode: 0o600 });
      return { exitCode: 0 };
    };
    const options = { directory, spec, bank: input.bank, driver, observe: async () => spec.bindings };
    const outcome = await runCampaignNext(options);
    assert.equal(outcome.receipt.estimatedUsd, wrong ? null : 0.375);
    assert.equal(outcome.receipt.integrity, wrong ? "failed" : "ok");
    if (wrong) {
      await assert.rejects(runCampaignNext(options), /unknown_spend/);
      assert.equal(calls, 1);
      const state = await (await openCampaign(directory, spec)).status();
      assert.equal(state.started, 1); assert.equal(state.finished, 1);
      assert.ok(state.blocked.includes("integrity_failure"));
    } else {
      await runCampaignNext(options); // Also re-audits the first priced receipt.
      assert.equal(calls, 2);
    }
  });
});

test("re-applies frozen pricing to historical receipts even when raw evidence and ledger checksums agree", async () => {
  await temporary(async (_root, directory) => {
    const input = inputs(), spec = { ...input.spec, pricing }, campaign = await createCampaign(directory, spec);
    const admission = await campaign.admit(spec.bindings);
    const request = { task: input.bank.tasks.find(t => t.id === admission.scheduled.taskId)!, arm: admission.scheduled.arm,
      repetition: 1, cohort: { model: spec.bindings.model, thinking: spec.bindings.thinking }, timeoutMs: spec.limits.workflowMs };
    const result = await runTrial(join(directory, "trials"), request, complete, undefined, { id: admission.id });
    const unpriced = await deriveTrialReceipt(join(directory, "trials", admission.id), request, result);
    assert.equal(unpriced.estimatedUsd, 0.25);
    await campaign.finish(admission.id, unpriced); // Deliberate lower-level bypass of the bridge, not damaged files.
    let calls = 0;
    await assert.rejects(runCampaignNext({ directory, spec, bank: input.bank, observe: async () => spec.bindings,
      driver: async context => { calls++; return complete(context); } }), /Historical trial evidence mismatch/);
    assert.equal(calls, 0);
    assert.equal((await campaign.status()).started, 1);
  });
});

test("resume rejects substituted trial identity even when retained files and ledger digests agree", async () => {
  await temporary(async (_root, directory) => {
    const { bank, spec } = inputs(), campaign = await createCampaign(directory, spec);
    const admission = await campaign.admit(spec.bindings);
    const request = { task: bank.tasks.find(t => t.id === admission.scheduled.taskId)!, arm: admission.scheduled.arm,
      repetition: 1, cohort: { model: spec.bindings.model, thinking: spec.bindings.thinking }, timeoutMs: spec.limits.workflowMs };
    const result = await runTrial(join(directory, "trials"), request, complete, undefined, { id: admission.id });
    const trial = join(directory, "trials", admission.id), receipt = await deriveTrialReceipt(trial, request, result);
    const substituted = JSON.parse(JSON.stringify({ ...result, id: "11111111-1111-4111-8111-111111111111" }));
    const savedRequest = JSON.parse(await readFile(join(trial, "request.json"), "utf8")); savedRequest.id = substituted.id;
    await writeFile(join(trial, "request.json"), JSON.stringify(savedRequest));
    await writeFile(join(trial, "result.json"), JSON.stringify(substituted));
    // A valid lower-level settlement binds the altered bytes. Resume must still
    // check journal admission identity, not merely agree with those checksums.
    await campaign.finish(admission.id, { ...receipt, resultDigest: digest(substituted) });
    let calls = 0;
    await assert.rejects(runCampaignNext({ directory, bank, spec, observe: async () => spec.bindings,
      driver: async context => { calls++; return complete(context); } }), /Committed trial result evidence mismatch/);
    assert.equal(calls, 0);
    const state = await (await openCampaign(directory, spec)).status();
    assert.equal(state.started, 1); assert.equal(state.finished, 1);
    assert.equal(JSON.parse(await readFile(join(trial, "result.json"), "utf8")).id, substituted.id, "no repair or backfill");
  });
});

test("consumes and records setup failures even before a trial result can be written", async () => {
  await temporary(async (_root, directory) => {
    const { bank, spec } = inputs(); await createCampaign(directory, spec);
    await writeFile(join(directory, "trials"), "existing data must not be overwritten", { mode: 0o600 });
    let calls = 0;
    const outcome = await runCampaignNext({ directory, bank, spec, observe: async () => spec.bindings, driver: async context => { calls++; return complete(context); } });
    assert.equal(calls, 0);
    assert.equal(outcome.result, undefined);
    assert.equal(outcome.receipt.estimatedUsd, null);
    assert.equal(outcome.receipt.integrity, "failed");
    assert.equal(await readFile(join(directory, "trials"), "utf8"), "existing data must not be overwritten");
    await access(join(directory, `failure-${outcome.admissionId}.json`));
    const state = await (await openCampaign(directory, spec)).status();
    assert.equal(state.started, 1); assert.equal(state.finished, 1);
    assert.ok(state.blocked.includes("unknown_spend"));
  });
});

test("rejects missing dependencies, changed banks, and pre-admission cancellation without consuming a slot", async () => {
  await temporary(async (_root, directory) => {
    const { bank, spec } = inputs(); await createCampaign(directory, spec);
    const options = { directory, bank, spec, driver: complete, observe: async () => spec.bindings };
    await assert.rejects(runCampaignNext({ ...options, driver: undefined } as any), /explicit/i);
    await assert.rejects(runCampaignNext({ ...options, observe: undefined } as any), /explicit/i);
    const changed = structuredClone(bank); changed.tasks[0].prompt += " altered";
    await assert.rejects(runCampaignNext({ ...options, bank: changed }), /bank/i);
    await assert.rejects(runCampaignNext(options, AbortSignal.abort()));
    assert.equal((await (await openCampaign(directory, spec)).status()).started, 0);
  });
});

test("rechecks observed bindings before driver entry and after execution", async () => {
  for (const driftAt of [2, 3]) await temporary(async (_root, directory) => {
    const { bank, spec } = inputs(); await createCampaign(directory, spec);
    let observed = 0, calls = 0;
    const result = await runCampaignNext({ directory, bank, spec,
      observe: async () => ++observed === driftAt ? { ...spec.bindings, runtimeDigest: digest("changed runtime") } : spec.bindings,
      driver: async context => { calls++; return complete(context); },
    });
    assert.equal(calls, driftAt === 2 ? 0 : 1);
    assert.equal(result.receipt.estimatedUsd, null);
    assert.equal(result.receipt.integrity, "failed");
    assert.equal((await (await openCampaign(directory, spec)).status()).finished, 1);
  });
});

test("enforces the active campaign deadline through the native inert CLI and kills ordinary descendants", async () => {
  await temporary(async (root, directory) => {
    const { bank, spec } = inputs(); spec.limits.activeMs = 1000; spec.limits.workflowMs = 3000;
    await createCampaign(directory, spec);
    const cli = join(root, "fake-cli.mjs"), piPackageJson = join(root, "package.json"), ready = join(root, "ready"), late = join(root, "late");
    await writeFile(piPackageJson, JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.83.0" }));
    const descendant = `require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(late)}, 'orphan'), 2000);`;
    await writeFile(cli, `import {spawn} from 'node:child_process'; spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:'ignore'}); process.stdout.write(${JSON.stringify(raw)}); setInterval(() => {}, 1000);`);
    const outcome = await runCampaignNext({ directory, bank, spec, observe: async () => spec.bindings,
      driver: createPiDriver({ approval: "explicit-model-run-approval", piEntry: cli, piPackageJson, guildRoot: resolve("."), credentials: {} }),
    });
    await access(ready); // The descendant actually started; this is not a pre-spawn timeout pin.
    assert.equal(outcome.result?.status, "campaign_timeout");
    assert.equal(outcome.result?.campaignDeadlineExceeded, true);
    assert.equal(outcome.receipt.estimatedUsd, null);
    const state = await (await openCampaign(directory, spec)).status();
    assert.equal(state.finished, 1); assert.ok(state.blocked.includes("active_time_limit"));
    await delay(2200);
    await assert.rejects(access(late));
  });
});

test("checks frozen implementation before interpreting historical trial evidence", async () => {
  await temporary(async (_root, directory) => {
    const { bank, spec } = inputs(); await createCampaign(directory, spec);
    const first = await runCampaignNext({ directory, bank, spec, driver: complete, observe: async () => spec.bindings });
    const file = join(directory, "trials", first.admissionId, "result.json");
    await writeFile(file, "invalid retained evidence: must not be interpreted under changed implementation");
    let observations = 0, calls = 0;
    await assert.rejects(runCampaignNext({ directory, bank, spec,
      observe: async () => { observations++; return { ...spec.bindings, implementationDigest: digest("different auditor") }; },
      driver: async context => { calls++; return complete(context); },
    }), /Frozen campaign observation mismatch/);
    assert.equal(observations, 1); assert.equal(calls, 0);
    assert.equal((await (await openCampaign(directory, spec)).status()).started, 1);
    assert.match(await readFile(file, "utf8"), /^invalid retained evidence:/);
  });
});

test("re-audits retained results before another admission instead of trusting ledger totals alone", async () => {
  await temporary(async (_root, directory) => {
    const { bank, spec } = inputs(); await createCampaign(directory, spec);
    let calls = 0;
    const options = { directory, bank, spec, observe: async () => spec.bindings, driver: async (context: Parameters<Driver>[0]) => { calls++; return complete(context); } };
    const first = await runCampaignNext(options);
    await rm(join(directory, "trials", first.admissionId, "parent.jsonl"));
    await assert.rejects(runCampaignNext(options), /evidence/i);
    assert.equal(calls, 1);
    assert.equal((await (await openCampaign(directory, spec)).status()).started, 1);
  });
});

test("binds admitted UUIDs to retained trials, settles from evidence, and stops at the first pair", async () => {
  await temporary(async (_root, directory) => {
    const { bank, spec } = inputs(); await createCampaign(directory, spec);
    let calls = 0, retentionRoot: string | undefined;
    const driver: Driver = async context => {
      calls++;
      retentionRoot = context.retentionRoot;
      const state = await (await openCampaign(directory, spec)).status();
      assert.equal(state.pending?.id, basename(context.artifactDirectory), "admission must be durable before driver entry");
      return complete(context);
    };
    const options = { directory, bank, spec, driver, observe: async () => spec.bindings };
    const one = await runCampaignNext(options);
    assert.equal(retentionRoot, directory, "credential exclusions must cover the whole retained campaign");
    assert.equal(one.admissionId, one.result?.id);
    assert.equal(one.receipt.estimatedUsd, 0.25);
    assert.equal(one.receipt.integrity, "ok");
    await access(join(directory, "trials", one.admissionId, "result.json"));
    await runCampaignNext(options);
    await assert.rejects(runCampaignNext(options), /first_pair_inspection/);
    assert.equal(calls, 2);
    const state = await (await openCampaign(directory, spec)).status();
    assert.equal(state.started, 2); assert.equal(state.finished, 2); assert.equal(state.estimatedUsd, 0.5);
  });
});
