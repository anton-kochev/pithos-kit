import assert from "node:assert/strict";
import { test } from "node:test";
import { loadDevelopmentBank } from "../src/bank.ts";
import { digest } from "../src/manifest.ts";
import { createSchedule } from "../src/runner.ts";
import { NATIVE_POLICY_V1 } from "../src/native-policy.ts";
import { bindNativeTrial, bindNativeParentInvocation } from "../src/native-trial-binding.ts";

// In-memory admission fixture only: the native ledger still cannot admit.
function fixture(arm: "main-only" | "guild-available" = "main-only") {
  const bank = loadDevelopmentBank(), schedule = createSchedule(bank, 1, "native-trial-binding");
  const slot = schedule.findIndex(s => s.arm === arm), scheduled = schedule[slot];
  const spec = { version: 2 as const, nativePolicy: structuredClone(NATIVE_POLICY_V1),
    bindings: { bankDigest: digest(bank), scheduleDigest: digest(schedule), implementationDigest: digest("inert implementation"),
      runtimeDigest: digest("inert runtime"), policyDigest: digest("inert policy"), model: "openai-codex/gpt-6-astra", thinking: "high" },
    schedule, limits: { maxTrials: 12, estimatedUsd: 10, activeMs: 3600000, workflowMs: 300000 },
    pricing: { version: 1 as const, model: "openai-codex/gpt-6-astra", api: "openai-codex-responses", serviceTier: "base" as const,
      cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 } } };
  const id = "00000000-0000-4000-8000-000000000001";
  const admission = { id, slot, scheduled: structuredClone(scheduled), allowanceMs: 300000, activeAllowanceMs: 3600000 };
  const request = { task: structuredClone(bank.tasks.find(t => t.id === scheduled.taskId)!), arm, repetition: 1,
    cohort: { model: spec.bindings.model, thinking: spec.bindings.thinking }, timeoutMs: spec.limits.workflowMs };
  const artifactDirectory = `/campaign/trials/${id}`;
  return { spec, bank, admission, request, trialIdentity: { version: 1 as const, id, requestDigest: digest(request) },
    retentionRoot: "/campaign", artifactDirectory, cwd: `${artifactDirectory}/repo` };
}

test("binds the exact scheduled request, runner identity and retention location without exposing task contents", () => {
  for (const arm of ["main-only", "guild-available"] as const) {
    const input = fixture(arm), bound = bindNativeTrial(input);
    assert.deepEqual(bound, { version: 1, kind: "native-trial-input-binding", trialId: input.admission.id,
      campaignDigest: digest(input.spec), admissionDigest: digest(input.admission), requestDigest: digest(input.request),
      locationDigest: digest({ retentionRoot: input.retentionRoot, artifactDirectory: input.artifactDirectory, cwd: input.cwd }) });
    assert.equal(Object.isFrozen(bound), true);
    assert.doesNotMatch(JSON.stringify(bound), /rubric|prompt|\/campaign/);
  }
});

function invocation(input: ReturnType<typeof fixture>) {
  const guild = input.request.arm === "guild-available";
  return { version: 1 as const, trialIdentity: structuredClone(input.trialIdentity), command: "/usr/bin/node", cwd: input.cwd,
    args: ["--import", "file:///guild/evaluation/src/child-observer.ts", "/opt/pi-npm/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
      "--mode", "json", "-p", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--approve",
      ...(guild ? ["--extension", "/guild/extensions/index.ts"] : []), "--tools", `read,write,edit,bash,grep,find,ls${guild ? ",guild_handover" : ""}`,
      "--model", "openai-codex/gpt-6-astra", "--thinking", "high", "--", input.request.task.prompt] };
}

test("binds exact parent launch arguments to the trial for both arms, not just model flags or a prompt digest", () => {
  for (const arm of ["main-only", "guild-available"] as const) {
    const input = fixture(arm), actual = invocation(input);
    const bound = bindNativeParentInvocation(input, "/guild", actual);
    assert.deepEqual(bound, { version: 1, kind: "native-parent-invocation-input-binding", trialId: input.admission.id,
      trialBindingDigest: digest(bindNativeTrial(input)), invocationDigest: digest(actual) });
    assert.equal(Object.isFrozen(bound), true);
  }
});

test("rejects altered parent executable, argv, task bytes, context, identity and extra unbound metadata", () => {
  for (const arm of ["main-only", "guild-available"] as const) for (const change of [
    (a: any) => a.command = "/other/node",
    (a: any) => a.version++,
    (a: any) => a.cwd += "/other",
    (a: any) => a.trialIdentity.id = "00000000-0000-4000-8000-000000000002",
    (a: any) => a.trialIdentity.requestDigest = "0".repeat(64),
    (a: any) => a.args[1] = "file:///other/observer.ts",
    (a: any) => a.args[2] = "/other/cli.js",
    (a: any) => a.args.splice(a.args.indexOf("--no-context-files"), 1),
    (a: any) => a.args.splice(a.args.indexOf("--approve"), 1),
    (a: any) => a.args[a.args.indexOf("--model") + 1] = "test/fake",
    (a: any) => a.args[a.args.indexOf("--thinking") + 1] = "medium",
    (a: any) => a.args[a.args.indexOf("--tools") + 1] += ",create_commit",
    (a: any) => a.args.splice(-2, 0, "--system-prompt", "unapproved"),
    (a: any) => a.args.splice(-2, 0, "--extension", "/extra.ts"),
    (a: any) => a.args[a.args.length - 1] += " changed instructions",
    (a: any) => a.args[a.args.length - 2] = "--append-system-prompt",
    (a: any) => a.extra = "unbound",
  ]) {
    const input = fixture(arm), actual = invocation(input); change(actual);
    assert.throws(() => bindNativeParentInvocation(input, "/guild", actual), /^Error: Native parent invocation mismatch$/);
  }
  const input = fixture();
  for (const root of ["relative", "/guild/../guild", "/" + "a".repeat(4096)]) {
    assert.throws(() => bindNativeParentInvocation(input, root, invocation(input)), /^Error: Native parent invocation mismatch$/);
  }
  const other = fixture(); other.retentionRoot = "/other-campaign"; other.artifactDirectory = `/other-campaign/trials/${other.admission.id}`; other.cwd = `${other.artifactDirectory}/repo`;
  assert.throws(() => bindNativeParentInvocation(other, "/guild", invocation(input)), /^Error: Native parent invocation mismatch$/);
});

test("requires the complete native policy and the exact frozen development bank", () => {
  for (const change of [
    (i: any) => { i.spec.version = 1; delete i.spec.nativePolicy; },
    (i: any) => delete i.spec.nativePolicy,
    (i: any) => i.spec.nativePolicy.version++,
    (i: any) => delete i.spec.pricing,
    (i: any) => i.spec.pricing.api = "wrong-api",
    (i: any) => i.spec.bindings.bankDigest = "0".repeat(64),
    (i: any) => i.spec.bindings.scheduleDigest = "0".repeat(64),
    (i: any) => i.spec.limits.maxTrials = 13,
    (i: any) => { i.bank.tasks[0].split = "promotion"; i.spec.bindings.bankDigest = digest(i.bank); },
    (i: any) => { i.bank.tasks.pop(); i.spec.bindings.bankDigest = digest(i.bank); },
    (i: any) => { i.bank.tasks[0].fixture.files["README.md"] = "changed"; i.spec.bindings.bankDigest = digest(i.bank); },
  ]) {
    const input = fixture(); change(input);
    assert.throws(() => bindNativeTrial(input), /^Error: Native trial binding mismatch$/);
  }
});

test("rejects cross-trial identities, malformed admissions and noncanonical retention locations", () => {
  for (const change of [
    (i: any) => delete i.trialIdentity,
    (i: any) => i.trialIdentity.version++,
    (i: any) => i.trialIdentity.id = "00000000-0000-4000-8000-000000000002",
    (i: any) => i.trialIdentity.requestDigest = "0".repeat(64),
    (i: any) => i.trialIdentity.extra = "unbound",
    (i: any) => i.admission.id = i.trialIdentity.id = "not-a-uuid",
    (i: any) => i.admission.slot++,
    (i: any) => i.admission.slot = -1,
    (i: any) => i.admission.slot = i.spec.limits.maxTrials,
    (i: any) => i.admission.scheduled.extra = "unbound",
    (i: any) => i.admission.allowanceMs--,
    (i: any) => i.admission.activeAllowanceMs++,
    (i: any) => i.admission.activeAllowanceMs = 0,
    (i: any) => i.admission.activeAllowanceMs = 1.5,
    (i: any) => i.admission.extra = "unbound",
    (i: any) => i.artifactDirectory = "/campaign/trials/00000000-0000-4000-8000-000000000002",
    (i: any) => i.cwd += "/other",
    (i: any) => { i.retentionRoot = "/campaign/../campaign"; i.artifactDirectory = `${i.retentionRoot}/trials/${i.admission.id}`; i.cwd = `${i.artifactDirectory}/repo`; },
    (i: any) => i.retentionRoot = "relative",
    (i: any) => i.retentionRoot = "/" + "x".repeat(4096),
    (i: any) => i.retentionRoot = "/campaign\u0000private",
    (i: any) => i.extra = "unbound",
  ]) {
    const input = fixture(); change(input);
    assert.throws(() => bindNativeTrial(input), /^Error: Native trial binding mismatch$/);
  }
  for (const input of [null, undefined, [], {}]) assert.throws(() => bindNativeTrial(input as any), /^Error: Native trial binding mismatch$/);
});

test("bounds otherwise matching retention paths by UTF-8 bytes", () => {
  const input = fixture();
  input.retentionRoot = "/" + "é".repeat(2048);
  input.artifactDirectory = `${input.retentionRoot}/trials/${input.admission.id}`;
  input.cwd = `${input.artifactDirectory}/repo`;
  assert.throws(() => bindNativeTrial(input), /^Error: Native trial binding mismatch$/);
});

test("rejects request drift against the frozen bank and schedule even with a recomputed request digest", () => {
  for (const change of [
    (i: any) => i.request.task.prompt += " changed",
    (i: any) => i.request.task = i.bank.tasks.find((t: any) => t.id !== i.admission.scheduled.taskId),
    (i: any) => i.request.task.allowedChanges.push("extra.txt"),
    (i: any) => i.request.task.rubric = ["different grader"],
    (i: any) => i.request.arm = "guild-available",
    (i: any) => i.request.repetition++,
    (i: any) => i.request.cohort.model = "test/fake",
    (i: any) => i.request.cohort.thinking = "medium",
    (i: any) => i.request.timeoutMs--,
    (i: any) => i.request.extra = "unapproved",
  ]) {
    const input = fixture(); change(input); input.trialIdentity.requestDigest = digest(input.request);
    assert.throws(() => bindNativeTrial(input), /^Error: Native trial binding mismatch$/);
  }
});
