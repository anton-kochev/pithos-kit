import assert from "node:assert/strict";
import { test } from "node:test";
import { snapshotRuntime, assertMatchingRuntime } from "../src/offline-runtime.ts";

function fixture(change = "") {
  const paths: string[] = [];
  const runtime = snapshotRuntime({ nodePath: "/usr/bin/node", nodeVersion: "v24.20.0", platform: "linux", arch: "arm64", read(path: string) {
    paths.push(path);
    return Buffer.from(path.endsWith("package.json") ? JSON.stringify({ name: path.includes("/pi-ai/") ? "@earendil-works/pi-ai" : "@earendil-works/pi-coding-agent", version: "0.85.1" }) : "synthetic bytes" + change);
  } });
  return { paths, runtime };
}

test("refuses unreviewed runtime versions and renamed packages without SDK execution", () => {
  for (const change of [{ nodeVersion: "v24.21.0" }, { platform: "darwin" }, { nodePath: "/opt/node/bin/node" }, { piVersion: "0.85.2" }, { name: "other" }]) {
    assert.throws(() => snapshotRuntime({ nodePath: "/usr/bin/node", nodeVersion: "v24.20.0", platform: "linux", arch: "arm64", ...change,
      read: path => Buffer.from(path.endsWith("package.json") ? JSON.stringify({ name: change.name ?? (path.includes("/pi-ai/") ? "@earendil-works/pi-ai" : "@earendil-works/pi-coding-agent"), version: change.piVersion ?? "0.85.1" }) : "synthetic"),
    }), /Unreviewed offline runtime/);
  }
});

test("static runtime inventory reads selected implementation files only and rejects byte drift", () => {
  const { paths, runtime } = fixture();
  assert.equal(runtime.nodeVersion, "v24.20.0"); assert.equal(runtime.piVersion, "0.85.1");
  assert.ok(paths.every(path => path === "/usr/bin/node" || path.startsWith("/opt/pi-npm/lib/node_modules/@earendil-works/pi-coding-agent/")));
  assert.ok(!paths.some(path => /auth.json|settings.json|\/home\//.test(path)));
  assertMatchingRuntime(runtime, fixture().runtime);
  assert.throws(() => assertMatchingRuntime(runtime, fixture("drift").runtime), /Offline runtime mismatch/);
  assert.throws(() => assertMatchingRuntime({}, runtime), /Offline runtime mismatch/);
});

test("explicit candidate snapshot selection does not reinterpret historical defaults", async () => {
  const { CANDIDATE_NATIVE_POLICY_V3 } = await import("../src/native-policy.ts");
  const input = { nodePath: "/usr/bin/node", nodeVersion: "v24.20.0", platform: "linux", arch: "arm64",
    read: (path: string) => Buffer.from(path.endsWith("package.json") ? JSON.stringify({
      name: path.includes("/pi-ai/") ? "@earendil-works/pi-ai" : "@earendil-works/pi-coding-agent", version: "0.87.0" }) : "inert bytes") };
  assert.equal(snapshotRuntime(input, CANDIDATE_NATIVE_POLICY_V3).piVersion, "0.87.0");
  assert.throws(() => snapshotRuntime(input), /Unreviewed offline runtime/);
  assert.throws(() => snapshotRuntime({ ...input, arch: "x64" }, CANDIDATE_NATIVE_POLICY_V3), /Unreviewed offline runtime/);
});
