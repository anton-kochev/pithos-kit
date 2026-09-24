import { assembleNativeCampaign } from "./campaign-execution.ts";
import { createCampaign, validateCampaignSpec } from "./campaign.ts";
import { digest, validateBank } from "./manifest.ts";

type Selection = Parameters<typeof assembleNativeCampaign>[0];

// Supervisor-memory lifecycle only, NOT an isolation or provisioning guarantee.
// No bank path, JSON/CLI input, producer callback or driver override is exposed.
// The caller owns its original inputs; disposal releases our references, not
// caller copies, JS heap bytes, or retained campaign evidence.
export function supervisorCampaign(raw: Selection) {
  let selection: Selection | undefined;
  try {
    selection = structuredClone(raw);
    selection.bank = validateBank(selection.bank);
    const spec = validateCampaignSpec(selection.spec);
    if (spec.version !== 2 || selection.policy.evidenceDomain !== "offline-integration"
      || digest(selection.bank) !== spec.bindings.bankDigest) throw Error();
    selection.spec = spec;
  } catch { throw new Error("Invalid supervisor inputs"); }
  let execution: ReturnType<typeof assembleNativeCampaign> | undefined;
  let busy = false, inspected = false;
  const dispose = () => { selection = undefined; execution = undefined; };
  const current = () => {
    if (!selection) throw new Error("Supervisor lifecycle closed");
    if (busy) throw new Error("Supervisor operation already active");
    return selection;
  };
  return Object.freeze({
    async createCampaign() {
      const selected = current();
      if (execution) throw new Error("Campaign already created");
      busy = true;
      try {
        // Explicit operator action, never an implicit side effect of inspection.
        await createCampaign(selected.directory, selected.spec);
        if (!selection) throw new Error("Supervisor lifecycle closed");
        execution = assembleNativeCampaign(selected);
      } catch (error) { dispose(); throw error; }
      finally { busy = false; }
    },
    async inspectSelection(signal?: AbortSignal) {
      current();
      if (!execution) throw new Error("Explicit campaign creation is required");
      busy = true;
      try {
        const bindings = await execution.inspectSelection(signal);
        if (!selection) throw new Error("Supervisor lifecycle closed");
        inspected = true;
        return bindings;
      }
      catch (error) { dispose(); throw error; }
      finally { busy = false; }
    },
    async runNext(signal?: AbortSignal) {
      current();
      if (!execution) throw new Error("Explicit campaign creation is required");
      if (!inspected) throw new Error("Selection inspection is required");
      busy = true;
      try { return await execution.runNext(signal); }
      finally { busy = false; dispose(); }
    },
    dispose,
  });
}

// Fixed operational entry: exactly RO /harness/guild and RW /evidence are the
// intended mounts. Neither offers supervisor-only storage against same-UID
// producers. Do not read/copy a private bank or create an operational campaign
// until a separately reviewed isolation/provenance contract replaces this stop.
// There is intentionally no caller-controlled approval/bypass parameter.
export function prepareRestrictedIntegration(_selection: Selection): never {
  throw new Error("Reviewed supervisor isolation is required before restricted preparation");
}
