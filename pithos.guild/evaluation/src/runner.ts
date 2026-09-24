import { randomUUID } from "node:crypto";
import type { prepareAdmittedNativeLaunch } from "./admitted-native-launch.ts";
import { appendFileSync } from "node:fs";
import { mkdir, writeFile, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createFixture, snapshot } from "./fixture.ts";
import { gradeOutcome } from "./grading.ts";
import { finalizeOwnedTrial, type Finalization, type FinalizationOrigin } from './trial-finalization.ts';
import { digest, validateBank, type EvalTask, type TaskBank } from "./manifest.ts";
import { analyzeTrace } from "./trace.ts";
import { MAX_CHILD_TRACE_BYTES } from "./limits.ts";

export type Arm = "main-only" | "guild-available";
export interface TrialRequest {
  task: EvalTask;
  arm: Arm;
  repetition: number;
  cohort: { model: string; thinking: string };
  timeoutMs: number;
}
export interface TrialIdentity { readonly version: 1; readonly id: string; readonly requestDigest: string }
export interface DriverContext {
  // Bridge-supplied, parent-only configuration callback; absent on direct trials.
  prepareNativeLaunch?: (options: Parameters<typeof prepareAdmittedNativeLaunch>[2]) => Promise<Awaited<ReturnType<typeof prepareAdmittedNativeLaunch>>["environment"]>;
  trialIdentity: TrialIdentity;
  cwd: string;
  artifactDirectory: string;
  retentionRoot?: string;
  request: TrialRequest;
  signal: AbortSignal;
  emit: (jsonl: string) => void;
  stderr: (text: string) => void;
}
export interface SupervisorSpawnObservation {
  readonly version: 1;
  readonly kind: "guild-eval-supervisor-spawn";
  readonly trialIdentity: TrialIdentity;
  readonly invocationDigest: string;
  readonly configurationSha256: string | null;
  readonly supervisorPid: number;
  readonly parentPid: number;
}
export interface DriverResult { exitCode: number; supervisor?: SupervisorSpawnObservation }
// A driver must settle only after its process AND descendants have stopped.
export type Driver = (context: DriverContext) => Promise<DriverResult>;

export function createSchedule(bank: TaskBank, repetitions: number, seed: string) {
  validateBank(bank);
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5 || !seed.trim()) throw new Error("Invalid schedule settings");
  const pairs = bank.tasks.flatMap(task => Array.from({ length: repetitions }, (_, i) => ({ taskId: task.id, repetition: i + 1 })));
  // Hash-sort randomization is versioned by this implementation; seed is always recorded.
  pairs.sort((a, b) => digest([seed, a]).localeCompare(digest([seed, b])));
  return pairs.flatMap(pair => {
    const arms: Arm[] = parseInt(digest([seed, pair, "arm"]).slice(0, 2), 16) % 2 ? ["main-only", "guild-available"] : ["guild-available", "main-only"];
    return arms.map(arm => ({ ...pair, arm }));
  });
}

export interface TrialControls {
  id?: string; retentionRoot?: string; workflowSignal?: AbortSignal; activeSignal?: AbortSignal;
  // Supervisor-selected requirement, never taken from DriverResult or producer files.
  finalization?: "confined-required";
  finalizationOrigin?: FinalizationOrigin;
}

export async function runTrial(storage: string, rawRequest: TrialRequest, driver?: Driver, signal?: AbortSignal, controls: TrialControls = {}) {
  if (!driver) throw new Error("A driver must be explicitly supplied; no default live execution");
  const confined = controls.finalization === "confined-required" || controls.finalizationOrigin !== undefined;
  let finalization: Finalization | undefined = confined ? { version: 1 as const, state: "pending" as const,
    reason: "confined-snapshot-evidence-required" as const } : undefined;
  const request = structuredClone(rawRequest);
  validateBank({ version: 1, tasks: [request.task] });
  if (!["main-only", "guild-available"].includes(request.arm)
    || !Number.isInteger(request.repetition) || request.repetition < 1
    || !Number.isInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 3600000
    || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(request.cohort.model)
    || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(request.cohort.thinking)) throw new Error("Invalid trial request");
  const id = controls.id ?? randomUUID();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new Error("Invalid trial ID");
  await mkdir(storage, { recursive: true, mode: 0o700 });
  const directory = join(storage, id);
  await mkdir(directory, { mode: 0o700 });
  const save = (name: string, value: unknown) => writeFile(join(directory, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  const trialIdentity: TrialIdentity = Object.freeze({ version: 1, id, requestDigest: digest(request) });
  const startedAt = new Date().toISOString(), start = performance.now();
  const { rubric: _rubric, grader: _grader, delegation: _delegation, ...publicTask } = request.task;
  await save("request.json", { version: 1, id, request: { ...request, task: publicTask }, requestDigest: digest(request), node: process.version, platform: process.platform, startedAt });
  await writeFile(join(directory, "parent.jsonl"), "", { flag: "wx", mode: 0o600 });
  await writeFile(join(directory, "stderr.txt"), "", { flag: "wx", mode: 0o600 });
  const controller = new AbortController();
  let reason: "timeout" | "campaign_timeout" | "cancelled" | "output_limit" | undefined;
  const cancel = () => { reason ??= "cancelled"; controller.abort(); };
  const workflowTimeout = () => { reason ??= "timeout"; controller.abort(); };
  const campaignTimeout = () => { reason ??= "campaign_timeout"; controller.abort(); };
  signal?.addEventListener("abort", cancel, { once: true });
  controls.workflowSignal?.addEventListener("abort", workflowTimeout, { once: true });
  controls.activeSignal?.addEventListener("abort", campaignTimeout, { once: true });
  if (signal?.aborted) cancel();
  if (controls.workflowSignal?.aborted) workflowTimeout();
  if (controls.activeSignal?.aborted) campaignTimeout();
  const gradingSignal = AbortSignal.any([signal, controls.activeSignal].filter((value): value is AbortSignal => value !== undefined));
  const timer = setTimeout(workflowTimeout, request.timeoutMs);
  let raw = "", rawBytes = 0, stderrBytes = 0;
  let grade: Awaited<ReturnType<typeof gradeOutcome>> | undefined;
  let status: string = "setup_error", error: string | undefined, exitCode: number | undefined;
  let supervisor: SupervisorSpawnObservation | null = null;
  let workflowElapsedMs: number | undefined, baselineDigest: string | null = null;
  try {
    const cwd = join(directory, "repo");
    await createFixture(cwd, request.task.fixture, controller.signal);
    const baseline = await snapshot(cwd, controller.signal);
    baselineDigest = digest(baseline);
    await save("baseline.json", baseline);
    if (!controller.signal.aborted) {
      status = "driver_error";
      try {
        const result = await driver({
          trialIdentity, cwd, artifactDirectory: directory, retentionRoot: controls.retentionRoot ?? storage, request: structuredClone(request), signal: controller.signal,
          emit: chunk => {
            rawBytes += Buffer.byteLength(chunk);
            if (rawBytes > 16 * 1024 * 1024) { reason ??= "output_limit"; controller.abort(); return; }
            appendFileSync(join(directory, "parent.jsonl"), chunk); raw += chunk;
          },
          stderr: chunk => {
            stderrBytes += Buffer.byteLength(chunk);
            if (stderrBytes > 1024 * 1024) { reason ??= "output_limit"; controller.abort(); return; }
            appendFileSync(join(directory, "stderr.txt"), chunk);
          },
        });
        exitCode = result.exitCode;
        if (result.supervisor) {
          const observed = structuredClone(result.supervisor);
          const hashes = [observed.invocationDigest, observed.configurationSha256];
          if (Object.keys(observed).sort().join(",") !== "configurationSha256,invocationDigest,kind,parentPid,supervisorPid,trialIdentity,version"
            || observed.version !== 1 || observed.kind !== "guild-eval-supervisor-spawn"
            || digest(observed.trialIdentity) !== digest(trialIdentity)
            || !hashes.every(value => value === null || (typeof value === "string" && /^[a-f0-9]{64}$/.test(value)))
            || typeof observed.invocationDigest !== "string" || !Number.isSafeInteger(observed.supervisorPid) || observed.supervisorPid < 2
            || !Number.isSafeInteger(observed.parentPid) || observed.parentPid < 2 || observed.parentPid === observed.supervisorPid) throw new Error("Driver supervisor observation mismatch");
          supervisor = observed;
        }
        status = exitCode === 0 ? "recorded" : "process_error";
      } catch (e) { error = String(e); }
    }
    workflowElapsedMs = performance.now() - start;
    status = reason ?? status;
    clearTimeout(timer); // The workflow deadline excludes trusted grading.
    controls.workflowSignal?.removeEventListener("abort", workflowTimeout);
    if (confined) {
      // Authority stays in supervisor controls, never DriverContext/DriverResult.
      // Invalid or missing origins cannot fall back to the historical checker.
      if (controls.finalizationOrigin !== undefined) {
        try {
          const owned = await finalizeOwnedTrial(controls.finalizationOrigin, directory,
            { trialId: id, requestDigest: digest(request), baselineDigest }, request.task, baseline, controller.signal);
          finalization = owned.finalization; grade = owned.grade;
        } catch (e) { error ??= String(e); }
      }
      if (status === "recorded" && finalization?.state !== 'completed') status = "finalization_pending";
    } else {
      try { grade = await gradeOutcome(request.task, cwd, baseline, gradingSignal); }
      catch (e) { status = reason ?? "grader_error"; error = String(e); }
    }
  } catch (e) { error = String(e); status = reason ?? status; }
  finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    controls.workflowSignal?.removeEventListener("abort", workflowTimeout);
    controls.activeSignal?.removeEventListener("abort", campaignTimeout);
  }
  let childRaw: string | undefined, childTraceDigest: string | null = null;
  try {
    const file = join(directory, "children.jsonl"), info = await lstat(file);
    if (!info.isFile() || info.size > MAX_CHILD_TRACE_BYTES) throw new Error("Child observation is not a bounded regular file");
    childRaw = await readFile(file, "utf8");
    childTraceDigest = digest(childRaw);
  }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      childRaw = ""; error = String(e); status = reason ?? "observation_error";
    }
  }
  const trace = analyzeTrace(raw, childRaw);
  if (status === "recorded") {
    if (trace.models.some(m => m !== request.cohort.model)) status = "model_mismatch";
    else if (trace.issues.includes("provider_error") || trace.issues.includes("child_provider_error")) status = "provider_error";
    else if (childRaw !== undefined && !trace.complete) status = "incomplete_trace";
    else if (trace.issues.some(issue => ["missing_agent_end", "malformed_json", "malformed_event", "missing_final_text", "missing_terminal_stop", "duplicate_parent_message", "duplicate_tool_completion", "unfinished_handover"].includes(issue))) status = "incomplete_trace";
  }
  // Confined termination is still unknown; do not release private grading data
  // into a directory that a producer could still have mounted.
  if (!confined) await save("task-manifest.json", request.task);
  status = controls.activeSignal?.aborted ? "campaign_timeout" : reason ?? (signal?.aborted ? "cancelled" : status);
  const result = { version: 1, id, interruption: reason ?? null, campaignDeadlineExceeded: controls.activeSignal?.aborted ?? false, taskId: request.task.id, split: request.task.split, arm: request.arm, repetition: request.repetition, cohort: request.cohort,
    status, error, exitCode, startedAt, workflowElapsedMs, elapsedMs: performance.now() - start,
    requestDigest: digest(request), baselineDigest, supervisor, traceDigest: digest(raw), childTraceDigest, trace, grade,
    ...(finalization ? { finalization } : {}) };
  await save("result.json", result);
  // request/baseline/raw/final state are never deleted or reused by this harness.
  return result;
}
