// Expected runtime input binding and selected filesystem observations only.
// No SDK import, admission, launch or loaded-module attestation.
import fs from "node:fs";
import { createHash } from "node:crypto";
import { observeNativeFiles } from "./native-file-observation.ts";
import { isDeepStrictEqual as same } from "node:util";
import { digest, type TaskBank } from "./manifest.ts";
import { readCampaignAdmissionOrigin, type CampaignAdmissionOrigin } from "./campaign.ts";
import { bindNativeTrial, deriveAdmittedTrialInput, type NativeTrialInput } from "./native-trial-binding.ts";
import { NATIVE_RUNTIME_PATHS as paths, freezeRuntime, freezeRequirement, type NativeRuntimeInventory } from "./native-input-contracts.ts";
export type { NativeRuntimeInventory } from "./native-input-contracts.ts";
const check = (value: unknown) => { if (!value) throw Error(); };
export function bindNativeRuntimeRequirement(input: NativeTrialInput, runtime: NativeRuntimeInventory) {
  try {
    const trial = bindNativeTrial(input);
    if (input.spec.version !== 2) throw Error();
    const frozen = freezeRuntime(runtime, input.spec.nativePolicy), runtimeDigest = digest(frozen);
    check(runtimeDigest === input.spec.bindings.runtimeDigest);
    return Object.freeze({ version: (input.spec.nativePolicy.version === 3 ? 2 : 1) as 1 | 2, kind: "native-runtime-input-requirement" as const,
      trialId: trial.trialId, trialBindingDigest: digest(trial), runtimeDigest, runtime: frozen });
  } catch { throw new Error("Native runtime binding mismatch"); }
}
// Parent-only origin path. V2 origins cannot currently be issued: the campaign
// gate stays closed. No token, snapshot, bank or rubric is returned to producers.
export function bindAdmittedNativeRuntimeRequirement(origin: CampaignAdmissionOrigin, bank: TaskBank, runtime: NativeRuntimeInventory) {
  try {
    const input = deriveAdmittedTrialInput(origin, bank);
    check(input.spec.version === 2);
    const requirement = bindNativeRuntimeRequirement(input, runtime);
    readCampaignAdmissionOrigin(origin);
    return requirement;
  } catch { throw new Error("Native admitted runtime binding mismatch"); }
}
export type NativeRuntimeRequirement = ReturnType<typeof bindNativeRuntimeRequirement>;
function nodeProcess(runtime: NativeRuntimeInventory) {
  check(process.execPath === runtime.nodePath && process.version === runtime.nodeVersion && process.platform === runtime.platform && process.arch === runtime.arch);
  check(Number.isSafeInteger(process.pid) && process.pid >= 2 && process.pid <= 2147483647
    && Number.isSafeInteger(process.ppid) && process.ppid >= 1 && process.ppid <= 2147483647 && process.pid !== process.ppid);
  check(fs.readlinkSync("/proc/self/exe") === runtime.nodePath);
  const info = fs.statSync("/proc/self/exe", { bigint: true });
  check(info.isFile());
  return Object.freeze({ pid: process.pid, ppid: process.ppid, nodeVersion: process.version, nodePath: process.execPath, platform: process.platform, arch: process.arch,
    executable: Object.freeze({ dev: String(info.dev), ino: String(info.ino) }) });
}
function packageIdentity(path: string, expected: ReturnType<typeof observeNativeFiles>["files"][number], name: string, version: string) {
  check(expected.bytes <= 65536 && fs.realpathSync(path) === path);
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const info = fs.fstatSync(fd, { bigint: true });
    check(info.isFile() && info.nlink === 1n && info.size >= 0n && info.size <= 65536n
      && String(info.dev) === expected.dev && String(info.ino) === expected.ino && Number(info.uid) === expected.uid
      && Number(info.mode & 0o7777n) === expected.mode && Number(info.size) === expected.bytes);
    const buffer = Buffer.alloc(Number(info.size) + 1);
    let count = 0;
    while (count < buffer.length) { const n = fs.readSync(fd, buffer, count, buffer.length - count, null); if (!n) break; count += n; }
    check(count === Number(info.size));
    const stamp = (s: fs.BigIntStats) => [s.dev, s.ino, s.mode, s.nlink, s.uid, s.gid, s.size, s.mtimeNs, s.ctimeNs];
    check(same(stamp(info), stamp(fs.fstatSync(fd, { bigint: true })))
      && same(stamp(info), stamp(fs.lstatSync(path, { bigint: true }))) && fs.realpathSync(path) === path);
    const bytes = buffer.subarray(0, count);
    check(createHash("sha256").update(bytes).digest("hex") === expected.sha256);
    const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    check(data && typeof data === "object" && !Array.isArray(data) && data.name === name && data.version === version);
    return Object.freeze({ id: expected.id, name, version });
  } finally { fs.closeSync(fd); }
}
export function observeNativeRuntime(requirement: NativeRuntimeRequirement) {
  try {
    const frozen = freezeRequirement(requirement), { runtime, trialId } = frozen, requirementDigest = digest(frozen);
    const current = nodeProcess(runtime);
    const files = observeNativeFiles(runtime.hashes.map((entry, i) => ({ id: i === 0 ? "runtime/node" : `runtime/file-${i}`, ...entry })));
    const packages = Object.freeze([
      packageIdentity(paths[1], files.files[1], "@earendil-works/pi-coding-agent", runtime.piVersion),
      packageIdentity(paths[10], files.files[10], "@earendil-works/pi-ai", runtime.aiVersion),
    ]);
    check(same(current, nodeProcess(runtime)) && same(current.executable, { dev: files.files[0].dev, ino: files.files[0].ino }));
    return Object.freeze({ version: 1 as const, kind: "native-runtime-file-observation" as const, trialId, requirementDigest, process: current, files, packages });
  } catch { throw new Error("Native runtime observation mismatch"); }
}
