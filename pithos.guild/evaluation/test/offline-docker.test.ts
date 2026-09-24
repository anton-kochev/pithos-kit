import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

async function run(scenario = "", extra: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), "guild-offline-docker-test-"));
  let output: string | undefined;
  try {
    await mkdir(join(root, "bin"));
    await writeFile(join(root, "bin/docker"), `#!/bin/sh\nexec '${process.execPath}' '${resolve("evaluation/test/fixtures/offline-docker.mjs")}' "$@"\n`, { mode: 0o700 });
    const result = spawnSync("bash", [resolve("evaluation/offline-docker.sh"), "source", ...extra], {
      env: { PATH: `${root}/bin:${process.env.PATH}`, FAKE_DOCKER_ROOT: root, FAKE_DOCKER_SCENARIO: scenario }, encoding: "utf8", timeout: 15000,
    });
    output = /^Artifacts: (.+)$/m.exec(result.stdout)?.[1];
    const calls = (await readFile(join(root, "calls.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]);
    const assets = output ? await readdir(join(output, "harness"), { recursive: true }).catch(() => []) : [];
    const finalState = output ? await readFile(join(output, "docker-final-state.json"), "utf8").catch(() => "") : "";
    return { ...result, calls, assets, finalState };
  } finally {
    await rm(root, { recursive: true, force: true });
    if (output?.startsWith(resolve("../.pi/evaluation") + "/offline-docker.")) await rm(output, { recursive: true, force: true });
  }
}

test("retains selected Docker final state before removal even after start or verification fails", async () => {
  for (const scenario of ["", "start-error", "exit-error"]) {
    const result = await run(scenario);
    assert.equal(result.status, scenario ? 1 : 0);
    if (scenario) assert.match(result.stderr, /Offline harness failed; retained artifacts:/);
    const final = JSON.parse(result.finalState);
    assert.equal(final.memoryLimit, 536870912); assert.equal(final.pidsLimit, 64); assert.equal(final.oomKilled, false);
    const inspected = result.calls.findIndex(args => args[0] === "inspect" && args[2]?.includes(".State.OOMKilled"));
    assert.ok(inspected >= 0 && inspected < result.calls.findIndex(args => args[0] === "rm"));
  }
  const missing = await run("final-state-error");
  assert.equal(missing.status, 1); assert.match(missing.stderr, /Final container state unavailable/);
  assert.equal(missing.calls.at(-1)?.[0], "rm");
});

test("Guild mode copies a closed package subset but keeps the same isolated container policy", async () => {
  const result = await run("", ["--synthetic-guild"]);
  assert.equal(result.status, 0, result.stderr);
  for (const file of ["guild/package.json", "guild/extensions/index.ts", "guild/src/runner.ts", "guild/agents/roles/explorer.md", "guild/agents/roles/coder.md", "guild/agents/profiles/typescript.md", "offline-guild-bootstrap.ts", "child-observer.ts", "offline-diagnostics.ts", "scoped-auth-identity.ts", "native-config.ts", "native-input-contracts.ts", "native-policy.ts", "native-runtime-input.ts"]) assert.ok(result.assets.includes(file), file);
  assert.ok(!result.assets.some(file => /node_modules|auth.json|\.pi\/|\.pithos/.test(file)));
  const create = result.calls.find(args => args[0] === "create")!;
  assert.equal(create.at(-1), "--synthetic-guild"); assert.equal(create[create.indexOf("--network") + 1], "none");
  assert.equal(create.filter(arg => arg === "--mount").length, 2);
  assert.equal(result.calls.filter(args => args[0] === "create").length, 1);
  for (const scenario of ["missing-guild-summary", "missing-guild-marker", "network-drift"]) assert.notEqual((await run(scenario, ["--synthetic-guild"])).status, 0);
});

test("explicit synthetic mode stays in the inspected container and requires its own completion evidence", async () => {
  const result = await run("", ["--synthetic-pi"]);
  assert.equal(result.status, 0, result.stderr);
  const create = result.calls.find(args => args[0] === "create")!;
  assert.equal(create.at(-1), "--synthetic-pi");
  assert.ok(result.assets.includes("scoped-auth-identity.ts"));
  assert.ok(result.assets.includes("native-config.ts"));
  for (const name of ["native-input-contracts.ts", "native-policy.ts", "native-runtime-input.ts"]) assert.ok(result.assets.includes(name), name);
  assert.equal(create[create.indexOf("--network") + 1], "none");
  assert.equal(result.calls.filter(args => args[0] === "create").length, 1);
  for (const scenario of ["missing-synthetic-summary", "missing-synthetic-marker"]) {
    assert.notEqual((await run(scenario, ["--synthetic-pi"])).status, 0);
  }
});

test("cleans up its labelled container even when create loses its response or the host is interrupted", async () => {
  const lost = await run("create-error");
  assert.notEqual(lost.status, 0);
  assert.equal(lost.calls.at(-1)?.[0], "rm");
  assert.match(lost.calls.at(-1)?.[2] ?? "", /^guild-offline-/);
  const unknown = await run("create-error-uninspectable");
  assert.equal(unknown.status, 1); assert.match(unknown.stderr, /creation outcome unknown/i);
  assert.ok(!unknown.calls.some(args => args[0] === "rm"));
  const interrupted = await run("interrupt");
  assert.equal(interrupted.status, 143);
  assert.deepEqual(interrupted.calls.at(-1), ["rm", "--force", "b".repeat(64)]);
  const cleanup = await run("cleanup-error");
  assert.equal(cleanup.status, 1); assert.match(cleanup.stderr, /cleanup failed/);
  for (const scenario of ["source-stopped", "image-volumes", "mount-drift"]) {
    const result = await run(scenario);
    assert.notEqual(result.status, 0); assert.ok(!result.calls.some(args => args[0] === "start"));
  }
});

test("rejects Docker policy drift before start and missing or failed verification after start", async () => {
  for (const scenario of ["network-drift", "exit-error", "missing-report", "missing-marker"]) {
    const result = await run(scenario);
    assert.notEqual(result.status, 0, scenario);
    assert.equal(result.calls.some(args => args[0] === "start"), scenario !== "network-drift", scenario);
    assert.deepEqual(result.calls.at(-1), ["rm", "--force", "b".repeat(64)]);
  }
  const invalid = await run("", ["--network=host"]);
  assert.equal(invalid.status, 2); assert.equal(invalid.calls.length, 0);
});

test("host readiness creates and inspects a network-none container without source home or startup", async () => {
  const result = await run();
  assert.equal(result.status, 0, result.stderr);
  const create = result.calls.find(args => args[0] === "create")!;
  // Approved PID/thread headroom; all other resource and isolation settings stay fixed.
  for (const [flag, value] of [["--pids-limit", "64"], ["--memory", "512m"], ["--cpus", "1"], ["--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777"], ["--network", "none"], ["--cap-drop", "ALL"], ["--security-opt", "no-new-privileges=true"], ["--entrypoint", "/usr/bin/env"], ["--pull", "never"]]) assert.equal(create[create.indexOf(flag) + 1], value);
  assert.ok(create.includes("--read-only")); assert.ok(create.includes("sha256:" + "a".repeat(64)));
  assert.equal(create.filter(arg => arg === "--mount").length, 2);
  assert.ok(!create.some(arg => /volumes-from|docker.sock|pithos-home|env-file|privileged/.test(arg)));
  assert.ok(result.calls.findIndex(args => args[0] === "inspect" && args.at(-1) !== "source") < result.calls.findIndex(args => args[0] === "start"));
  assert.deepEqual(result.calls.at(-1), ["rm", "--force", "b".repeat(64)]);
});
