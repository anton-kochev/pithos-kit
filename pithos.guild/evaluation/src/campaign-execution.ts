import { isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { prepareAdmittedNativeLaunch } from "./admitted-native-launch.ts";
import { deriveAdmittedTrialInput } from "./native-trial-binding.ts";
import { writeFile } from "node:fs/promises";
import { createPiDriver, fingerprint } from "./pi-driver.ts";
import { observeNativeFiles } from "./native-file-observation.ts";
import { NATIVE_RUNTIME_PATHS, freezeRuntime, type NativeRuntimeInventory } from "./native-input-contracts.ts";
import type { CodexAuthSource } from "./codex-auth.ts";
import { openCampaign, assertCampaignExecutionAvailable, validateCampaignSpec, type Admission, type CampaignSpec, type CampaignReceipt, type PreparedLaunch } from "./campaign.ts";
import { digest, validateBank, type TaskBank } from "./manifest.ts";
import { runTrial, type Driver } from "./runner.ts";
import { requireConfinedGrading } from "./grading-boundary.ts";
import { deriveNativeTrialReceipt, deriveTrialReceipt, loadTrialResult } from "./trial-receipt.ts";

interface Options {
  directory: string;
  spec: CampaignSpec;
  bank: TaskBank;
  driver: Driver;
  // Must be provider-free. Actual native observation/approval remains a readiness gate.
  observe: (signal?: AbortSignal) => Promise<CampaignSpec["bindings"]>;
}
interface NativeSelection {
  directory: string;
  spec: Extract<CampaignSpec, { version: 2 }>;
  bank: TaskBank;
  runtime: NativeRuntimeInventory;
  guildRoot: string;
  policy: { version: 1; evidenceDomain: "offline-integration" | "e1-development"; nativePolicy: NativeSelection["spec"]["nativePolicy"]; limits: CampaignSpec["limits"] };
  approval: "explicit-model-run-approval";
  codexAuth: CodexAuthSource;
}
// Operator assembly only. Selection inspection observes chosen files, not a
// running SDK, provider entitlement, process provenance or operator approval.
export function assembleNativeCampaign(raw: NativeSelection) {
  let selection: NativeSelection;
  try {
    selection = structuredClone(raw);
    const spec = validateCampaignSpec(selection.spec);
    if (spec.version !== 2) throw Error();
    selection.spec = spec;
    selection.bank = validateBank(selection.bank);
    selection.runtime = freezeRuntime(selection.runtime, spec.nativePolicy);
    const policy = selection.policy;
    if (!isDeepStrictEqual(Object.keys(policy).sort(), ["evidenceDomain", "limits", "nativePolicy", "version"])
      || policy.version !== 1 || !["offline-integration", "e1-development"].includes(policy.evidenceDomain)
      || !isDeepStrictEqual(policy.nativePolicy, spec.nativePolicy) || !isDeepStrictEqual(policy.limits, spec.limits)
      || digest(policy) !== spec.bindings.policyDigest || digest(selection.runtime) !== spec.bindings.runtimeDigest
      || digest(selection.bank) !== spec.bindings.bankDigest || selection.bank.tasks.some(task => task.split !== "development")
      || digest(selection.bank.tasks.map(task => task.id).sort()) !== digest([...new Set(spec.schedule.map(item => item.taskId))].sort())) throw Error();
    for (const path of [selection.directory, selection.guildRoot, selection.codexAuth.sourceFile, selection.codexAuth.temporaryRoot]) {
      if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) throw Error();
    }
  } catch { throw new Error("Native campaign selection mismatch"); }
  const inspectSelection = async (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const implementation = await fingerprint(selection.guildRoot);
    signal?.throwIfAborted();
    observeNativeFiles(selection.runtime.hashes.map((file, i) => ({ id: i === 0 ? "runtime/node" : `runtime/file-${i}`, ...file })));
    signal?.throwIfAborted();
    const observed = { ...selection.spec.bindings, bankDigest: digest(selection.bank), scheduleDigest: digest(selection.spec.schedule),
      implementationDigest: digest(implementation), runtimeDigest: digest(selection.runtime), policyDigest: digest(selection.policy) };
    if (!isDeepStrictEqual(observed, selection.spec.bindings)) throw new Error("Native campaign selection mismatch");
    return Object.freeze(observed);
  };
  const driver = createPiDriver({ approval: selection.approval, guildRoot: selection.guildRoot,
    piEntry: NATIVE_RUNTIME_PATHS[2], piPackageJson: NATIVE_RUNTIME_PATHS[1], credentials: {},
    codexAuth: selection.codexAuth, nativeRequestGate: selection.spec.pricing, nativeRuntime: selection.runtime });
  return Object.freeze({ inspectSelection,
    runNext: (signal?: AbortSignal) => runCampaignNext({ directory: selection.directory, spec: selection.spec,
      bank: selection.bank, driver, observe: inspectSelection }, signal),
  });
}
// Fresh authority comes from the original runTrial return, never result.json.
// Retained authority comes from the committed finished receipt, not its files.
export type CampaignResultAuthority =
  | { mode: "fresh"; expectedResultDigest: string; preparedLaunch?: PreparedLaunch }
  | { mode: "retained"; expectedResultDigest: string };
export async function deriveCampaignTrialReceipt(spec: CampaignSpec, events: readonly any[], directory: string,
  request: Parameters<typeof deriveTrialReceipt>[1], result: Parameters<typeof deriveTrialReceipt>[2], authority: CampaignResultAuthority,
  signal?: AbortSignal): Promise<CampaignReceipt> {
  spec = validateCampaignSpec(spec);
  if (!authority || !["fresh", "retained"].includes(authority.mode)
    || !/^[a-f0-9]{64}$/.test(authority.expectedResultDigest)
    || digest(JSON.parse(JSON.stringify(result))) !== authority.expectedResultDigest)
    throw new Error("Committed trial result evidence mismatch");
  if (authority.mode === "retained") {
    const settlements = events.filter(event => event?.type === "finished" && event.id === result.id);
    if (settlements.length !== 1 || settlements[0].receipt?.resultDigest !== authority.expectedResultDigest)
      throw new Error("Committed trial result evidence mismatch");
  }
  const preparedLaunch = authority.mode === "fresh" ? authority.preparedLaunch : undefined;
  if (spec.version === 1) return deriveTrialReceipt(directory, request, result, signal, spec.pricing);
  const admissions = events.filter(event => event?.type === "started" && event.admission?.id === result.id).map(event => event.admission);
  if (admissions.length !== 1) throw new Error("Committed native admission evidence is required");
  const retained = events.filter(event => event?.type === "launch_prepared" && event.id === result.id).map(event => event.launch);
  if (retained.length > 1 || (preparedLaunch && retained.length === 1 && !isDeepStrictEqual(preparedLaunch, retained[0])))
    throw new Error("Committed native launch evidence mismatch");
  const launch = preparedLaunch ?? (retained.length === 1 ? retained[0] : undefined);
  if (!launch) throw new Error("Committed native launch evidence is required");
  return deriveNativeTrialReceipt(directory, request, result, launch, spec.pricing, spec.nativePolicy,
    { campaignDigest: digest(spec), admissionDigest: digest(admissions[0]) }, signal);
}

function deadline(remaining: () => number) {
  const controller = new AbortController();
  const check = () => { if (remaining() <= 0) controller.abort(); };
  const timer = setTimeout(() => controller.abort(), Math.max(0, remaining()));
  check();
  return { signal: controller.signal, check, dispose: () => clearTimeout(timer) };
}
export async function runCampaignNext(options: Options, signal?: AbortSignal) {
  if (typeof options?.driver !== "function" || typeof options.observe !== "function") throw new Error("An explicit driver and provider-free observer are required");
  signal?.throwIfAborted();
  assertCampaignExecutionAvailable(options.spec);
  options = { ...options, spec: structuredClone(options.spec), bank: validateBank(options.bank) };
  if (digest(options.bank) !== options.spec.bindings.bankDigest || options.bank.tasks.some(task => task.split !== "development")
    || digest(options.bank.tasks.map(task => task.id).sort()) !== digest([...new Set(options.spec.schedule.map(item => item.taskId))].sort())) throw new Error("Campaign bank/schedule mismatch");
  const checkObservation = async (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const observed = await options.observe(signal);
    signal?.throwIfAborted();
    if (digest(observed) !== digest(options.spec.bindings)) throw new Error("Frozen campaign observation mismatch");
    return observed;
  };
  const campaign = await openCampaign(options.directory, options.spec);
  const state = await campaign.status();
  if (state.blocked.length) throw new Error(`Campaign blocked: ${state.blocked.join(", ")}`);
  const requestFor = (scheduled: CampaignSpec["schedule"][number]) => ({
    task: options.bank.tasks.find(task => task.id === scheduled.taskId)!, arm: scheduled.arm, repetition: scheduled.repetition,
    cohort: { model: options.spec.bindings.model, thinking: options.spec.bindings.thinking }, timeoutMs: options.spec.limits.workflowMs,
  });
  // One receipt route for settlement and resume. Its identity, task and pricing
  // come from the frozen campaign/journal, never retained producer metadata.
  const receiptFor = (admission: Admission, result: Awaited<ReturnType<typeof runTrial>>, authority: CampaignResultAuthority, auditSignal?: AbortSignal) =>
    deriveCampaignTrialReceipt(options.spec, state.events, join(options.directory, "trials", admission.id),
      requestFor(admission.scheduled), result, authority, auditSignal);
  // Check the declared frozen implementation before running its evidence audit.
  // The final observation below is still required: history auditing may take time.
  if (state.finished > 0) await checkObservation(signal);
  for (const event of state.events) {
    if (event.type !== "finished") continue;
    const start = state.events.find(item => item.type === "started" && item.admission.id === event.id);
    if (start?.type !== "started") throw new Error("Missing admission evidence");
    const directory = join(options.directory, "trials", event.id);
    const retained = await loadTrialResult(directory, event.receipt.resultDigest, signal);
    const receipt = await receiptFor(start.admission, retained, { mode: "retained", expectedResultDigest: event.receipt.resultDigest }, signal);
    if (digest(receipt) !== digest(event.receipt)) throw new Error("Historical trial evidence mismatch");
  }
  const admission = await campaign.admit(await checkObservation(signal), digest(state.events));
  const active = deadline(admission.remainingActiveMs), workflow = deadline(admission.remainingMs);
  const settlementSignal = AbortSignal.any([active.signal, ...(signal ? [signal] : [])]);
  try {
    let result: Awaited<ReturnType<typeof runTrial>> | undefined, receipt: CampaignReceipt, freshLaunch: PreparedLaunch | undefined;
    try {
      const request = await campaign.withAdmissionOrigin(admission.id, async origin => deriveAdmittedTrialInput(origin, options.bank).request);
      // A native authorization campaign must never fall through to the historical
      // local checker, including when the producer fails before emitting identity.
      // This remains a hard stop until owned confined grading/import is available.
      if (request.task.grader === "authorization") requireConfinedGrading();
      result = await runTrial(join(options.directory, "trials"), request, async context => {
        active.check(); workflow.check(); context.signal.throwIfAborted();
        await checkObservation(context.signal);
        active.check(); workflow.check(); context.signal.throwIfAborted();
        await campaign.withAdmissionOrigin(admission.id, async origin => {
          const expected = deriveAdmittedTrialInput(origin, options.bank);
          if (!isDeepStrictEqual({ request: context.request, trialIdentity: context.trialIdentity, retentionRoot: context.retentionRoot,
            artifactDirectory: context.artifactDirectory, cwd: context.cwd }, {
            request: expected.request, trialIdentity: expected.trialIdentity, retentionRoot: expected.retentionRoot,
            artifactDirectory: expected.artifactDirectory, cwd: expected.cwd,
          })) throw new Error("Admitted driver input mismatch");
        });
        active.check(); workflow.check(); context.signal.throwIfAborted();
        let driverActive = true;
        const checkWindow = () => {
          if (!driverActive) throw new Error("Native configuration window closed");
          active.check(); workflow.check(); context.signal.throwIfAborted();
        };
        try {
          return await options.driver({ ...context, prepareNativeLaunch: async launch => {
            checkWindow();
            const prepared = await campaign.prepareLaunch(admission.id, async origin => {
              checkWindow();
              const result = await prepareAdmittedNativeLaunch(origin, options.bank, launch);
              checkWindow();
              return result;
            });
            // prepareLaunch has durably appended and released its lock. A failed
            // append/deadline never returns environment to the spawning driver.
            checkWindow();
            freshLaunch = prepared.launch;
            return prepared.environment;
          } });
        } finally { driverActive = false; }
      }, signal, { id: admission.id, retentionRoot: options.directory, workflowSignal: workflow.signal, activeSignal: active.signal,
        ...(options.spec.version === 2 && options.spec.nativePolicy.version === 3 ? { finalization: "confined-required" as const } : {}) });
      workflow.dispose();
      active.check();
      await checkObservation(settlementSignal);
      receipt = await receiptFor(admission, result, { mode: "fresh", expectedResultDigest: digest(JSON.parse(JSON.stringify(result))),
        preparedLaunch: freshLaunch }, settlementSignal);
      active.check(); settlementSignal.throwIfAborted();
    } catch {
      // Do not echo arbitrary exception text (which may contain credential data).
      // Retain any partial trial files and bind even a pre-result failure to the admission.
      const failure = { version: 1, id: admission.id, status: "unverified_trial", trialResultDigest: result ? digest(JSON.parse(JSON.stringify(result))) : null };
      await writeFile(join(options.directory, `failure-${admission.id}.json`), JSON.stringify(failure) + "\n", { flag: "wx", mode: 0o600 });
      receipt = { resultDigest: digest(failure), outcome: "failed", estimatedUsd: null, integrity: "failed" };
    }
    await campaign.finish(admission.id, receipt);
    return { admissionId: admission.id, result, receipt };
  } finally { workflow.dispose(); active.dispose(); }
}
