import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { assembleNativeCampaign } from "../src/campaign-execution.ts";
import { loadDevelopmentBank } from "../src/bank.ts";
import { digest } from "../src/manifest.ts";
import { createSchedule } from "../src/runner.ts";
import { snapshotRuntime } from "../src/offline-runtime.ts";
import { fingerprint } from "../src/pi-driver.ts";
import { CANDIDATE_NATIVE_POLICY_V3, NATIVE_POLICY_V1, type NativePolicy } from "../src/native-policy.ts";

async function fixture(t: TestContext, run: (selection: any, guildRoot: string, io: string[]) => Promise<void>, nativePolicy: NativePolicy = NATIVE_POLICY_V1) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "guild-assembly-test-")), guildRoot = join(root, "guild");
  const mocks: { mock: { restore(): void } }[] = [];
  try {
    for (const name of ["agents", "extensions", "src", "evaluation/src"]) await mkdir(join(guildRoot, name), { recursive: true });
    await writeFile(join(guildRoot, "package.json"), '{}\n');
    await writeFile(join(guildRoot, "package-lock.json"), '{}\n');
    await writeFile(join(guildRoot, "src/fixture.ts"), '// inert implementation\n');
    const files = new Map<string, string>(), bytes = new Map<string, Buffer>();
    const runtime = snapshotRuntime({ nodePath: "/usr/bin/node", nodeVersion: "v24.20.0", platform: "linux", arch: "arm64",
      read(path) {
        const data = Buffer.from(path.endsWith("package.json")
          ? JSON.stringify({ name: path.includes("/pi-ai/") ? "@earendil-works/pi-ai" : "@earendil-works/pi-coding-agent", version: nativePolicy.pi })
          : `inert runtime file ${bytes.size}`);
        bytes.set(path, data); return data;
      } }, nativePolicy);
    for (const [path, data] of bytes) {
      const file = join(root, `runtime-${files.size}`); await writeFile(file, data, { mode: 0o600 }); files.set(path, file);
    }
    const bank = loadDevelopmentBank(), schedule = createSchedule(bank, 1, "assembly");
    const limits = { maxTrials: 12, estimatedUsd: 10, activeMs: 3600000, workflowMs: 300000 };
    const policy = { version: 1, evidenceDomain: "offline-integration", nativePolicy: structuredClone(nativePolicy), limits };
    const spec = { version: 2, nativePolicy: structuredClone(nativePolicy), schedule, limits,
      pricing: { version: 1, model: "openai-codex/gpt-6-astra", api: "openai-codex-responses", serviceTier: "base",
        cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 } },
      bindings: { bankDigest: digest(bank), scheduleDigest: digest(schedule), implementationDigest: digest(await fingerprint(guildRoot)),
        runtimeDigest: digest(runtime), policyDigest: digest(policy), model: "openai-codex/gpt-6-astra", thinking: "high" } };
    const selection = { directory: join(root, "campaign"), spec, bank, runtime, policy, guildRoot,
      approval: "explicit-model-run-approval", codexAuth: { sourceFile: join(root, "absent-source.json"), temporaryRoot: join(root, "absent-credentials") } };
    // Filesystem edges only. Never read the installed runtime, procfs or credentials.
    const io: string[] = [], open = fs.openSync, lstat = fs.lstatSync;
    const mapped = (path: any) => { io.push(String(path)); assert.ok(files.has(path), `Unexpected runtime input: ${String(path)}`); return files.get(path)!; };
    mocks.push(t.mock.method(fs, "realpathSync", (path: any) => { mapped(path); return path; }));
    mocks.push(t.mock.method(fs, "lstatSync", (path: any, options: any) => lstat(mapped(path), options)));
    mocks.push(t.mock.method(fs, "openSync", (path: any, ...args: any[]) => (open as any)(mapped(path), ...args)));
    await run(selection, guildRoot, io);
  } finally { mocks.reverse().forEach(m => m.mock.restore()); await rm(root, { recursive: true, force: true }); }
}

test("assembly rejects inconsistent or unsupported selections before observation", async t => {
  await fixture(t, async (selection, _guildRoot, io) => {
    for (const mutate of [
      (s: any) => { s.runtime.hashes[0].path = "/unreviewed/node"; s.spec.bindings.runtimeDigest = digest(s.runtime); },
      (s: any) => { s.policy.evidenceDomain = "other"; s.spec.bindings.policyDigest = digest(s.policy); },
      (s: any) => { s.policy.extra = true; s.spec.bindings.policyDigest = digest(s.policy); },
      (s: any) => { s.policy.limits = { ...s.policy.limits, maxTrials: 2 }; s.spec.bindings.policyDigest = digest(s.policy); },
      (s: any) => { s.bank.tasks[0].prompt += " unreviewed"; },
      (s: any) => { s.spec.version = 1; },
      (s: any) => { s.codexAuth = undefined; },
      (s: any) => { s.directory = "relative-campaign"; },
    ]) {
      const changed = structuredClone(selection); mutate(changed);
      assert.throws(() => assembleNativeCampaign(changed), /Native campaign selection mismatch/);
    }
    assert.deepEqual(io, []);
  });
});

test("assembled execution uses the maintained native admission stop before observation or credential access", async t => {
  await fixture(t, async (selection, _guildRoot, io) => {
    const execution = assembleNativeCampaign(selection);
    await assert.rejects(execution.runNext(), /Native campaign admission is disabled/);
    assert.deepEqual(io, []);
    assert.equal(fs.existsSync(selection.directory), false);
    assert.equal(fs.existsSync(selection.codexAuth.temporaryRoot), false);
  });
});

test("selection inspection rejects implementation drift rather than rebasing frozen bindings", async t => {
  await fixture(t, async (selection, guildRoot) => {
    const execution = assembleNativeCampaign(selection);
    await writeFile(join(guildRoot, "src/fixture.ts"), '// changed implementation\n');
    await assert.rejects(execution.inspectSelection(), /Native campaign selection mismatch/);
  });
});

test("caller mutation cannot rebase an assembled selection and cancellation observes nothing", async t => {
  await fixture(t, async (selection, _guildRoot, io) => {
    const expected = structuredClone(selection.spec.bindings), execution = assembleNativeCampaign(selection);
    selection.bank.tasks[0].prompt += " changed";
    selection.runtime.hashes[0].sha256 = digest("changed runtime");
    selection.policy.evidenceDomain = "e1-development";
    selection.spec.bindings.implementationDigest = digest("changed source");
    await assert.rejects(execution.inspectSelection(AbortSignal.abort()), { name: "AbortError" });
    assert.deepEqual(io, []);
    const observed = await execution.inspectSelection();
    assert.deepEqual(observed, expected);
    assert.equal(Object.isFrozen(observed), true);
  });
});

test("selection inspection rejects changed runtime bytes through the real file observer", async t => {
  await fixture(t, async (selection) => {
    const execution = assembleNativeCampaign(selection);
    // openSync is mapped by this fixture; this writes only its inert temporary file.
    const fd = fs.openSync(selection.runtime.hashes[0].path, "w");
    try { fs.writeFileSync(fd, "changed inert runtime"); } finally { fs.closeSync(fd); }
    await assert.rejects(execution.inspectSelection(), /Native file observation mismatch/);
  });
});

test("assembles frozen native selection inspection without an SDK or credential read", async t => {
  await fixture(t, async (selection, _guildRoot, io) => {
    const execution = assembleNativeCampaign(selection);
    assert.deepEqual(await execution.inspectSelection(), selection.spec.bindings);
    assert.equal(new Set(io).size, 13);
  });
});

// Supervisor entry test list: explicit creation, missing/rejected inputs, no
// serialized private inputs, existing native stop, terminal cleanup, preparation block.
test("supervisor entry creates explicitly, retains no private bank and closes after native rejection", async t => {
  const { supervisorCampaign } = await import("../src/restricted-integration.ts");
  await fixture(t, async selection => {
    const session = supervisorCampaign(selection);
    await assert.rejects(session.inspectSelection(), /Explicit campaign creation is required/);
    assert.equal(fs.existsSync(selection.directory), false);
    await session.createCampaign();
    await assert.rejects(session.createCampaign(), /already created/);
    await assert.rejects(session.runNext(), /Selection inspection is required/);
    assert.deepEqual(await session.inspectSelection(), selection.spec.bindings);
    await assert.rejects(session.runNext(), /Native campaign admission is disabled/);
    await assert.rejects(session.inspectSelection(), /Supervisor lifecycle closed/);
    session.dispose();
    const retained = fs.readdirSync(selection.directory, { recursive: true }) as string[];
    for (const name of retained) {
      const path = join(selection.directory, name);
      if (!fs.statSync(path).isFile()) continue;
      const text = fs.readFileSync(path, "utf8");
      for (const task of selection.bank.tasks) {
        assert.ok(!text.includes(task.prompt));
        for (const rubric of task.rubric) assert.ok(!text.includes(rubric));
      }
      assert.ok(!text.includes('"rubric"') && !text.includes('"grader"') && !text.includes('"delegation"'));
    }
    assert.equal(fs.existsSync(join(selection.directory, "trials")), false);
    assert.equal(fs.existsSync(selection.codexAuth.temporaryRoot), false);
  });
});

test("restricted operational preparation is blocked before any input or filesystem access", async () => {
  const { prepareRestrictedIntegration } = await import("../src/restricted-integration.ts");
  const poison = new Proxy({} as any, { get() { throw new Error("PRIVATE_INPUT_READ"); } });
  assert.throws(() => prepareRestrictedIntegration(poison), /Reviewed supervisor isolation is required/);
});

test("supervisor rejects missing private inputs and revokes lifecycle on cancellation or creation failure", async t => {
  const { supervisorCampaign } = await import("../src/restricted-integration.ts");
  assert.throws(() => supervisorCampaign(undefined as any), /^Error: Invalid supervisor inputs$/);
  await fixture(t, async (selection, _guildRoot, io) => {
    for (const bank of [undefined, {}, { ...selection.bank, PRIVATE: "do not echo" }]) {
      assert.throws(() => supervisorCampaign({ ...selection, bank }), /^Error: Invalid supervisor inputs$/);
    }
    assert.equal(fs.existsSync(selection.directory), false);
    const session = supervisorCampaign(selection);
    await session.createCampaign();
    const collision = supervisorCampaign(selection);
    await assert.rejects(collision.createCampaign());
    await assert.rejects(collision.runNext(), /Supervisor lifecycle closed/);
    await assert.rejects(session.inspectSelection(AbortSignal.abort()), { name: "AbortError" });
    await assert.rejects(session.runNext(), /Supervisor lifecycle closed/);
    assert.deepEqual(io, []);
    const disposed = supervisorCampaign(selection);
    disposed.dispose(); disposed.dispose();
    await assert.rejects(disposed.createCampaign(), /Supervisor lifecycle closed/);
  });
});

test("candidate assembly requires selected 0.87.0 rather than historical runtime", async t => {
  await fixture(t, async selection => {
    const execution = assembleNativeCampaign(selection);
    await execution.inspectSelection();
    await assert.rejects(execution.runNext(), /Native campaign admission is disabled/);
    selection.runtime.piVersion = selection.runtime.aiVersion = "0.85.1";
    selection.spec.bindings.runtimeDigest = digest(selection.runtime);
    assert.throws(() => assembleNativeCampaign(selection), /Native campaign selection mismatch/);
  }, CANDIDATE_NATIVE_POLICY_V3);
});
