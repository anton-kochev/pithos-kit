import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { captureScopedAuth, assertScopedAuth, type ScopedAuthIdentity } from "./scoped-auth-identity.ts";
import type { BasePricing } from "./pricing.ts";
import type { Arm } from "./runner.ts";

import { validateNativeLaunchBinding, type NativeLaunchBinding } from "./native-input-contracts.ts";
export type { NativeLaunchBinding } from "./native-input-contracts.ts";
interface Launch { admissionBinding?: NativeLaunchBinding; scopedAuthIdentity?: ScopedAuthIdentity; artifactDirectory: string; agent: string; cwd: string; guildRoot: string; piEntry: string; pricing: BasePricing; arm: Arm }
export async function prepareNativeLaunch(options: Launch) {
  options = structuredClone(options);
  if (Object.hasOwn(options, "admissionBinding")) {
    options.admissionBinding = validateNativeLaunchBinding(options.admissionBinding);
    if (!Object.hasOwn(options, "scopedAuthIdentity")) throw new Error("Native launch binding mismatch");
  }
  const directory = join(options.artifactDirectory, "native"), file = join(options.artifactDirectory, "native-config.json");
  const scopedAuthIdentity = Object.hasOwn(options, "scopedAuthIdentity")
    ? assertScopedAuth(join(options.agent, "auth.json"), options.scopedAuthIdentity!, 0)
    : captureScopedAuth(join(options.agent, "auth.json"), 0);
  const raw = JSON.stringify({ version: 1, directory, cwd: options.cwd, guildRoot: options.guildRoot, piEntry: options.piEntry,
    piRoot: dirname(dirname(options.piEntry)), pricing: options.pricing, arm: options.arm, launchParentPid: process.pid,
    node: process.version, nodePath: process.execPath, scopedAuthIdentity,
    ...(options.admissionBinding ? { admissionBinding: options.admissionBinding } : {}) });
  if (Buffer.byteLength(raw) > 65536) throw new Error("Native configuration size mismatch");
  await mkdir(directory, { mode: 0o700 });
  await writeFile(file, raw, { flag: "wx", mode: 0o600 });
  assertScopedAuth(join(options.agent, "auth.json"), scopedAuthIdentity, 0);
  return { NODE_OPTIONS: `--import=${pathToFileURL(join(options.guildRoot, "evaluation/src/native-preload.ts")).href}`,
    GUILD_EVAL_NATIVE_CONFIG: file, GUILD_EVAL_NATIVE_CONFIG_SHA256: createHash("sha256").update(raw).digest("hex"), GUILD_EVAL_AUTH_DIGEST: scopedAuthIdentity.fileDigest };
}
