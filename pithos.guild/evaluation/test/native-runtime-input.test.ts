import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { digest } from "../src/manifest.ts";
import { NATIVE_RUNTIME_PATHS, validateNativeLaunchBinding } from "../src/native-input-contracts.ts";
import { readNativeRuntimeInput } from "../src/native-runtime-input.ts";

const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
const mismatch = /^Error: Native runtime input mismatch$/;
// Input-only fixture, not an issued native admission or observed installed runtime.
function fixture(visit: (f: { file: string; sibling: string; requirement: any; config: any; persist: () => string }) => void) {
  const root = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), "guild-runtime-input-test-"));
  try {
    const file = join(root, "native-config.json"), sibling = join(root, "runtime-requirement.json");
    const runtime = { version: 1, nodePath: "/usr/bin/node", nodeVersion: "v24.20.0", platform: "linux", arch: "arm64", piVersion: "0.85.1", aiVersion: "0.85.1",
      hashes: NATIVE_RUNTIME_PATHS.map(path => ({ path, sha256: sha("inert selected bytes") })) };
    const requirement = { version: 1, kind: "native-runtime-input-requirement", trialId: "00000000-0000-4000-8000-000000000001", trialBindingDigest: sha("trial"), runtimeDigest: digest(runtime), runtime };
    const config = { admissionBinding: { version: 1, kind: "native-campaign-input-binding", trialId: requirement.trialId,
      campaignDigest: sha("campaign"), historyDigest: sha("history"), admissionDigest: sha("admission"), trialBindingDigest: requirement.trialBindingDigest,
      invocationDigest: sha("invocation"), runtimeRequirementDigest: "", runtimeRequirementSha256: "" } };
    const persist = () => {
      const raw = JSON.stringify(requirement) + "\n";
      config.admissionBinding.runtimeRequirementDigest = digest(requirement); config.admissionBinding.runtimeRequirementSha256 = sha(raw);
      fs.writeFileSync(sibling, raw, { mode: 0o600 }); const bytes = JSON.stringify(config);
      fs.writeFileSync(file, bytes, { mode: 0o600 }); return sha(bytes);
    };
    visit({ file, sibling, requirement, config, persist });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
test("loads only the bound reduced runtime requirement from the fixed sibling", t => {
  fixture(f => {
    const expected = f.persist(), open = fs.openSync, opened: string[] = [];
    const mock = t.mock.method(fs, "openSync", (file: any, ...args: any[]) => {
      assert.ok(file === f.file || file === f.sibling, "must not inspect any installed input"); opened.push(file);
      return (open as any)(file, ...args);
    });
    try {
      const result = readNativeRuntimeInput(f.file, expected);
      assert.deepEqual(result, f.requirement); assert.ok(Object.isFrozen(result.runtime.hashes));
      assert.deepEqual(opened, [f.file, f.sibling]);
    } finally { mock.mock.restore(); }
  });
});

test("shared binding validation returns the checked snapshot rather than re-reading getters", () => {
  fixture(f => {
    f.persist(); let reads = 0;
    Object.defineProperty(f.config.admissionBinding, "historyDigest", { enumerable: true, get() { return ++reads === 1 ? sha("original") : "UNCHECKED_VALUE"; } });
    const result = validateNativeLaunchBinding(f.config.admissionBinding);
    assert.equal(result.historyDigest, sha("original")); assert.equal(reads, 1); assert.ok(Object.isFrozen(result));
  });
});

test("rejects missing, aliased or byte-modified retained inputs", () => {
  for (const mode of ["missing", "alias", "config bytes", "requirement bytes"]) fixture(f => {
    const expected = f.persist();
    if (mode === "missing") fs.unlinkSync(f.sibling);
    if (mode === "alias") { fs.renameSync(f.sibling, f.sibling + ".old"); fs.symlinkSync(f.sibling + ".old", f.sibling); }
    if (mode === "config bytes") fs.appendFileSync(f.file, " ");
    if (mode === "requirement bytes") fs.appendFileSync(f.sibling, " ");
    assert.throws(() => readNativeRuntimeInput(f.file, expected), mismatch, mode);
  });
});

for (const mode of ["trial", "trial binding", "tuple", "inventory", "extra"]) test(`recomputed hashes cannot bypass ${mode} checks`, () => {
  fixture(f => {
    if (mode === "trial") f.requirement.trialId = "00000000-0000-4000-8000-000000000002";
    if (mode === "trial binding") f.requirement.trialBindingDigest = sha("different trial");
    if (mode === "tuple") f.requirement.runtime.arch = "x64";
    if (mode === "inventory") f.requirement.runtime.hashes.pop();
    if (mode === "extra") f.requirement.bank = "PRIVATE_BANK_MUST_NOT_LEAK";
    f.requirement.runtimeDigest = digest(f.requirement.runtime);
    const expected = f.persist();
    assert.throws(() => readNativeRuntimeInput(f.file, expected), mismatch, mode);
  });
});

for (const mode of ["missing raw hash", "raw hash", "canonical hash", "extra binding", "inner digest"]) test(`rejects ${mode} in bound runtime inputs`, () => {
  fixture(f => {
    if (mode === "inner digest") f.requirement.runtimeDigest = sha("wrong inventory digest");
    f.persist(); const b = f.config.admissionBinding;
    if (mode === "missing raw hash") delete b.runtimeRequirementSha256;
    if (mode === "raw hash") b.runtimeRequirementSha256 = sha("wrong bytes");
    if (mode === "canonical hash") b.runtimeRequirementDigest = sha("wrong requirement digest");
    if (mode === "extra binding") b.path = "DO_NOT_READ";
    const bytes = JSON.stringify(f.config); fs.writeFileSync(f.file, bytes);
    assert.throws(() => readNativeRuntimeInput(f.file, sha(bytes)), mismatch, mode);
  });
});

test("versioned requirements match 0.87.0 without reinterpreting historical inputs", () => {
  fixture(f => {
    f.requirement.version = 2;
    f.requirement.runtime.piVersion = f.requirement.runtime.aiVersion = "0.87.0";
    f.requirement.runtimeDigest = digest(f.requirement.runtime);
    assert.deepEqual(readNativeRuntimeInput(f.file, f.persist()), f.requirement);
    for (const [version, piVersion, aiVersion] of [[1, "0.87.0", "0.87.0"], [2, "0.85.1", "0.85.1"], [2, "0.87.0", "0.85.1"], [3, "0.87.0", "0.87.0"]]) {
      Object.assign(f.requirement, { version }); Object.assign(f.requirement.runtime, { piVersion, aiVersion });
      f.requirement.runtimeDigest = digest(f.requirement.runtime);
      assert.throws(() => readNativeRuntimeInput(f.file, f.persist()), mismatch);
    }
  });
});
