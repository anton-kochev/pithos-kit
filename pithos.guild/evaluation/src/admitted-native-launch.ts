// Parent-only configuration preparation, not execution permission. Native V2
// origins remain unavailable. Never import this into a producer or serialize bank.
import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { digest, type TaskBank } from "./manifest.ts";
import { readCampaignAdmissionOrigin, type CampaignAdmissionOrigin, type PreparedLaunch } from "./campaign.ts";
import { deriveAdmittedTrialInput, bindNativeTrial, bindNativeParentInvocation, type ParentInvocation } from "./native-trial-binding.ts";
import { bindAdmittedNativeRuntimeRequirement, type NativeRuntimeInventory } from "./native-runtime-observation.ts";
import { prepareNativeLaunch } from "./native-launch.ts";
import { readCodexAuthLease, type createCodexAuthLease } from "./codex-auth.ts";

interface Options {
  runtime: NativeRuntimeInventory;
  guildRoot: string;
  invocation: ParentInvocation;
  authLease: Awaited<ReturnType<typeof createCodexAuthLease>>;
}
export async function prepareAdmittedNativeLaunch(origin: CampaignAdmissionOrigin, bank: TaskBank, options: Options) {
  try {
    const input = deriveAdmittedTrialInput(origin, bank);
    if (input.spec.version !== 2) throw Error();
    const { runtime, guildRoot, invocation } = structuredClone({ runtime: options.runtime, guildRoot: options.guildRoot, invocation: options.invocation });
    const lease = options.authLease;
    const leaseScope = { timeoutMs: input.request.timeoutMs,
      forbiddenRoots: [dirname(input.artifactDirectory), input.retentionRoot, input.cwd, guildRoot] };
    const { directory: agent, identity: scopedAuthIdentity } = readCodexAuthLease(lease, leaseScope);
    const assertFresh = () => { readCodexAuthLease(lease, leaseScope); };
    const trial = bindNativeTrial(input), parent = bindNativeParentInvocation(input, guildRoot, invocation);
    const runtimeRequirement = bindAdmittedNativeRuntimeRequirement(origin, bank, runtime);
    const runtimeBytes = JSON.stringify(runtimeRequirement) + "\n";
    const snapshot = readCampaignAdmissionOrigin(origin);
    const admissionBinding = { version: 1 as const, kind: "native-campaign-input-binding" as const, trialId: trial.trialId,
      campaignDigest: trial.campaignDigest, historyDigest: snapshot.historyDigest, admissionDigest: trial.admissionDigest,
      trialBindingDigest: parent.trialBindingDigest, invocationDigest: parent.invocationDigest, runtimeRequirementDigest: digest(runtimeRequirement), runtimeRequirementSha256: createHash("sha256").update(runtimeBytes).digest("hex") };
    assertFresh(); readCampaignAdmissionOrigin(origin);
    // Exclusive files remain on failure. No replacement, cleanup or launch here.
    await writeFile(join(input.artifactDirectory, "runtime-requirement.json"), runtimeBytes, { flag: "wx", mode: 0o600 });
    assertFresh(); readCampaignAdmissionOrigin(origin);
    const environment = await prepareNativeLaunch({ artifactDirectory: input.artifactDirectory, cwd: input.cwd,
      arm: input.request.arm, pricing: input.spec.pricing, piEntry: invocation.args[2], guildRoot,
      agent, scopedAuthIdentity, admissionBinding });
    assertFresh(); readCampaignAdmissionOrigin(origin);
    const launch: PreparedLaunch = Object.freeze({ version: 1, historyDigest: snapshot.historyDigest,
      configurationSha256: environment.GUILD_EVAL_NATIVE_CONFIG_SHA256,
      runtimeRequirementSha256: admissionBinding.runtimeRequirementSha256, invocationDigest: parent.invocationDigest,
      scopedAuthIdentityDigest: digest(scopedAuthIdentity), implementationDigest: input.spec.bindings.implementationDigest,
      supervisorPid: process.pid });
    // The bridge must commit this record before exposing environment to the driver.
    // Returning it here is preparation, not a durable launch or spending authority.
    return Object.freeze({ environment: Object.freeze(environment), launch });
  } catch { throw new Error("Native admitted launch mismatch"); }
}
