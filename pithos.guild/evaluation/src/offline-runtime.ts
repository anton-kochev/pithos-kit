// Static selected-file inventory only: no SDK imports, discovery, home or auth reads.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

import { NATIVE_POLICY_V1, validateNativePolicy, type NativePolicy } from "./native-policy.ts";

const root = "/opt/pi-npm/lib/node_modules/@earendil-works/pi-coding-agent";
interface InventoryInput { nodePath: string; nodeVersion: string; platform: string; arch: string; read: (path: string) => Buffer }
interface RuntimeInventory { version: number; nodePath: string; nodeVersion: string; platform: string; arch: string; piVersion: string; aiVersion: string; hashes: { path: string; sha256: string }[] }
export function snapshotRuntime(input: InventoryInput = { nodePath: process.execPath, nodeVersion: process.version, platform: process.platform, arch: process.arch, read: readFileSync }, policy: NativePolicy = NATIVE_POLICY_V1): RuntimeInventory {
  policy = validateNativePolicy(policy);
  if (input.nodePath !== "/usr/bin/node" || input.nodeVersion !== policy.node || input.platform !== "linux" || (policy.version === 3 && input.arch !== "arm64")) throw new Error("Unreviewed offline runtime");
  const files = [input.nodePath, ...[
    "package.json", "dist/cli.js", "dist/cli/setup.js", "dist/core/http-dispatcher.js", "dist/core/model-runtime.js", "dist/core/agent-session.js",
    "dist/core/resource-loader.js", "dist/core/system-prompt.js", "dist/core/auth-storage.js",
    "node_modules/@earendil-works/pi-ai/package.json",
    "node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js",
    "node_modules/@earendil-works/pi-ai/dist/providers/data/openai-codex.json",
  ].map(path => `${root}/${path}`)];
  const manifests = new Map<string, any>();
  const hashes = files.map(path => {
    const bytes = input.read(path);
    if (path.endsWith("/package.json")) manifests.set(path, JSON.parse(bytes.toString("utf8")));
    return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  const pi = manifests.get(`${root}/package.json`), ai = manifests.get(`${root}/node_modules/@earendil-works/pi-ai/package.json`);
  if (pi.name !== "@earendil-works/pi-coding-agent" || ai.name !== "@earendil-works/pi-ai" || pi.version !== policy.pi || ai.version !== policy.piAi) throw new Error("Unreviewed offline runtime");
  return { version: 1, nodePath: input.nodePath, nodeVersion: input.nodeVersion, platform: input.platform, arch: input.arch, piVersion: pi.version, aiVersion: ai.version, hashes };
}
export function assertMatchingRuntime(expected: unknown, actual: ReturnType<typeof snapshotRuntime>) {
  if (!isDeepStrictEqual(expected, actual)) throw new Error("Offline runtime mismatch");
}
if (process.argv[2] === "--fingerprint") {
  try { process.stdout.write(JSON.stringify(snapshotRuntime()) + "\n"); }
  catch { process.stderr.write("Offline runtime inventory failed\n"); process.exitCode = 1; }
}
