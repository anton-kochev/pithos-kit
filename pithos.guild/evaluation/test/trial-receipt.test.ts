import { deriveCampaignTrialReceipt } from '../src/campaign-execution.ts';
import type { CampaignSpec } from '../src/campaign.ts';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fixture, backend } from './inert-finalization-fixture.ts';
import { issueInertFinalizationOrigin } from '../src/trial-finalization.ts';
import { snapshot } from '../src/fixture.ts';
import { readTree } from '../src/grading-owner.ts';
import { approvedGitDigest } from '../src/grading-snapshot.ts';
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, readFile, writeFile, truncate, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadDevelopmentBank } from "../src/bank.ts";
import { runTrial, type TrialControls } from "../src/runner.ts";
import { deriveNativeTrialReceipt, deriveTrialReceipt, loadBoundSupervisorEvidence } from "../src/trial-receipt.ts";
import { digest } from "../src/manifest.ts";
import { NATIVE_RUNTIME_PATHS } from "../src/native-input-contracts.ts";
import { calculateBaseCost } from "../src/pricing.ts";
import { CANDIDATE_NATIVE_POLICY_V3, CANDIDATE_NATIVE_POLICY_V2, NATIVE_POLICY_V1 } from "../src/native-policy.ts";

const request = { task: loadDevelopmentBank().tasks[0], arm: "main-only" as const, repetition: 1, cohort: { model: "test/fake", thinking: "high" }, timeoutMs: 1000 };
const raw = JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "test", model: "fake", stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } }, content: [{ type: "text", text: "Offline report" }] } }) + '\n{"type":"agent_end"}\n';
const nativePricing = { version: 1 as const, model: "openai-codex/gpt-6-astra", api: "openai-codex-responses", serviceTier: "base" as const,
  cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 } };
const observer = '{"version":1,"type":"observer_ready"}\n{"version":1,"type":"observer_end"}\n';

test("rejects a self-consistent result identity substituted within an admitted directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "guild-receipt-identity-test-"));
  try {
    const result = await runTrial(root, request, async ({ emit, artifactDirectory }) => {
      emit(raw); await writeFile(join(artifactDirectory, "children.jsonl"), observer, { mode: 0o600 }); return { exitCode: 0 };
    });
    const directory = join(root, result.id), substituted = { ...result, id: "11111111-1111-4111-8111-111111111111" };
    const savedRequest = JSON.parse(await readFile(join(directory, "request.json"), "utf8"));
    savedRequest.id = substituted.id;
    await writeFile(join(directory, "request.json"), JSON.stringify(savedRequest));
    await writeFile(join(directory, "result.json"), JSON.stringify(substituted));
    await assert.rejects(deriveTrialReceipt(directory, request, substituted), /Trial evidence mismatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("loads bound supervisor evidence only through the bounded private receipt reader", async () => {
  const root = await mkdtemp(join(tmpdir(), "guild-receipt-supervisor-test-"));
  try {
    const trialIdentity = { version: 1 as const, id: "00000000-0000-4000-8000-000000000001", requestDigest: digest("request") };
    const trusted = { version: 1 as const, kind: "guild-eval-supervisor-spawn" as const, trialIdentity,
      invocationDigest: digest("invocation"), configurationSha256: digest("configuration"), supervisorPid: 6, parentPid: 24 };
    const launch = { version: 1 as const, historyDigest: digest("history"), configurationSha256: trusted.configurationSha256,
      runtimeRequirementSha256: digest("runtime"), invocationDigest: trusted.invocationDigest, scopedAuthIdentityDigest: digest("auth"),
      implementationDigest: digest("implementation"), supervisorPid: trusted.supervisorPid };
    const file = join(root, "supervisor.json"), raw = JSON.stringify(trusted) + "\n";
    await writeFile(file, raw, { flag: "wx", mode: 0o600 });
    const audit = await loadBoundSupervisorEvidence(root, { trialIdentity, trusted, launch });
    assert.deepEqual(audit.observation, trusted);
    await chmod(file, 0o640);
    await assert.rejects(loadBoundSupervisorEvidence(root, { trialIdentity, trusted, launch }), /Bound supervisor evidence mismatch/);
    await rm(file); await symlink(join(root, "elsewhere"), file);
    await assert.rejects(loadBoundSupervisorEvidence(root, { trialIdentity, trusted, launch }), /Bound supervisor evidence mismatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const [policy, owned] of [[CANDIDATE_NATIVE_POLICY_V2, undefined], [CANDIDATE_NATIVE_POLICY_V3, undefined], [CANDIDATE_NATIVE_POLICY_V3, true], [CANDIDATE_NATIVE_POLICY_V3, false]] as const) test(`candidate policy ${policy.version} receipt audits bound evidence, owned=${owned}`, async t => {
  const root = await mkdtemp(join(tmpdir(), "guild-native-receipt-supervisor-test-"));
  try {
    const controls: TrialControls = { id: randomUUID(), ...(policy.version === 3 ? { finalization: 'confined-required' as const } : {}) };
    const nativeRequest = { ...request, ...(owned !== undefined ? { task: loadDevelopmentBank().tasks.find(t => t.grader === 'authorization')! } : {}), cohort: { model: "openai-codex/gpt-6-astra", thinking: "high" } };
    const schedule = (['main-only', 'guild-available'] as const).map(arm => ({ taskId: nativeRequest.task.id, arm, repetition: 1 }));
    const spec: CampaignSpec = { version: 2, pricing: nativePricing, nativePolicy: policy, schedule,
      bindings: { bankDigest: digest('bank'), scheduleDigest: digest(schedule), implementationDigest: digest('implementation'),
        runtimeDigest: digest('runtime'), policyDigest: digest(policy), model: nativeRequest.cohort.model, thinking: 'high' },
      limits: { maxTrials: 2, estimatedUsd: 1, activeMs: 60000, workflowMs: 1000 } };
    const admission = { id: controls.id!, slot: 0, scheduled: schedule[0], allowanceMs: 1000, activeAllowanceMs: 60000 };
    const receiptContext = { campaignDigest: digest(spec), admissionDigest: digest(admission) };
    let launch: any;
    const result = await runTrial(root, nativeRequest, async context => {
      const counts = { input: 7, output: 3, cacheRead: 2, cacheWrite: 1, totalTokens: 13 };
      const nativeMessage = { role: "assistant", provider: "openai-codex", model: "gpt-6-astra", api: nativePricing.api,
        responseId: "response-native", stopReason: "stop", usage: { ...counts, cost: calculateBaseCost(nativePricing, counts) }, content: [{ type: "text", text: "Native fixture report" }] };
      context.emit(JSON.stringify({ type: "message_end", message: nativeMessage }) + '\n{"type":"agent_end"}\n{"type":"agent_settled"}\n');
      await writeFile(join(context.artifactDirectory, "children.jsonl"), observer, { mode: 0o600 });
      const trialBindingDigest = digest("trial binding"), runtime = { version: 1 as const, nodePath: "/usr/bin/node", nodeVersion: "v24.20.0",
        platform: "linux", arch: "arm64", piVersion: policy.pi, aiVersion: policy.piAi, hashes: NATIVE_RUNTIME_PATHS.map(path => ({ path, sha256: digest(path) })) };
      const requirement = { version: (policy.version === 3 ? 2 : 1) as 1 | 2, kind: "native-runtime-input-requirement" as const, trialId: context.trialIdentity.id,
        trialBindingDigest, runtimeDigest: digest(runtime), runtime };
      const requirementRaw = JSON.stringify(requirement) + "\n", requirementSha = createHash("sha256").update(requirementRaw).digest("hex");
      const invocationIdentity = { version: 1 as const, trialIdentity: context.trialIdentity, command: "/usr/bin/node",
        args: ["/pi/dist/cli.js"], cwd: context.cwd };
      const binding = { version: 1 as const, kind: "native-campaign-input-binding" as const, trialId: context.trialIdentity.id,
        campaignDigest: receiptContext.campaignDigest, historyDigest: digest("history"), admissionDigest: receiptContext.admissionDigest, trialBindingDigest,
        invocationDigest: digest(invocationIdentity), runtimeRequirementDigest: digest(requirement), runtimeRequirementSha256: requirementSha };
      const nativeDirectory = join(context.artifactDirectory, "native"), configRaw = JSON.stringify({ admissionBinding: binding,
        directory: nativeDirectory, launchParentPid: 6, arm: context.request.arm }) + "\n";
      const configSha = createHash("sha256").update(configRaw).digest("hex");
      const supervisor = { version: 1 as const, kind: "guild-eval-supervisor-spawn" as const, trialIdentity: context.trialIdentity,
        invocationDigest: binding.invocationDigest, configurationSha256: configSha, supervisorPid: 6, parentPid: 24 };
      launch = { version: 1 as const, historyDigest: binding.historyDigest, configurationSha256: configSha,
        runtimeRequirementSha256: requirementSha, invocationDigest: binding.invocationDigest, scopedAuthIdentityDigest: digest("auth"),
        implementationDigest: digest("implementation"), supervisorPid: 6 };
      const envelope = (sequence: number, event: any) => ({ version: 2, trialId: context.trialIdentity.id, configurationSha256: configSha,
        runtimeRequirementSha256: requirementSha, invocationDigest: binding.invocationDigest, supervisorPid: 6,
        pid: 24, ppid: 6, actor: "parent", sequence, event });
      const requestId = "00000000-0000-4000-8000-000000000010";
      const logical = { instructions: "Bound instructions", tools: ["bash", "edit", "find", "grep", "ls", "read", "write"].map(name => ({ type: "function", name })),
        input: [{ role: "user", content: context.request.task.prompt }] };
      const outbound = { model: "gpt-6-astra", reasoning: { effort: "high" }, ...logical };
      const selected = runtime.hashes.map((entry, i) => ({ id: i === 0 ? "runtime/node" : `runtime/file-${i}`, ...entry }));
      const observedFiles = selected.map((entry, i) => ({ id: entry.id, sha256: entry.sha256, bytes: i + 1,
        dev: String(100 + i), ino: String(200 + i), uid: 0, mode: 0o444 }));
      const runtimeObservation = { version: 1, kind: "native-runtime-file-observation", trialId: context.trialIdentity.id,
        requirementDigest: digest(requirement), process: { pid: 24, ppid: 6, nodeVersion: runtime.nodeVersion, nodePath: runtime.nodePath,
          platform: runtime.platform, arch: runtime.arch, executable: { dev: observedFiles[0].dev, ino: observedFiles[0].ino } },
        files: { version: 1, kind: "native-selected-file-observation", inventoryDigest: digest(selected), files: observedFiles },
        packages: [{ id: observedFiles[1].id, name: "@earendil-works/pi-coding-agent", version: runtime.piVersion },
          { id: observedFiles[10].id, name: "@earendil-works/pi-ai", version: runtime.aiVersion }] };
      const contextEvent = { type: "context", model: nativePricing.model, thinking: "high", target: null,
        tools: ["bash", "edit", "find", "grep", "ls", "read", "write"], systemPromptDigest: digest("system prompt") };
      const attemptId = "00000000-0000-4000-8000-000000000020";
      const events = [{ type: "process_start", node: "v24.20.0", piVersion: policy.pi, runtimeDigest: requirement.runtimeDigest, trialBindingDigest },
        { type: "runtime_observation", observation: runtimeObservation }, contextEvent,
        { type: "request_start", requestId }, contextEvent, contextEvent,
        { type: "payload", requestId, final: { model: "gpt-6-astra", thinking: "high", serviceTier: "omitted" } },
        { type: "request_content", requestId, logical, outbound },
        { type: "transport", requestId, record: { type: "start", transport: "websocket", attemptId } },
        { type: "transport", requestId, record: { type: "response", transport: "websocket", attemptId, meter: { responseId: "response-native", model: "gpt-6-astra",
          status: "completed", serviceTier: "default", input: 10, output: 3, total: 13, cacheRead: 2, cacheWrite: 1 } } },
        { type: "transport", requestId, record: { type: "end", transport: "websocket", attemptId, reason: "terminal" } },
        { type: "request_end", requestId, complete: true }, { type: "process_end", exitCode: 0 }];
      const producer = events.map((event, sequence) => envelope(sequence, event)).map(row => JSON.stringify(row)).join("\n") + "\n";
      await mkdir(nativeDirectory, { mode: 0o700 });
      await writeFile(join(context.artifactDirectory, "runtime-requirement.json"), requirementRaw, { mode: 0o600 });
      await writeFile(join(context.artifactDirectory, "native-config.json"), configRaw, { mode: 0o600 });
      await writeFile(join(context.artifactDirectory, "invocation.json"), JSON.stringify({ ...invocationIdentity,
        implementationDigest: digest("implementation") }) + "\n", { mode: 0o600 });
      await writeFile(join(context.artifactDirectory, "supervisor.json"), JSON.stringify(supervisor) + "\n", { mode: 0o600 });
      await writeFile(join(nativeDirectory, "24.jsonl"), producer, { mode: 0o600 });
      if (owned !== undefined) {
        const { selection } = await fixture(t);
        const baseline = await snapshot(context.cwd);
        selection.producer = context.cwd;
        selection.retained = join(root, '.finalization', context.trialIdentity.id, 'artifact');
        selection.snapshotGitDigest = approvedGitDigest(await readTree(context.cwd));
        controls.finalizationOrigin = issueInertFinalizationOrigin(context.artifactDirectory, {
          trialId: context.trialIdentity.id, requestDigest: digest(nativeRequest), baselineDigest: digest(baseline),
          ...receiptContext, launchDigest: digest(launch),
        }, selection, backend(selection, { pass: owned }).boundary);
        await writeFile(join(context.cwd, 'src/users.mjs'), 'authored inert bytes');
      }
      return { exitCode: 0, supervisor };
    }, undefined, controls);
    const directory = join(root, result.id), producerFile = join(directory, "native/24.jsonl");
    await assert.rejects(deriveNativeTrialReceipt(directory, nativeRequest, result, launch, nativePricing, NATIVE_POLICY_V1, receiptContext), /Candidate native-v2 policy is required/);
    await assert.rejects(deriveNativeTrialReceipt(directory, nativeRequest, result, launch, nativePricing,
      policy.version === 3 ? CANDIDATE_NATIVE_POLICY_V2 : CANDIDATE_NATIVE_POLICY_V3, receiptContext));
    if (policy.version === 3) {
      const configFile = join(directory, "repo/.git/config"), config = await readFile(configFile);
      await writeFile(configFile, "invalid inert config [");
      const exec = t.mock.method(childProcess, 'execFile', () => { throw new Error('V3 receipt must not invoke Git or candidates'); });
      const spawn = t.mock.method(childProcess, 'spawn', () => { throw new Error('V3 receipt must not spawn'); });
      syncBuiltinESMExports();
      try {
        for (const retained of [result, JSON.parse(await readFile(join(directory, "result.json"), "utf8"))]) {
          if (owned === undefined) await assert.rejects(deriveNativeTrialReceipt(directory, nativeRequest, retained, launch, nativePricing, policy, receiptContext),
            /Confined final snapshot evidence is required/);
          else {
            const receipt = await deriveNativeTrialReceipt(directory, nativeRequest, retained, launch, nativePricing, policy, receiptContext);
            assert.equal(receipt.outcome, owned ? 'recorded' : 'failed');
            assert.equal(receipt.integrity, 'ok');
            // Same maintained fresh/resume selector; synthetic events are not admission authority.
            const events = [{ type: 'started', admission }, { type: 'launch_prepared', id: result.id, launch }];
            assert.deepEqual(await deriveCampaignTrialReceipt(spec, events, directory, nativeRequest, result,
              { mode: "fresh", expectedResultDigest: receipt.resultDigest, preparedLaunch: launch }), receipt);
            assert.deepEqual(await deriveCampaignTrialReceipt(spec, [...events, { type: "finished", id: result.id, receipt }], directory, nativeRequest, retained,
              { mode: "retained", expectedResultDigest: receipt.resultDigest }), receipt);
            assert(receipt.nativeAudit?.files.some(f => f.path === 'finalization.json'));
            assert.deepEqual(await deriveNativeTrialReceipt(directory, nativeRequest, result, launch, nativePricing, policy, receiptContext), receipt);
          }
        }
        if (owned === false) {
          const receipt = await deriveNativeTrialReceipt(directory, nativeRequest, result, launch, nativePricing, policy, receiptContext);
          const events = [{ type: 'started', admission }, { type: 'launch_prepared', id: result.id, launch },
            { type: 'finished', id: result.id, receipt, elapsedMs: 1 }];
          const recordFile = join(root, '.finalization', result.id, 'finalization.json');
          const resultFile = join(directory, 'result.json');
          const recordRaw = await readFile(recordFile, 'utf8'), resultRaw = await readFile(resultFile, 'utf8');
          try {
            const record = JSON.parse(recordRaw), rewritten = JSON.parse(resultRaw);
            record.comparator.state = 'passed'; record.comparator.passed = true;
            const changedRecord = JSON.stringify(record);
            rewritten.finalization.recordDigest = createHash('sha256').update(changedRecord).digest('hex');
            rewritten.grade.behavior = true;
            await writeFile(recordFile, changedRecord);
            await writeFile(resultFile, JSON.stringify(rewritten));
            // Every local consistency check passes; only the independent settlement
            // can distinguish this rewritten success from the original rejection.
            assert.equal((await deriveNativeTrialReceipt(directory, nativeRequest, rewritten, launch,
              nativePricing, policy, receiptContext)).outcome, 'recorded');
            await assert.rejects(deriveCampaignTrialReceipt(spec, events, directory, nativeRequest, rewritten,
              { mode: "retained", expectedResultDigest: receipt.resultDigest }),
              /Committed trial result evidence mismatch/);
            // A digest obtained from the same rewritten file is not authority.
            await assert.rejects(deriveCampaignTrialReceipt(spec, events, directory, nativeRequest, rewritten,
              { mode: "retained", expectedResultDigest: digest(rewritten) }), /Committed trial result evidence mismatch/);
            await assert.rejects(deriveCampaignTrialReceipt(spec, events, directory, nativeRequest, rewritten,
              { mode: "fresh", expectedResultDigest: receipt.resultDigest, preparedLaunch: launch }), /Committed trial result evidence mismatch/);
          } finally { await writeFile(recordFile, recordRaw); await writeFile(resultFile, resultRaw); }
          const authority = { mode: "retained" as const, expectedResultDigest: receipt.resultDigest };
          for (const history of [events.slice(0, 2), [...events, events[2]]]) {
            await assert.rejects(deriveCampaignTrialReceipt(spec, history, directory, nativeRequest, result, authority),
              /Committed trial result evidence mismatch/);
          }
          assert.deepEqual(await deriveCampaignTrialReceipt(spec, events, directory, nativeRequest,
            JSON.parse(await readFile(resultFile, 'utf8')), authority), receipt);
        }
        assert.equal(exec.mock.callCount(), 0); assert.equal(spawn.mock.callCount(), 0);
      } finally { exec.mock.restore(); spawn.mock.restore(); syncBuiltinESMExports(); await writeFile(configFile, config); }
    } else {
      const receipt = await deriveNativeTrialReceipt(directory, nativeRequest, result, launch, nativePricing, policy, receiptContext);
      assert.equal(receipt.nativeAudit?.version, 2); assert.equal(receipt.nativeAudit?.evidence, "candidate-native-v2");
      assert.deepEqual(receipt.nativeAudit?.files.map(file => file.path), ["baseline.json", "children.jsonl", "invocation.json", "native-config.json", "native/24.jsonl",
        "parent.jsonl", "request.json", "result.json", "runtime-requirement.json", "supervisor.json"]);
      assert.deepEqual(await deriveNativeTrialReceipt(directory, nativeRequest, result, launch, nativePricing, policy, receiptContext), receipt);
    }
    await assert.rejects(deriveNativeTrialReceipt(directory, nativeRequest, result, launch, nativePricing, policy,
      { ...receiptContext, admissionDigest: digest("other admission") }), /Trial evidence mismatch/);
    const requestFile = join(directory, "request.json"), requestRaw = await readFile(requestFile, "utf8");
    await writeFile(requestFile, "{}\n", { mode: 0o600 });
    await assert.rejects(deriveNativeTrialReceipt(directory, nativeRequest, result, launch, nativePricing, policy, receiptContext), /Trial evidence mismatch/);
    await writeFile(requestFile, requestRaw, { mode: 0o600 });
    const resultFile = join(directory, "result.json"), resultRaw = await readFile(resultFile, "utf8"), changedResult: any = structuredClone(result);
    changedResult.trace.finalText = "substituted retained summary";
    await writeFile(resultFile, JSON.stringify(changedResult) + "\n", { mode: 0o600 });
    await assert.rejects(deriveNativeTrialReceipt(directory, nativeRequest, changedResult, launch, nativePricing, policy, receiptContext), /Trial evidence mismatch/);
    await writeFile(resultFile, resultRaw, { mode: 0o600 });
    const invocationFile = join(directory, "invocation.json"), invocationRaw = await readFile(invocationFile, "utf8");
    const changedInvocation = { ...JSON.parse(invocationRaw), implementationDigest: digest("other implementation") };
    await writeFile(invocationFile, JSON.stringify(changedInvocation) + "\n", { mode: 0o600 });
    await assert.rejects(deriveNativeTrialReceipt(directory, nativeRequest, result, launch, nativePricing, policy, receiptContext), /Trial evidence mismatch/);
    await writeFile(invocationFile, invocationRaw, { mode: 0o600 });
    await chmod(producerFile, 0o640);
    await assert.rejects(deriveNativeTrialReceipt(directory, nativeRequest, result, launch, nativePricing, policy, receiptContext), /Bound producer evidence mismatch/);
    await chmod(producerFile, 0o600); await writeFile(join(directory, "native/unbound.txt"), "extra", { mode: 0o600 });
    await assert.rejects(deriveNativeTrialReceipt(directory, nativeRequest, result, launch, nativePricing, policy, receiptContext), /Bound producer evidence mismatch/);
    await rm(join(directory, "native/unbound.txt"));
    const changed: any = structuredClone(result); changed.supervisor.parentPid++;
    await assert.rejects(deriveNativeTrialReceipt(directory, nativeRequest, changed, launch, nativePricing, policy, receiptContext), /Bound supervisor evidence mismatch/);
    const substituted: any = structuredClone(result);
    substituted.supervisor.trialIdentity.id = "11111111-1111-4111-8111-111111111111";
    await writeFile(join(directory, "supervisor.json"), JSON.stringify(substituted.supervisor) + "\n");
    await assert.rejects(deriveNativeTrialReceipt(directory, nativeRequest, substituted, launch, nativePricing, policy, receiptContext), /Bound supervisor evidence mismatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ordinary receipts cannot certify native model traces without the native evidence contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "guild-receipt-native-test-"));
  try {
    // Inert strings and an in-process driver only: no SDK, credentials or provider.
    const nativeRequest = { ...request, cohort: { model: "openai-codex/gpt-6-astra", thinking: "high" } };
    const result = await runTrial(root, nativeRequest, async ({ emit, artifactDirectory }) => {
      emit(raw.replace('"provider":"test"', '"provider":"openai-codex"').replace('"model":"fake"', '"model":"gpt-6-astra"'));
      await writeFile(join(artifactDirectory, "children.jsonl"), observer, { mode: 0o600 }); return { exitCode: 0 };
    });
    assert.equal(result.trace.complete, true);
    await assert.rejects(deriveTrialReceipt(join(root, result.id), nativeRequest, result), /Native trial evidence contract is required/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects missing, altered, or unsafe evidence instead of trusting stored summaries", async () => {
  for (const mutation of ["result", "parent", "baseline", "request", "missing-child", "symlink-child", "oversized-result"]) {
    const root = await mkdtemp(join(tmpdir(), "guild-receipt-integrity-test-"));
    try {
      const result = await runTrial(root, request, async ({ emit, artifactDirectory }) => {
        emit(raw); await writeFile(join(artifactDirectory, "children.jsonl"), observer, { mode: 0o600 }); return { exitCode: 0 };
      });
      const directory = join(root, result.id);
      if (mutation === "parent") await writeFile(join(directory, "parent.jsonl"), raw.replace("0.25", "0.01"));
      else if (mutation === "missing-child") await rm(join(directory, "children.jsonl"));
      else if (mutation === "symlink-child") { await rm(join(directory, "children.jsonl")); await symlink(join(directory, "parent.jsonl"), join(directory, "children.jsonl")); }
      else if (mutation === "oversized-result") await truncate(join(directory, "result.json"), 65 * 1024 * 1024);
      else {
        const file = join(directory, `${mutation}.json`), data = JSON.parse(await readFile(file, "utf8"));
        if (mutation === "baseline") data.status += "unrecorded alteration";
        else if (mutation === "request") data.request.arm = "guild-available";
        else data.trace.totalObserved.cost = 0;
        await writeFile(file, JSON.stringify(data));
      }
      await assert.rejects(deriveTrialReceipt(directory, request, result), /evidence/i, mutation);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("does not certify a different model or failed process from an earlier complete trace", async () => {
  for (const mismatch of [true, false]) {
    const root = await mkdtemp(join(tmpdir(), "guild-receipt-cohort-test-"));
    try {
      const result = await runTrial(root, request, async ({ emit, artifactDirectory }) => {
        emit(mismatch ? raw.replace('"fake"', '"other"') : raw);
        await writeFile(join(artifactDirectory, "children.jsonl"), observer, { mode: 0o600 }); return { exitCode: mismatch ? 0 : 7 };
      });
      const receipt = await deriveTrialReceipt(join(root, result.id), request, result);
      assert.equal(receipt.estimatedUsd, null);
      assert.equal(receipt.outcome, "failed");
      if (mismatch) assert.equal(receipt.integrity, "failed");
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("ordinary task failure is a result, but later changes even to allowed files invalidate preservation evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "guild-receipt-state-test-"));
  try {
    const task = loadDevelopmentBank().tasks.find(t => t.grader === "authorization")!;
    const authRequest = { ...request, task };
    const result = await runTrial(root, authRequest, async ({ emit, artifactDirectory }) => {
      emit(raw); await writeFile(join(artifactDirectory, "children.jsonl"), observer, { mode: 0o600 }); return { exitCode: 0 };
    });
    const directory = join(root, result.id);
    const failure = await deriveTrialReceipt(directory, authRequest, result);
    assert.equal(failure.outcome, "failed");
    assert.equal(failure.integrity, "ok");
    assert.equal(failure.estimatedUsd, 0.25);
    await writeFile(join(directory, "repo/src/users.mjs"), "export function updateUser() {}\n");
    assert.equal((await deriveTrialReceipt(directory, authRequest, result)).integrity, "failed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("derives a settlement from retained raw usage and independently inspected final state", async () => {
  const root = await mkdtemp(join(tmpdir(), "guild-receipt-test-"));
  try {
    const result = await runTrial(root, request, async ({ emit, artifactDirectory }) => {
      emit(raw); await writeFile(join(artifactDirectory, "children.jsonl"), observer, { mode: 0o600 }); return { exitCode: 0 };
    });
    const receipt = await deriveTrialReceipt(join(root, result.id), request, result);
    assert.equal(receipt.estimatedUsd, 0.25);
    assert.equal(receipt.integrity, "ok");
    assert.equal(receipt.outcome, "recorded");
    assert.match(receipt.resultDigest, /^[a-f0-9]{64}$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
