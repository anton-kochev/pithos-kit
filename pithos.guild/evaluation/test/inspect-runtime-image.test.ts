import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { NATIVE_RUNTIME_PATHS } from "../src/native-input-contracts.ts";

const SUPPLEMENTAL_STATIC_PATHS = [
  "/opt/pi-npm/lib/node_modules/@earendil-works/pi-coding-agent/dist/main.js",
  "/opt/pi-npm/lib/node_modules/@earendil-works/pi-coding-agent/dist/config.js",
];
const INSPECTION_PATHS = [...NATIVE_RUNTIME_PATHS, ...SUPPLEMENTAL_STATIC_PATHS];

// Inert boundary only: never resolve a real Docker executable.
function run(scenario = "") {
  const root = mkdtempSync(join(tmpdir(), "inspect-test-"));
  const docker = join(root, "docker");
  writeFileSync(join(root, "calls"), "");
  writeFileSync(docker, `#!/bin/sh\nexec '${process.execPath}' '${resolve("evaluation/test/fixtures/inspect-image.mjs")}' "$@"\n`, { mode: 0o700 });
  let output: string | undefined;
  try {
    const result = spawnSync("bash", [resolve("evaluation/inspect-runtime-image.sh")], {
      env: { PATH: process.env.PATH, DOCKER: docker, FAKE_ROOT: root, SCENARIO: scenario }, encoding: "utf8", timeout: 15000,
    });
    output = /^Output: (.+)$/m.exec(result.stdout)?.[1];
    const calls: string[][] = readFileSync(join(root, "calls"), "utf8").trim().split("\n").filter(Boolean).map(x => JSON.parse(x));
    const observations = output && existsSync(join(output, "observations.tsv")) ? readFileSync(join(output, "observations.tsv"), "utf8") : "";
    const files = result.status === 0 && output ? readdirSync(join(output, "files")).sort((a, b) => Number(a) - Number(b)).map(name => ({
      name, bytes: readFileSync(join(output!, "files", name), "utf8"), mode: statSync(join(output!, "files", name)).mode & 0o777,
    })) : [];
    return { ...result, calls, observations, files, inventory: output ? readFileSync(join(output, "inventory.tsv"), "utf8") : "", mode: output ? statSync(output).mode & 0o777 : 0 };
  } finally { rmSync(root, { recursive: true, force: true }); if (output) rmSync(output, { recursive: true, force: true }); }
}

test("inspection preserves runtime13 and appends exactly two supplemental static leaves without starting", () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.mode, 0o700);
  assert.deepEqual(r.calls.filter(c => c[0] === "cp").map(c => c[1].split(":").slice(1).join(":")), INSPECTION_PATHS);
  assert.deepEqual(r.inventory.trim().split("\n").map(x => x.split("\t")[0]), INSPECTION_PATHS);
  assert.equal(NATIVE_RUNTIME_PATHS.length, 13);
  const rows = r.inventory.trim().split("\n").map(x => x.split("\t"));
  assert.deepEqual(rows.filter(x => x[2] === "native-runtime13").map(x => x[0]), NATIVE_RUNTIME_PATHS);
  assert.deepEqual(rows.filter(x => x[2] === "supplemental-static").map(x => x[0]), SUPPLEMENTAL_STATIC_PATHS);
  assert.ok(rows.every(x => x.length === 3 && /^[a-f0-9]{64}$/.test(x[1])));
  assert.deepEqual(r.files, INSPECTION_PATHS.map((path, i) => ({ name: String(i + 1), bytes: `inert selected bytes: ${path}\n`, mode: 0o600 })));
  assert.deepEqual(r.observations.trim().split("\n").map(x => [x.split("\t")[0], x.split("\t")[3]]), INSPECTION_PATHS.map((path, i) => [path, `files/${i + 1}`]));
  assert.ok(r.calls.every(c => ["image", "create", "cp", "rm"].includes(c[0])));
  assert.equal(r.calls[0].at(-1), "sha256:edcbed99a004b66c67c0dd1d3ea794d6c0a2e83da18be770aeddedeff534dbff");
  const create = r.calls.find(c => c[0] === "create")!;
  for (const flag of ["--pull=never", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user=501:501", "--pids-limit=64"]) assert.ok(create.includes(flag));
  assert.deepEqual(r.calls.at(-1), ["rm", "-v", "a".repeat(64)]);
});

test("reviewed metadata user spellings are accepted without attesting runtime identity", () => {
  for (const scenario of ["user-pi", "user-501"]) {
    const r = run(scenario);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.calls.find(c => c[0] === "create")!.includes("--user=501:501"));
    assert.ok(!r.calls.some(c => ["start", "run", "exec"].includes(c[0])));
  }
});

test("inspect template uses missing-safe map indexing (source contract, not Docker execution)", () => {
  const source = readFileSync(resolve("evaluation/inspect-runtime-image.sh"), "utf8");
  assert.ok(source.includes('{{index .Config "User"}}'));
  assert.ok(source.includes('{{if index .Config "Volumes"}}'));
  assert.doesNotMatch(source, /\.Config\.(User|Volumes)/);
});

test("mismatched identity, platform, user and declared volumes stop before creating", () => {
  for (const scenario of ["id", "os", "arch", "volume", "user-root", "user-empty", "user-pair"]) {
    const r = run(scenario);
    assert.equal(r.status, 1);
    assert.deepEqual(r.calls.map(c => c[0]), ["image"]);
  }
});

test("failed creation never removes a colliding name", () => {
  const r = run("collision");
  assert.equal(r.status, 1);
  assert.ok(!r.calls.some(c => c[0] === "rm"));
  assert.match(r.stderr, /Reconcile Docker manually/);
});

test("missing leaves, symlinks and directory archives fail closed and clean owned ID", () => {
  for (const scenario of ["missing", "symlink", "directory", "oversize", "traversal", "extra", "checksum"]) {
    const r = run(scenario);
    assert.equal(r.status, 1, scenario);
    assert.equal(r.inventory, "");
    assert.equal(r.calls.filter(c => c[0] === "cp").length, 1);
    assert.deepEqual(r.calls.at(-1), ["rm", "-v", "a".repeat(64)]);
  }
});

test("cleanup failure is nonzero and never announces success", () => {
  const r = run("cleanup");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Cleanup failed; owned container ID/);
  assert.match(r.stderr, /Retained output/);
  assert.doesNotMatch(r.stdout, /Inspection complete/);
});

test("a fully returned owned ID is cleaned even if create then fails", () => {
  const r = run("returned-error");
  assert.equal(r.status, 1);
  assert.deepEqual(r.calls.at(-1), ["rm", "-v", "a".repeat(64)]);
});

test("cancellation cleans only a returned ID, otherwise reports unresolved ownership", () => {
  for (const scenario of ["cancel-id", "cancel-no-id"]) {
    const r = run(scenario);
    assert.notEqual(r.status, 0);
    assert.ok(!r.calls.some(c => c[0] === "cp"));
    if (scenario === "cancel-id") assert.deepEqual(r.calls.at(-1), ["rm", "-v", "a".repeat(64)]);
    else {
      assert.ok(!r.calls.some(c => c[0] === "rm"));
      assert.match(r.stderr, /Creation outcome unknown/);
    }
  }
});

test("missing or unsafe supplemental leaves fail closed at their exact position and clean owned ID", () => {
  for (const [offset, leaf] of ["main", "config"].entries()) {
    for (const failure of ["missing", "symlink", "directory", "oversize", "traversal", "extra", "checksum"]) {
      const scenario = `${leaf}-${failure}`;
      const r = run(scenario);
      assert.equal(r.status, 1, scenario);
      assert.deepEqual(r.calls.filter(c => c[0] === "cp").map(c => c[1].split(":").slice(1).join(":")), INSPECTION_PATHS.slice(0, 14 + offset), scenario);
      assert.deepEqual(r.inventory.trim().split("\n").map(x => x.split("\t")[0]), INSPECTION_PATHS.slice(0, 13 + offset), scenario);
      assert.ok(r.observations.includes(`${SUPPLEMENTAL_STATIC_PATHS[offset]}\t${failure === "missing" ? "copy-failed" : "rejected archive/type"}`), scenario);
      assert.doesNotMatch(r.stdout, /Inspection complete/);
      assert.deepEqual(r.calls.at(-1), ["rm", "-v", "a".repeat(64)]);
    }
  }
});
