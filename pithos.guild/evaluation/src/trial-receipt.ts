import { auditRetainedFinalization } from './trial-finalization.ts';
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { digest } from "./manifest.ts";
import { CANDIDATE_NATIVE_POLICY_V3, CANDIDATE_NATIVE_POLICY_V2, NATIVE_POLICY_V1, validateNativePolicy, type NativePolicy } from "./native-policy.ts";
import { analyzeTrace } from "./trace.ts";
import type { BasePricing } from "./pricing.ts";
import { snapshot, changedPaths } from "./fixture.ts";
import type { CampaignReceipt, PreparedLaunch } from "./campaign.ts";
import type { runTrial, TrialRequest } from "./runner.ts";
import { auditBoundProducerEnvelopes, auditBoundRuntimeObservations, auditBoundSupervisorEvidence } from "./native-evidence.ts";
import { readNativeConfig } from "./native-config.ts";
import { readNativeRuntimeInput } from "./native-runtime-input.ts";
import { validateNativeLaunchBinding } from "./native-input-contracts.ts";

type TrialResult = Awaited<ReturnType<typeof runTrial>>;
const normalized = (value: unknown) => JSON.parse(JSON.stringify(value));
function evidence(ok: unknown): asserts ok { if (!ok) throw new Error("Trial evidence mismatch"); }
async function readEvidence(file: string, maxBytes: number, signal?: AbortSignal): Promise<string> {
  try {
    signal?.throwIfAborted();
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      evidence(info.isFile() && info.nlink === 1 && info.uid === process.getuid?.() && (info.mode & 0o077) === 0 && info.size <= maxBytes);
      const bytes = Buffer.alloc(info.size + 1);
      let count = 0;
      while (count < bytes.length) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(bytes, count, bytes.length - count, null);
        if (!bytesRead) break;
        count += bytesRead;
      }
      evidence(count === info.size);
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count));
    } finally { await handle.close(); }
  } catch { throw new Error("Unreadable, unsafe, or interrupted trial evidence"); }
}
export async function loadBoundSupervisorEvidence(directory: string, expected: Parameters<typeof auditBoundSupervisorEvidence>[1], signal?: AbortSignal) {
  try {
    const raw = await readEvidence(join(directory, "supervisor.json"), 64 * 1024, signal);
    return { ...auditBoundSupervisorEvidence(raw, expected), raw };
  } catch { throw new Error("Bound supervisor evidence mismatch"); }
}
export async function loadTrialResult(directory: string, expectedDigest: string, signal?: AbortSignal): Promise<TrialResult> {
  try {
    const result = JSON.parse(await readEvidence(join(directory, "result.json"), 64 * 1024 * 1024, signal));
    evidence(digest(result) === expectedDigest);
    return result;
  } catch { throw new Error("Retained trial result evidence mismatch"); }
}
async function loadBoundProducerEvidence(directory: string,
  expected: Pick<Parameters<typeof auditBoundProducerEnvelopes>[1], "trialIdentity" | "launch" | "supervisor">,
  arm: TrialRequest["arm"], signal?: AbortSignal) {
  try {
    signal?.throwIfAborted();
    const configFile = join(directory, "native-config.json"), requirementFile = join(directory, "runtime-requirement.json");
    const configRaw = await readEvidence(configFile, 1024 * 1024, signal);
    const requirementRaw = await readEvidence(requirementFile, 1024 * 1024, signal);
    evidence(createHash("sha256").update(configRaw).digest("hex") === expected.launch.configurationSha256
      && createHash("sha256").update(requirementRaw).digest("hex") === expected.launch.runtimeRequirementSha256);
    const config = readNativeConfig(configFile, expected.launch.configurationSha256);
    const binding = validateNativeLaunchBinding(config.admissionBinding);
    const requirement = readNativeRuntimeInput(configFile, expected.launch.configurationSha256);
    const nativeDirectory = join(directory, "native"), before = await lstat(nativeDirectory);
    evidence(before.isDirectory() && !before.isSymbolicLink() && before.uid === process.getuid?.() && (before.mode & 0o077) === 0
      && config.directory === nativeDirectory && config.launchParentPid === expected.launch.supervisorPid && config.arm === arm);
    const names = (await readdir(nativeDirectory)).sort();
    evidence(names.length >= 1 && names.length <= 64 && names.every(name => /^[1-9][0-9]{0,9}\.jsonl$/.test(name)));
    const processes: Record<string, string> = Object.create(null);
    for (const name of names) processes[name] = await readEvidence(join(nativeDirectory, name), 16 * 1024 * 1024, signal);
    const after = await lstat(nativeDirectory), finalNames = (await readdir(nativeDirectory)).sort();
    evidence(isDeepStrictEqual(names, finalNames) && before.dev === after.dev && before.ino === after.ino
      && before.mode === after.mode && before.uid === after.uid && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs);
    const audit = auditBoundProducerEnvelopes(processes, { ...expected, binding, requirement });
    return { audit, processes, binding, requirement, configRaw, requirementRaw };
  } catch { throw new Error("Bound producer evidence mismatch"); }
}
interface NativeReceiptContext { campaignDigest: string; admissionDigest: string }
export async function deriveNativeTrialReceipt(directory: string, request: TrialRequest, expected: TrialResult, launch: PreparedLaunch,
  pricing: BasePricing, nativePolicy: NativePolicy, context: NativeReceiptContext, signal?: AbortSignal): Promise<CampaignReceipt> {
  const policy = validateNativePolicy(nativePolicy);
  if (!isDeepStrictEqual(policy, CANDIDATE_NATIVE_POLICY_V2) && !isDeepStrictEqual(policy, CANDIDATE_NATIVE_POLICY_V3)) throw new Error("Candidate native-v2 policy is required");
  evidence(request.cohort.model === nativePolicy.model && expected.id === basename(directory)
    && expected.requestDigest === digest(request) && expected.supervisor !== null);
  const trialIdentity = { version: 1 as const, id: expected.id, requestDigest: digest(request) };
  const supervisor = await loadBoundSupervisorEvidence(directory, { trialIdentity, trusted: expected.supervisor!, launch }, signal);
  const producer = await loadBoundProducerEvidence(directory, { trialIdentity, supervisor: expected.supervisor!, launch }, request.arm, signal);
  evidence(producer.requirement.version === (policy.version === 3 ? 2 : 1)
    && producer.requirement.runtime.piVersion === policy.pi && producer.requirement.runtime.aiVersion === policy.piAi);
  evidence(context && isDeepStrictEqual(Object.keys(context).sort(), ["admissionDigest", "campaignDigest"])
    && [context.campaignDigest, context.admissionDigest].every(value => /^[a-f0-9]{64}$/.test(value))
    && producer.binding.campaignDigest === context.campaignDigest && producer.binding.admissionDigest === context.admissionDigest);
  const parent = await readEvidence(join(directory, "parent.jsonl"), 16 * 1024 * 1024, signal);
  evidence(digest(parent) === expected.traceDigest);
  const children = await readEvidence(join(directory, "children.jsonl"), 16 * 1024 * 1024, signal);
  evidence(digest(children) === expected.childTraceDigest);
  const runtimeAudit = auditBoundRuntimeObservations(producer.processes, { trialIdentity, supervisor: expected.supervisor!, launch,
    binding: producer.binding, requirement: producer.requirement, request, parent, children, pricing });
  const trace = analyzeTrace(parent, children);
  evidence(trace.complete && digest(trace) === digest(expected.trace));

  const resultRaw = await readEvidence(join(directory, "result.json"), 64 * 1024 * 1024, signal);
  const saved = JSON.parse(resultRaw); evidence(digest(saved) === digest(normalized(expected)));
  const requestRaw = await readEvidence(join(directory, "request.json"), 1024 * 1024, signal);
  const { rubric: _rubric, grader: _grader, delegation: _delegation, ...publicTask } = request.task;
  evidence(digest(JSON.parse(requestRaw)) === digest({ version: 1, id: expected.id, request: { ...request, task: publicTask },
    requestDigest: digest(request), node: process.version, platform: process.platform, startedAt: expected.startedAt }));
  const invocationRaw = await readEvidence(join(directory, "invocation.json"), 1024 * 1024, signal);
  const invocation = JSON.parse(invocationRaw), invocationIdentity = { version: invocation?.version, trialIdentity: invocation?.trialIdentity,
    command: invocation?.command, args: invocation?.args, cwd: invocation?.cwd };
  evidence(invocation?.implementationDigest === launch.implementationDigest && digest(invocationIdentity) === launch.invocationDigest
    && invocation.version === 1 && isDeepStrictEqual(invocation.trialIdentity, trialIdentity)
    && typeof invocation.command === "string" && isAbsolute(invocation.command)
    && Array.isArray(invocation.args) && invocation.args.length >= 1 && invocation.args.length <= 128
    && invocation.args.every((arg: unknown) => typeof arg === "string" && Buffer.byteLength(arg) <= 65536)
    && typeof invocation.cwd === "string" && isAbsolute(invocation.cwd));
  const baselineRaw = await readEvidence(join(directory, "baseline.json"), 64 * 1024 * 1024, signal);
  const baseline = JSON.parse(baselineRaw); evidence(typeof expected.baselineDigest === "string" && digest(baseline) === expected.baselineDigest);
  // V3 consumes only owner-retained evidence after the native audits above.
  // The historical V2 diagnostic continues to use its unchanged local snapshot.
  const finalizationIdentity = { trialId: expected.id, requestDigest: digest(request), baselineDigest: expected.baselineDigest!,
    campaignDigest: context.campaignDigest, admissionDigest: context.admissionDigest, launchDigest: digest(launch) };
  const owned = policy.version === 3
    ? await auditRetainedFinalization(directory, finalizationIdentity, request.task, baseline, expected.finalization, signal) : undefined;
  if (owned) evidence(digest(owned.grade) === digest(expected.grade));
  const final = owned ? owned.grade.final : await snapshot(join(directory, "repo"), signal);
  const preserved = baseline.index === final.index && changedPaths(baseline, final).every(path => request.task.allowedChanges.includes(path))
    && expected.grade?.scope === true && expected.grade.indexPreserved === true && expected.grade.checkerMutated === false
    && expected.grade.checkCancelled === false && digest(final) === digest(expected.grade.final);

  const retained: Record<string, string> = {
    "baseline.json": baselineRaw, "children.jsonl": children, "invocation.json": invocationRaw, "native-config.json": producer.configRaw,
    "parent.jsonl": parent, "request.json": requestRaw, "result.json": resultRaw,
    "runtime-requirement.json": producer.requirementRaw, "supervisor.json": supervisor.raw,
  };
  for (const [name, raw] of Object.entries(producer.processes)) retained[`native/${name}`] = raw;
  for (const [path, raw] of Object.entries(retained)) evidence(await readEvidence(join(directory, path), 64 * 1024 * 1024, signal) === raw);
  if (owned) {
    const repeated = await auditRetainedFinalization(directory, finalizationIdentity, request.task, baseline, expected.finalization, signal);
    evidence(repeated.raw === owned.raw);
    retained['finalization.json'] = owned.raw;
  }
  const files = Object.entries(retained).map(([path, raw]) => ({ path, bytes: Buffer.byteLength(raw),
    sha256: createHash("sha256").update(raw).digest("hex") })).sort((a, b) => a.path.localeCompare(b.path));
  const nativeAudit = { version: 2 as const, evidence: CANDIDATE_NATIVE_POLICY_V2.evidence, policyDigest: digest(policy),
    campaignDigest: context.campaignDigest, admissionDigest: context.admissionDigest, trialIdentityDigest: digest(trialIdentity),
    launchDigest: digest(launch), supervisorDigest: supervisor.rawSha256, bindingDigest: digest(producer.binding),
    requirementDigest: digest(producer.requirement), runtimeAuditDigest: digest(runtimeAudit), baselineDigest: expected.baselineDigest,
    finalSnapshotDigest: digest(final), files, inventoryDigest: digest(files) };
  const complete = expected.status === "recorded" && expected.exitCode === 0 && !expected.campaignDeadlineExceeded && trace.complete;
  return { resultDigest: digest(saved), outcome: complete && preserved && expected.grade?.behavior === true ? "recorded" : "failed",
    estimatedUsd: complete && typeof runtimeAudit.usage.cost === "number" ? runtimeAudit.usage.cost : null,
    integrity: preserved ? "ok" : "failed", nativeAudit };

}
export async function deriveTrialReceipt(directory: string, request: TrialRequest, expected: TrialResult, signal?: AbortSignal, pricing?: BasePricing): Promise<CampaignReceipt> {
  // This is still the ordinary evidence contract. A matching model label and
  // internally consistent trace must not downgrade native evidence requirements.
  if (request.cohort.model === NATIVE_POLICY_V1.model) throw new Error("Native trial evidence contract is required");
  if (expected.finalization !== undefined) throw new Error("Confined final snapshot evidence is required");
  const read = (name: string, maxMiB = 64) => readEvidence(join(directory, name), maxMiB * 1024 * 1024, signal);
  const json = async (name: string) => {
    try { return JSON.parse(await read(name)); } catch { throw new Error("Unreadable or malformed trial evidence"); }
  };
  // The bridge derives this directory from the journal admission, not the result.
  // Internal agreement between rewritten request/result files is not an identity anchor.
  evidence(expected.id === basename(directory));
  const saved = await json("result.json");
  evidence(digest(saved) === digest(normalized(expected)) && expected.requestDigest === digest(request));
  const { rubric: _rubric, grader: _grader, delegation: _delegation, ...publicTask } = request.task;
  evidence(digest(await json("request.json")) === digest({ version: 1, id: expected.id, request: { ...request, task: publicTask }, requestDigest: digest(request), node: process.version, platform: process.platform, startedAt: expected.startedAt }));
  const parent = await read("parent.jsonl", 16), child = await read("children.jsonl", 16);
  evidence(digest(parent) === expected.traceDigest && digest(child) === expected.childTraceDigest);
  const trace = analyzeTrace(parent, child);
  evidence(digest(trace) === digest(expected.trace));
  const baseline = await json("baseline.json");
  evidence(digest(baseline) === expected.baselineDigest);
  const final = await snapshot(join(directory, "repo"), signal);
  const cohortMatches = trace.models.length === 1 && trace.models[0] === request.cohort.model;
  const preserved = baseline.index === final.index && changedPaths(baseline, final).every(path => request.task.allowedChanges.includes(path))
    && expected.grade?.scope === true && expected.grade.indexPreserved === true && expected.grade.checkerMutated === false
    && expected.grade.checkCancelled === false && digest(final) === digest(expected.grade.final);
  // Preserve the original trace/digest; apply newly frozen pricing only as an additional receipt audit.
  const pricingMatches = !pricing || (pricing.model === request.cohort.model && analyzeTrace(parent, child, pricing).complete);
  const complete = pricingMatches && expected.status === "recorded" && expected.exitCode === 0 && !expected.campaignDeadlineExceeded && trace.complete && cohortMatches;
  return { resultDigest: digest(saved), outcome: complete && preserved && expected.grade?.behavior === true ? "recorded" : "failed",
    estimatedUsd: complete && Number.isFinite(trace.totalObserved.cost) ? trace.totalObserved.cost : null, integrity: preserved && cohortMatches && pricingMatches ? "ok" : "failed" };
}
