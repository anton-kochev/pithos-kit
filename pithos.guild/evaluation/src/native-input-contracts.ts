// Shared input-only contracts. No ledger, bank, filesystem or SDK loading.
import { isDeepStrictEqual as same } from "node:util";
import { digest } from "./manifest.ts";
import { CANDIDATE_NATIVE_POLICY_V3, NATIVE_POLICY_V1, validateNativePolicy, type NativePolicy } from "./native-policy.ts";
import type { snapshotRuntime } from "./offline-runtime.ts";

type Inventory = ReturnType<typeof snapshotRuntime>;
export type NativeRuntimeInventory = Readonly<Omit<Inventory, "hashes">> & { readonly hashes: readonly Readonly<Inventory["hashes"][number]>[] };
export interface NativeRuntimeRequirement {
  readonly version: 1 | 2; readonly kind: "native-runtime-input-requirement";
  readonly trialId: string; readonly trialBindingDigest: string; readonly runtimeDigest: string;
  readonly runtime: NativeRuntimeInventory;
}
const check = (value: unknown) => { if (!value) throw Error(); };
const root = "/opt/pi-npm/lib/node_modules/@earendil-works/pi-coding-agent";
// Closed historical selection, not a dependency closure or approval of bytes.
export const NATIVE_RUNTIME_PATHS = Object.freeze(["/usr/bin/node", ...[
  "package.json", "dist/cli.js", "dist/cli/setup.js", "dist/core/http-dispatcher.js", "dist/core/model-runtime.js", "dist/core/agent-session.js",
  "dist/core/resource-loader.js", "dist/core/system-prompt.js", "dist/core/auth-storage.js",
  "node_modules/@earendil-works/pi-ai/package.json", "node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js",
  "node_modules/@earendil-works/pi-ai/dist/providers/data/openai-codex.json",
].map(path => `${root}/${path}`)]);
function exact(value: any, keys: string[]) {
  check(value && typeof value === "object" && !Array.isArray(value) && Reflect.ownKeys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k)));
}
const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function freezeRuntime(raw: NativeRuntimeInventory, policy: NativePolicy = NATIVE_POLICY_V1) {
  policy = validateNativePolicy(policy);
  exact(raw, ["version", "nodePath", "nodeVersion", "platform", "arch", "piVersion", "aiVersion", "hashes"]);
  const { version, nodePath, nodeVersion, platform, arch, piVersion, aiVersion, hashes } = raw;
  check(same({ version, nodePath, nodeVersion, platform, arch, piVersion, aiVersion }, {
    version: 1, nodePath: "/usr/bin/node", nodeVersion: policy.node, platform: "linux", arch: "arm64", piVersion: policy.pi, aiVersion: policy.piAi,
  }));
  check(Array.isArray(hashes) && hashes.length === NATIVE_RUNTIME_PATHS.length && Reflect.ownKeys(hashes).length === NATIVE_RUNTIME_PATHS.length + 1);
  const entries = Array.from(hashes, (entry, i) => {
    exact(entry, ["path", "sha256"]);
    const { path, sha256 } = entry;
    check(path === NATIVE_RUNTIME_PATHS[i] && hash(sha256));
    return Object.freeze({ path, sha256 });
  });
  return Object.freeze({ version, nodePath, nodeVersion, platform, arch, piVersion, aiVersion, hashes: Object.freeze(entries) });
}
export function freezeRequirement(raw: NativeRuntimeRequirement) {
  exact(raw, ["version", "kind", "trialId", "trialBindingDigest", "runtimeDigest", "runtime"]);
  const { version, kind, trialId, trialBindingDigest, runtimeDigest } = raw;
  check((version === 1 || version === 2) && kind === "native-runtime-input-requirement" && typeof trialId === "string"
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(trialId) && hash(trialBindingDigest) && hash(runtimeDigest));
  const runtime = freezeRuntime(raw.runtime, version === 2 ? CANDIDATE_NATIVE_POLICY_V3 : NATIVE_POLICY_V1);
  check(runtimeDigest === digest(runtime));
  return Object.freeze({ version, kind, trialId, trialBindingDigest, runtimeDigest, runtime });
}
export interface NativeLaunchBinding {
  version: 1; kind: "native-campaign-input-binding"; trialId: string;
  campaignDigest: string; historyDigest: string; admissionDigest: string; trialBindingDigest: string; invocationDigest: string;
  runtimeRequirementDigest: string; runtimeRequirementSha256: string;
}
export function validateNativeLaunchBinding(raw: unknown) {
  try {
    const hashes = ["campaignDigest", "historyDigest", "admissionDigest", "trialBindingDigest", "invocationDigest", "runtimeRequirementDigest", "runtimeRequirementSha256"] as const;
    exact(raw, ["version", "kind", "trialId", ...hashes]);
    const b = structuredClone(raw) as NativeLaunchBinding;
    check(b.version === 1 && b.kind === "native-campaign-input-binding"
      && typeof b.trialId === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(b.trialId)
      && hashes.every(key => hash(b[key])));
    return Object.freeze(b);
  } catch { throw new Error("Native launch binding mismatch"); }
}
