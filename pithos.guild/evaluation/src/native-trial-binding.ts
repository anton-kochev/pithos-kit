// Expected input correlation only. No launch, credential access or provenance
// observation; callers must still obtain admission from the disabled ledger.
import { isDeepStrictEqual as same } from "node:util";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { digest, validateBank, type TaskBank } from "./manifest.ts";
import { validateCampaignSpec, readCampaignAdmissionOrigin, type CampaignAdmissionOrigin, type CampaignSpec, type Admission } from "./campaign.ts";
import type { TrialRequest, TrialIdentity } from "./runner.ts";

export interface NativeTrialInput {
  spec: CampaignSpec; bank: TaskBank; admission: Admission;
  trialIdentity: TrialIdentity; request: TrialRequest;
  retentionRoot: string; artifactDirectory: string; cwd: string;
}
// Parent-only: the returned input includes the private bank. Never serialize it
// to a producer. Inert V1 derivation is testable; native binding still requires V2.
export function deriveAdmittedTrialInput(origin: CampaignAdmissionOrigin, rawBank: TaskBank): NativeTrialInput {
  try {
    const { spec, admission, directory } = readCampaignAdmissionOrigin(origin), bank = validateBank(rawBank);
    check(digest(bank) === spec.bindings.bankDigest && bank.tasks.every(t => t.split === "development")
      && same(bank.tasks.map(t => t.id).sort(), [...new Set(spec.schedule.map(s => s.taskId))].sort()));
    const request = { task: bank.tasks.find(t => t.id === admission.scheduled.taskId)!, arm: admission.scheduled.arm,
      repetition: admission.scheduled.repetition, cohort: { model: spec.bindings.model, thinking: spec.bindings.thinking }, timeoutMs: spec.limits.workflowMs };
    const artifactDirectory = join(directory, "trials", admission.id);
    const input = { spec, bank, admission, request, trialIdentity: { version: 1 as const, id: admission.id, requestDigest: digest(request) },
      retentionRoot: directory, artifactDirectory, cwd: join(artifactDirectory, "repo") };
    const freeze = (value: any): void => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } };
    freeze(input);
    readCampaignAdmissionOrigin(origin); // Do not return a derivation that consumed the remaining allowance.
    return input;
  } catch { throw new Error("Admitted trial input mismatch"); }
}
function check(value: unknown): asserts value { if (!value) throw Error(); }
function exact(value: any, keys: string[]) {
  check(value && typeof value === "object" && !Array.isArray(value) && same(Object.keys(value).sort(), keys.sort()));
}
function canonicalPath(value: string) {
  check(typeof value === "string" && Buffer.byteLength(value) <= 4096 && !value.includes("\u0000") && isAbsolute(value) && resolve(value) === value && value !== "/");
}
export interface ParentInvocation { version: 1; trialIdentity: TrialIdentity; command: string; args: string[]; cwd: string }
export function bindNativeParentInvocation(input: NativeTrialInput, guildRoot: string, actual: ParentInvocation) {
  try {
    const trial = bindNativeTrial(input);
    canonicalPath(guildRoot);
    const guild = input.request.arm === "guild-available";
    const args = ["--import", pathToFileURL(join(guildRoot, "evaluation/src/child-observer.ts")).href,
      "/opt/pi-npm/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js", "--mode", "json", "-p", "--no-session", "--no-extensions",
      "--no-skills", "--no-prompt-templates", "--no-context-files", "--approve",
      ...(guild ? ["--extension", join(guildRoot, "extensions/index.ts")] : []),
      "--tools", `read,write,edit,bash,grep,find,ls${guild ? ",guild_handover" : ""}`,
      "--model", input.spec.bindings.model, "--thinking", input.spec.bindings.thinking, "--", input.request.task.prompt];
    check(same(actual, { version: 1, trialIdentity: input.trialIdentity, command: "/usr/bin/node", args, cwd: input.cwd }));
    return Object.freeze({ version: 1 as const, kind: "native-parent-invocation-input-binding" as const, trialId: trial.trialId,
      trialBindingDigest: digest(trial), invocationDigest: digest(actual) });
  } catch { throw new Error("Native parent invocation mismatch"); }
}
export function bindNativeTrial(input: NativeTrialInput) {
  try {
    exact(input, ["spec", "bank", "admission", "trialIdentity", "request", "retentionRoot", "artifactDirectory", "cwd"]);
    const spec = validateCampaignSpec(input.spec), bank = validateBank(input.bank), admission = input.admission;
    check(spec.version === 2 && digest(bank) === spec.bindings.bankDigest && bank.tasks.every(t => t.split === "development")
      && same(bank.tasks.map(t => t.id).sort(), [...new Set(spec.schedule.map(s => s.taskId))].sort()));
    exact(admission, ["id", "slot", "scheduled", "allowanceMs", "activeAllowanceMs"]);
    check(typeof admission.id === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(admission.id)
      && Number.isSafeInteger(admission.slot) && admission.slot >= 0 && admission.slot < spec.limits.maxTrials
      && same(admission.scheduled, spec.schedule[admission.slot])
      && Number.isSafeInteger(admission.activeAllowanceMs) && admission.activeAllowanceMs > 0 && admission.activeAllowanceMs <= spec.limits.activeMs
      && admission.allowanceMs === Math.min(spec.limits.workflowMs, admission.activeAllowanceMs));
    [input.retentionRoot, input.artifactDirectory, input.cwd].forEach(canonicalPath);
    check(input.artifactDirectory === join(input.retentionRoot, "trials", admission.id) && input.cwd === join(input.artifactDirectory, "repo"));
    check(same(input.request, { task: bank.tasks.find(t => t.id === admission.scheduled.taskId), arm: admission.scheduled.arm,
      repetition: admission.scheduled.repetition, cohort: { model: spec.bindings.model, thinking: spec.bindings.thinking }, timeoutMs: spec.limits.workflowMs }));
    const requestDigest = digest(input.request);
    exact(input.trialIdentity, ["version", "id", "requestDigest"]);
    check(input.trialIdentity.version === 1 && input.trialIdentity.id === admission.id && input.trialIdentity.requestDigest === requestDigest);
    return Object.freeze({ version: 1 as const, kind: "native-trial-input-binding" as const, trialId: admission.id,
      campaignDigest: digest(spec), admissionDigest: digest(admission), requestDigest,
      locationDigest: digest({ retentionRoot: input.retentionRoot, artifactDirectory: input.artifactDirectory, cwd: input.cwd }) });
  } catch { throw new Error("Native trial binding mismatch"); }
}
