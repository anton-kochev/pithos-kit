// Input loading only: never observes the installed runtime or grants execution.
import { basename, dirname, join } from "node:path";
import { digest } from "./manifest.ts";
import { readNativeConfig } from "./native-config.ts";
import { validateNativeLaunchBinding, freezeRequirement, type NativeRuntimeRequirement } from "./native-input-contracts.ts";

export function readNativeRuntimeInput(file: string, configSha256: string) {
  try {
    if (basename(file) !== "native-config.json") throw Error();
    const config = readNativeConfig(file, configSha256), binding = validateNativeLaunchBinding(config.admissionBinding);
    const raw = readNativeConfig(join(dirname(file), "runtime-requirement.json"), binding.runtimeRequirementSha256);
    const requirement = freezeRequirement(raw as unknown as NativeRuntimeRequirement);
    if (digest(requirement) !== binding.runtimeRequirementDigest || requirement.trialId !== binding.trialId
      || requirement.trialBindingDigest !== binding.trialBindingDigest) throw Error();
    return requirement;
  } catch { throw new Error("Native runtime input mismatch"); }
}
