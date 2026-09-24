import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createStore, transaction } from "./campaign-store.ts";
import type { Arm } from "./runner.ts";
import { digest } from "./manifest.ts";
import { validateBasePricing, type BasePricing } from "./pricing.ts";
import { CANDIDATE_NATIVE_POLICY_V3, NATIVE_POLICY_V1, validateNativePolicy, type NativePolicy } from "./native-policy.ts";

interface CampaignFields {
  bindings: {
    bankDigest: string; scheduleDigest: string; implementationDigest: string; runtimeDigest: string; policyDigest: string;
    model: string; thinking: string;
  };
  schedule: { taskId: string; arm: Arm; repetition: number }[];
  limits: { maxTrials: number; estimatedUsd: number; activeMs: number; workflowMs: number };
}
// V1 remains the historical/inert contract; it is not a native attestation.
// V2 cannot omit native policy or pricing and silently become a V1 campaign.
export type CampaignSpec = CampaignFields & (
  { version: 1; pricing?: BasePricing }
  | { version: 2; pricing: BasePricing; nativePolicy: NativePolicy }
);

function check(ok: unknown, message = "invalid record"): asserts ok {
  if (!ok) throw new Error(`Invalid campaign: ${message}`);
}
function exact(value: any, keys: string[]) {
  check(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), "unknown or missing fields");
}
const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const integer = (value: unknown, max: number) => Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= max;
export function validateCampaignSpec(raw: CampaignSpec): CampaignSpec {
  exact(raw, ["version", "bindings", "schedule", "limits", ...(raw?.version === 2 ? ["pricing", "nativePolicy"] : raw && Object.hasOwn(raw, "pricing") ? ["pricing"] : [])]);
  check(raw.version === 1 || raw.version === 2, "unsupported version");
  const { bindings: b, limits: l, schedule } = raw;
  exact(b, ["bankDigest", "scheduleDigest", "implementationDigest", "runtimeDigest", "policyDigest", "model", "thinking"]);
  check([b.bankDigest, b.scheduleDigest, b.implementationDigest, b.runtimeDigest, b.policyDigest].every(hash), "invalid digest");
  check(typeof b.model === "string" && /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(b.model), "invalid model");
  check(["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(b.thinking), "invalid thinking");
  if (Object.hasOwn(raw, "pricing")) {
    try { check(validateBasePricing(raw.pricing).model === b.model, "pricing model mismatch"); }
    catch { check(false, "invalid pricing or pricing model mismatch"); }
  }
  if (raw.version === 2) {
    try {
      const policy = validateNativePolicy(raw.nativePolicy);
      check(b.model === policy.model && b.thinking === policy.thinking && raw.pricing.api === policy.api, "native cohort mismatch");
    } catch { check(false, "invalid native policy or cohort"); }
  }
  check(Array.isArray(schedule) && schedule.length >= 2 && schedule.length <= 12 && schedule.length % 2 === 0, "invalid smoke schedule");
  const seen = new Set<string>();
  for (let i = 0; i < schedule.length; i += 2) {
    const [a, z] = schedule.slice(i, i + 2);
    for (const item of [a, z]) {
      exact(item, ["taskId", "arm", "repetition"]);
      check(typeof item.taskId === "string" && /^[a-z][a-z0-9-]{0,79}$/.test(item.taskId)
        && ["main-only", "guild-available"].includes(item.arm) && item.repetition === 1, "invalid scheduled trial");
    }
    check(a.taskId === z.taskId && a.arm !== z.arm && !seen.has(a.taskId), "expected unique adjacent pairs");
    seen.add(a.taskId);
  }
  check(b.scheduleDigest === digest(schedule), "schedule digest mismatch");
  exact(l, ["maxTrials", "estimatedUsd", "activeMs", "workflowMs"]);
  check(integer(l.maxTrials, schedule.length) && integer(l.activeMs, 3600000) && integer(l.workflowMs, 300000)
    && typeof l.estimatedUsd === "number" && Number.isFinite(l.estimatedUsd) && l.estimatedUsd > 0 && l.estimatedUsd <= 10, "invalid smoke limits");
  return structuredClone(raw);
}

export interface NativeReceiptAudit {
  version: 2;
  evidence: "candidate-native-v2";
  policyDigest: string;
  campaignDigest: string;
  admissionDigest: string;
  trialIdentityDigest: string;
  launchDigest: string;
  supervisorDigest: string;
  bindingDigest: string;
  requirementDigest: string;
  runtimeAuditDigest: string;
  baselineDigest: string;
  finalSnapshotDigest: string;
  files: { path: string; bytes: number; sha256: string }[];
  inventoryDigest: string;
}
export interface CampaignReceipt {
  resultDigest: string;
  outcome: "recorded" | "failed";
  estimatedUsd: number | null;
  integrity: "ok" | "failed";
  nativeAudit?: NativeReceiptAudit;
}
function validateReceipt(receipt: CampaignReceipt) {
  exact(receipt, ["resultDigest", "outcome", "estimatedUsd", "integrity", ...(receipt.nativeAudit ? ["nativeAudit"] : [])]);
  check(hash(receipt.resultDigest) && ["recorded", "failed"].includes(receipt.outcome)
    && ["ok", "failed"].includes(receipt.integrity)
    && (receipt.estimatedUsd === null || (typeof receipt.estimatedUsd === "number" && Number.isFinite(receipt.estimatedUsd) && receipt.estimatedUsd >= 0)), "invalid settlement");
  if (receipt.nativeAudit) {
    const audit = receipt.nativeAudit;
    exact(audit, ["version", "evidence", "policyDigest", "campaignDigest", "admissionDigest", "trialIdentityDigest", "launchDigest", "supervisorDigest", "bindingDigest",
      "requirementDigest", "runtimeAuditDigest", "baselineDigest", "finalSnapshotDigest", "files", "inventoryDigest"]);
    check(audit.version === 2 && audit.evidence === "candidate-native-v2"
      && [audit.policyDigest, audit.campaignDigest, audit.admissionDigest, audit.trialIdentityDigest, audit.launchDigest, audit.supervisorDigest, audit.bindingDigest,
        audit.requirementDigest, audit.runtimeAuditDigest, audit.baselineDigest, audit.finalSnapshotDigest, audit.inventoryDigest].every(hash)
      && Array.isArray(audit.files) && audit.files.length >= 10 && audit.files.length <= (audit.policyDigest === digest(CANDIDATE_NATIVE_POLICY_V3) ? 74 : 73), "invalid native audit");
    let prior = "", total = 0;
    for (const file of audit.files) {
      exact(file, ["path", "bytes", "sha256"]);
      check(typeof file.path === "string" && ((audit.policyDigest === digest(CANDIDATE_NATIVE_POLICY_V3) && file.path === 'finalization.json') || /^(baseline\.json|children\.jsonl|invocation\.json|native-config\.json|native\/[1-9][0-9]{0,9}\.jsonl|parent\.jsonl|request\.json|result\.json|runtime-requirement\.json|supervisor\.json)$/.test(file.path))
        && file.path > prior && Number.isSafeInteger(file.bytes) && file.bytes >= 0 && file.bytes <= 64 * 1024 * 1024 && hash(file.sha256), "invalid native inventory");
      prior = file.path; total += file.bytes;
    }
    check(total <= 256 * 1024 * 1024 && audit.inventoryDigest === digest(audit.files), "invalid native inventory");
  }
}
export type Admission = { id: string; slot: number; scheduled: CampaignSpec["schedule"][number]; allowanceMs: number; activeAllowanceMs: number };
declare const originBrand: unique symbol;
export type CampaignAdmissionOrigin = { readonly [originBrand]: true };
const origins = new WeakMap<CampaignAdmissionOrigin, { snapshot: { directory: string; spec: CampaignSpec; admission: Admission; historyDigest: string }; fresh: () => void }>();
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export function readCampaignAdmissionOrigin(origin: CampaignAdmissionOrigin) {
  const record = origins.get(origin);
  if (!record) throw new Error("Campaign admission origin mismatch");
  record.fresh();
  return record.snapshot;
}
export interface PreparedLaunch {
  version: 1; historyDigest: string; configurationSha256: string; runtimeRequirementSha256: string;
  invocationDigest: string; scopedAuthIdentityDigest: string; implementationDigest: string; supervisorPid: number;
}
function validatePreparedLaunch(launch: PreparedLaunch, spec: CampaignSpec, historyDigest: string) {
  const hashes = ["historyDigest", "configurationSha256", "runtimeRequirementSha256", "invocationDigest", "scopedAuthIdentityDigest", "implementationDigest"] as const;
  exact(launch, ["version", ...hashes, "supervisorPid"]);
  check(launch.version === 1 && hashes.every(key => hash(launch[key])) && launch.historyDigest === historyDigest
    && launch.implementationDigest === spec.bindings.implementationDigest
    && integer(launch.supervisorPid, 2147483647) && launch.supervisorPid > 1, "invalid prepared launch");
}
type Event = { type: "started"; admission: Admission }
  | { type: "launch_prepared"; id: string; launch: PreparedLaunch }
  | { type: "finished"; id: string; receipt: CampaignReceipt; elapsedMs: number }
  | { type: "first_pair_inspected"; receiptDigest: string };

// This contract is inspectable before its execution binding is implemented.
// Keep both direct admission and the bridge fail-closed in the meantime.
export function assertCampaignExecutionAvailable(spec: CampaignSpec) {
  if (spec.version === 2 || spec.bindings.model === NATIVE_POLICY_V1.model) throw new Error("Native campaign admission is disabled pending launch and receipt binding");
}

export async function createCampaign(directory: string, spec: CampaignSpec) {
  spec = validateCampaignSpec(spec);
  if (spec.version === 1 && spec.bindings.model === NATIVE_POLICY_V1.model) throw new Error("Native cohort requires campaign version 2");
  await createStore(directory, spec);
  return openCampaign(directory, spec);
}
// Pure journal semantics, not retained-evidence validation or permission to run.
// The operational open/admit/origin gates remain separate and closed for native.
export function replayCampaignJournal(spec: CampaignSpec, events: Event[], elapsedForPending?: (id: string) => number | undefined) {
  spec = validateCampaignSpec(spec);
  const replay = (events: Event[]) => {
    let preparedLaunch: PreparedLaunch | undefined;
    let started = 0, finished = 0, estimatedUsd: number | null = 0, pending: Admission | undefined;
    let firstPairInspected = false, integrityFailure = false, settledActiveMs = 0;
    const reasons = (activeMs: number | null, cost: number | null) => {
      const blocked: string[] = [];
      if (pending) blocked.push("pending_attempt");
      if (activeMs === null) blocked.push("unknown_active_time");
      else if (activeMs >= spec.limits.activeMs) blocked.push("active_time_limit");
      if (cost === null) blocked.push("unknown_spend");
      // A one-nanodollar conservative margin avoids decimal sums just under the cap.
      else if (cost + 1e-9 >= spec.limits.estimatedUsd) blocked.push("spend_limit");
      if (started >= spec.limits.maxTrials) blocked.push("trial_limit");
      if (integrityFailure) blocked.push("integrity_failure");
      if (finished >= 2 && !firstPairInspected) blocked.push("first_pair_inspection");
      return blocked;
    };
    const ids = new Set<string>();
    for (const [index, event] of events.entries()) {
      check(event && typeof event === "object" && typeof event.type === "string", "invalid journal event");
      if (event.type === "started") {
        exact(event, ["type", "admission"]);
        const a = event.admission;
        exact(a, ["id", "slot", "scheduled", "allowanceMs", "activeAllowanceMs"]);
        check(reasons(settledActiveMs, estimatedUsd).length === 0 && a.slot === started
          && typeof a.id === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(a.id) && !ids.has(a.id)
          && digest(a.scheduled) === digest(spec.schedule[started])
          && a.activeAllowanceMs === spec.limits.activeMs - settledActiveMs
          && a.allowanceMs === Math.min(spec.limits.workflowMs, a.activeAllowanceMs), "invalid admission history");
        ids.add(a.id); started++; pending = a;
      } else if (event.type === "launch_prepared") {
        exact(event, ["type", "id", "launch"]);
        check(spec.version === 2 && pending?.id === event.id && !preparedLaunch, "invalid prepared launch");
        validatePreparedLaunch(event.launch, spec, digest(events.slice(0, index)));
        preparedLaunch = event.launch;
      } else if (event.type === "first_pair_inspected") {
        exact(event, ["type", "receiptDigest"]);
        check(hash(event.receiptDigest) && !firstPairInspected && finished === 2
          && reasons(settledActiveMs, estimatedUsd).every(reason => reason === "first_pair_inspection"), "invalid inspection history");
        firstPairInspected = true;
      } else if (event.type === "finished") {
        // Native settlement remains unavailable until the mandatory receipt audit
        // is implemented. A prepared record alone cannot certify execution.
        if (spec.version === 2) throw new Error("Native trial evidence contract is required");
        exact(event, ["type", "id", "receipt", "elapsedMs"]);
        validateReceipt(event.receipt);
        check(!event.receipt.nativeAudit, "candidate native receipt is not accepted by the ledger");
        check(pending?.id === event.id && Number.isSafeInteger(event.elapsedMs) && event.elapsedMs >= 0, "invalid settlement history");
        finished++; pending = undefined;
        settledActiveMs += event.elapsedMs;
        check(Number.isSafeInteger(settledActiveMs), "invalid accumulated time");
        estimatedUsd = estimatedUsd === null || event.receipt.estimatedUsd === null ? null : estimatedUsd + event.receipt.estimatedUsd;
        integrityFailure ||= event.receipt.integrity === "failed";
      } else check(false, "unknown journal event");
    }
    const pendingElapsed = pending ? elapsedForPending?.(pending.id) : undefined;
    const activeMs = pending ? (pendingElapsed !== undefined ? settledActiveMs + pendingElapsed : null) : settledActiveMs;
    if (pending) estimatedUsd = null;
    return { started, finished, estimatedUsd, activeMs, pending, preparedLaunch, events, blocked: reasons(activeMs, estimatedUsd), firstPairInspected };
  };
  return replay(events);
}

export async function openCampaign(directory: string, spec: CampaignSpec) {
  spec = validateCampaignSpec(spec);
  const owned = new Map<string, number>();
  const elapsed = (id: string) => {
    const start = owned.get(id);
    if (start === undefined) throw new Error("Only the admitting handle can settle an attempt; interrupted usage/time remain unknown");
    const value = performance.now() - start;
    check(Number.isFinite(value) && value >= 0, "invalid monotonic clock");
    return Math.ceil(value);
  };
  const replay = (events: Event[]) => {
    check(spec.version !== 2 || events.length === 0, "native execution history is not supported before launch and receipt binding");
    return replayCampaignJournal(spec, events, id => owned.has(id) ? elapsed(id) : undefined);
  };
  const transact = <T>(visit: (state: ReturnType<typeof replay>, append: (event: Event) => Promise<void>) => Promise<T>) =>
    transaction(directory, spec, (events, append) => visit(replay(events as Event[]), append));
  await transact(async () => undefined);
  const visitOrigin = async <T>(id: string, visit: (origin: CampaignAdmissionOrigin) => Promise<T>,
    commit?: (result: T, state: ReturnType<typeof replay>, append: (event: Event) => Promise<void>) => Promise<void>): Promise<T> => {
      assertCampaignExecutionAvailable(spec);
      return transact(async (state, append) => {
        if (commit) check(!state.preparedLaunch, "launch already prepared");
        const fresh = () => {
          if (!owned.has(id) || state.pending?.id !== id || elapsed(id) >= state.pending.allowanceMs
            || state.activeMs === null || state.activeMs >= spec.limits.activeMs) throw new Error("Campaign admission origin mismatch");
        };
        fresh();
        const origin = Object.freeze({}) as CampaignAdmissionOrigin;
        origins.set(origin, { fresh, snapshot: freeze(structuredClone({ directory, spec, admission: state.pending!, historyDigest: digest(state.events) })) });
        try {
          const result = await visit(origin); fresh();
          if (commit) { await commit(result, state, append); fresh(); }
          return result;
        } finally { origins.delete(origin); }
      });
  };
  return {
    status: () => transact(async state => state),
    // Read-only origin scope. Do not expose the internal commit callback or nest transactions.
    withAdmissionOrigin: <T>(id: string, visit: (origin: CampaignAdmissionOrigin) => Promise<T>) => visitOrigin(id, visit),
    // Native remains operationally disabled. Once enabled by a separate reviewed
    // gate, commitment and origin lifetime share this one short transaction.
    prepareLaunch: async <T extends { launch: PreparedLaunch }>(id: string, visit: (origin: CampaignAdmissionOrigin) => Promise<T>): Promise<T> => {
      if (spec.version !== 2) throw new Error("Native admitted launch mismatch");
      return visitOrigin(id, async origin => freeze(structuredClone(await visit(origin))), async (result, state, append) => {
        validatePreparedLaunch(result.launch, spec, digest(state.events));
        await append({ type: "launch_prepared", id, launch: result.launch });
      });
    },
    inspectFirstPair: async (receiptDigest: string) => {
      assertCampaignExecutionAvailable(spec);
      check(hash(receiptDigest), "invalid inspection digest");
      await transact(async (state, append) => {
        if (state.firstPairInspected) throw new Error("First pair already inspected");
        if (state.finished !== 2 || state.blocked.some(reason => reason !== "first_pair_inspection")) throw new Error("Cannot inspect first pair before clean settlement");
        await append({ type: "first_pair_inspected", receiptDigest });
      });
    },
    admit: async (observed: CampaignSpec["bindings"], auditedHistoryDigest?: string) => {
      assertCampaignExecutionAvailable(spec);
      const start = performance.now();
      if (digest(observed) !== digest(spec.bindings)) throw new Error("Frozen campaign mismatch");
      return transact(async (state, append) => {
        if (auditedHistoryDigest !== undefined && digest(state.events) !== auditedHistoryDigest) throw new Error("Campaign history changed after evidence audit");
        if (state.blocked.length) throw new Error(`Campaign blocked: ${state.blocked.join(", ")}`);
        const activeAllowanceMs = spec.limits.activeMs - state.activeMs!;
        const admission = { id: randomUUID(), slot: state.started, scheduled: spec.schedule[state.started], allowanceMs: Math.min(spec.limits.workflowMs, activeAllowanceMs), activeAllowanceMs };
        await append({ type: "started", admission });
        owned.set(admission.id, start);
        const remaining = (allowance: number) => owned.has(admission.id) ? Math.max(0, allowance - elapsed(admission.id)) : 0;
        return { ...structuredClone(admission), remainingMs: () => remaining(admission.allowanceMs), remainingActiveMs: () => remaining(admission.activeAllowanceMs) };
      });
    },
    finish: async (id: string, receipt: CampaignReceipt) => {
      assertCampaignExecutionAvailable(spec);
      validateReceipt(receipt);
      receipt = structuredClone(receipt);
      await transact(async (state, append) => {
        if (state.pending?.id !== id) throw new Error("Attempt is not pending or was already settled");
        await append({ type: "finished", id, receipt, elapsedMs: elapsed(id) });
        owned.delete(id);
      });
    },
  };
}
