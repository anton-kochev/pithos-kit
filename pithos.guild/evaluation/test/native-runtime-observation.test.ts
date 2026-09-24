import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { loadDevelopmentBank } from "../src/bank.ts";
import { digest } from "../src/manifest.ts";
import { createSchedule } from "../src/runner.ts";
import { CANDIDATE_NATIVE_POLICY_V3, NATIVE_POLICY_V1 } from "../src/native-policy.ts";
import { bindNativeTrial } from "../src/native-trial-binding.ts";
import { snapshotRuntime } from "../src/offline-runtime.ts";
import { bindNativeRuntimeRequirement, observeNativeRuntime } from "../src/native-runtime-observation.ts";

function inputs(arm: "main-only" | "guild-available" = "main-only") {
  const bytes = new Map<string, Buffer>();
  const runtime = snapshotRuntime({ nodePath: "/usr/bin/node", nodeVersion: "v24.20.0", platform: "linux", arch: "arm64", read(path) {
    const data = Buffer.from(path.endsWith("package.json") ? JSON.stringify({ name: path.includes("/pi-ai/") ? "@earendil-works/pi-ai" : "@earendil-works/pi-coding-agent", version: "0.85.1" }) : `inert bytes ${bytes.size}`);
    bytes.set(path, data); return data;
  } });
  const bank = loadDevelopmentBank(), schedule = createSchedule(bank, 1, "native-runtime-observation");
  const slot = schedule.findIndex(s => s.arm === arm), scheduled = schedule[slot];
  const spec = { version: 2 as const, nativePolicy: structuredClone(NATIVE_POLICY_V1),
    bindings: { bankDigest: digest(bank), scheduleDigest: digest(schedule), implementationDigest: digest("inert implementation"),
      runtimeDigest: digest(runtime), policyDigest: digest("inert policy"), model: "openai-codex/gpt-6-astra", thinking: "high" },
    schedule, limits: { maxTrials: 12, estimatedUsd: 10, activeMs: 3600000, workflowMs: 300000 },
    pricing: { version: 1 as const, model: "openai-codex/gpt-6-astra", api: "openai-codex-responses", serviceTier: "base" as const,
      cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 } } };
  const id = "00000000-0000-4000-8000-000000000001";
  const admission = { id, slot, scheduled: structuredClone(scheduled), allowanceMs: 300000, activeAllowanceMs: 3600000 };
  const request = { task: structuredClone(bank.tasks.find(t => t.id === scheduled.taskId)!), arm, repetition: 1,
    cohort: { model: spec.bindings.model, thinking: spec.bindings.thinking }, timeoutMs: spec.limits.workflowMs };
  const artifactDirectory = `/campaign/trials/${id}`;
  return { runtime, bytes, input: { spec, bank, admission, request, trialIdentity: { version: 1 as const, id, requestDigest: digest(request) },
    retentionRoot: "/campaign", artifactDirectory, cwd: `${artifactDirectory}/repo` } };
}

test("rejects unsupported or incomplete runtime inventories even with a recomputed campaign digest", () => {
  for (const change of [
    (r: any) => r.version++, (r: any) => r.nodeVersion = "v24.21.0", (r: any) => r.nodePath = "/other/node",
    (r: any) => r.piVersion = "0.85.2", (r: any) => r.aiVersion = "0.83.0", (r: any) => r.platform = "darwin", (r: any) => r.arch = "x64",
    (r: any) => r.hashes.pop(), (r: any) => r.hashes.reverse(), (r: any) => r.hashes.push(r.hashes[0]),
    (r: any) => r.hashes[1] = r.hashes[0], (r: any) => r.hashes[0].path = "/PRIVATE_SOURCE_MUST_NOT_LEAK",
    (r: any) => r.hashes[0].sha256 = "bad", (r: any) => r.hashes[0].sha256 = r.hashes[0].sha256.toUpperCase(),
    (r: any) => r.hashes[0].extra = true, (r: any) => r.extra = true, (r: any) => delete r.arch,
  ]) {
    const { runtime, input } = inputs(); change(runtime); input.spec.bindings.runtimeDigest = digest(runtime);
    assert.throws(() => bindNativeRuntimeRequirement(input, runtime), /^Error: Native runtime binding mismatch$/);
  }
});

// Only filesystem edges are substituted. Hashing, trial binding and observation
// execute normally against inert files; no installed runtime or procfs is read.
async function runtimeFixture(t: TestContext, action: (f: ReturnType<typeof inputs> & {
  files: Map<string, string>; io: string[]; kernel: { path: string; file: string };
  write: (path: string, data: string | Buffer) => void;
  hooks: { beforeOpen?: (path: string) => void; opened?: (path: string, fd: number) => void };
}) => void) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "guild-runtime-observation-test-")), f = inputs();
  const files = new Map<string, string>(), io: string[] = [];
  for (const [path, bytes] of f.bytes) { const file = join(root, String(files.size)); await writeFile(file, bytes, { mode: 0o600 }); files.set(path, file); }
  const kernel = { path: "/usr/bin/node", file: files.get("/usr/bin/node")! };
  const properties = ["execPath", "version", "platform", "arch"] as const;
  const descriptors = properties.map(key => Object.getOwnPropertyDescriptor(process, key)!);
  const tuple = { execPath: "/usr/bin/node", version: "v24.20.0", platform: "linux", arch: "arm64" };
  const mocks: { mock: { restore(): void } }[] = [];
  const open = fs.openSync, lstat = fs.lstatSync, stat = fs.statSync;
  const hooks: { beforeOpen?: (path: string) => void; opened?: (path: string, fd: number) => void } = {};
  const write = (path: string, data: string | Buffer) => {
    assert.ok(files.has(path));
    const fd = open(files.get(path)!, "w", 0o600);
    try { fs.writeFileSync(fd, data); } finally { fs.closeSync(fd); }
  };
  const mapped = (path: any) => { io.push(String(path)); assert.ok(files.has(path), `Unexpected input: ${String(path)}`); return files.get(path)!; };
  try {
    properties.forEach((key, i) => Object.defineProperty(process, key, { ...descriptors[i], value: tuple[key] }));
    mocks.push(t.mock.method(fs, "realpathSync", (path: any) => { mapped(path); return path; }));
    mocks.push(t.mock.method(fs, "lstatSync", (path: any, options: any) => (lstat as any)(mapped(path), options)));
    mocks.push(t.mock.method(fs, "openSync", (path: any, ...args: any[]) => {
      const file = mapped(path); hooks.beforeOpen?.(path);
      const fd = (open as any)(file, ...args); hooks.opened?.(path, fd); return fd;
    }));
    mocks.push(t.mock.method(fs, "readlinkSync", (path: any) => { io.push(String(path)); assert.equal(path, "/proc/self/exe"); return kernel.path; }));
    mocks.push(t.mock.method(fs, "statSync", (path: any, options: any) => { io.push(String(path)); assert.equal(path, "/proc/self/exe"); return (stat as any)(kernel.file, options); }));
    action({ ...f, files, io, kernel, write, hooks });
  } finally {
    mocks.reverse().forEach(m => m.mock.restore());
    properties.forEach((key, i) => Object.defineProperty(process, key, descriptors[i]));
    await rm(root, { recursive: true, force: true });
  }
}

test("observes selected runtime bytes and correlates the current executable with the trial requirement", async t => {
  await runtimeFixture(t, ({ runtime, input, io }) => {
    const requirement = bindNativeRuntimeRequirement(input, runtime), observed = observeNativeRuntime(requirement);
    assert.equal(observed.kind, "native-runtime-file-observation");
    assert.equal(observed.trialId, input.admission.id);
    assert.equal(observed.requirementDigest, digest(requirement));
    assert.equal(observed.files.files.length, 13);
    assert.equal(observed.process.pid, process.pid); assert.equal(observed.process.ppid, process.ppid);
    assert.equal(observed.process.nodeVersion, "v24.20.0"); assert.equal(observed.process.nodePath, "/usr/bin/node");
    assert.deepEqual(observed.process.executable, { dev: observed.files.files[0].dev, ino: observed.files.files[0].ino });
    assert.ok(io.includes("/proc/self/exe"));
    assert.ok(runtime.hashes.every(h => io.includes(h.path)));
    assert.ok(Object.isFrozen(observed) && Object.isFrozen(observed.process) && Object.isFrozen(observed.process.executable));
    assert.doesNotMatch(JSON.stringify(observed), /rubric|allowedChanges|\/campaign/);
  });
});

test("rejects a loaded executable inode different from the selected Node file", async t => {
  await runtimeFixture(t, ({ runtime, input, files, kernel }) => {
    kernel.file = files.get(runtime.hashes[1].path)!;
    assert.throws(() => observeNativeRuntime(bindNativeRuntimeRequirement(input, runtime)), /^Error: Native runtime observation mismatch$/);
  });
});

test("rechecks executable identity after selected-file reads", async t => {
  await runtimeFixture(t, ({ runtime, input, files, kernel }) => {
    const requirement = bindNativeRuntimeRequirement(input, runtime), read = fs.readSync;
    const mock = t.mock.method(fs, "readSync", (...args: any[]) => {
      kernel.file = files.get(runtime.hashes[1].path)!; return (read as any)(...args);
    });
    try { assert.throws(() => observeNativeRuntime(requirement), /^Error: Native runtime observation mismatch$/); }
    finally { mock.mock.restore(); }
  });
});

test("rejects malformed or unbound producer requirements before any filesystem access", async t => {
  await runtimeFixture(t, ({ runtime, input, io }) => {
    const good = bindNativeRuntimeRequirement(input, runtime);
    for (const change of [
      (r: any) => r.version++, (r: any) => r.kind = "approved", (r: any) => r.trialId = "bad",
      (r: any) => r.trialBindingDigest = "bad", (r: any) => r.runtimeDigest = "0".repeat(64),
      (r: any) => r.extra = true, (r: any) => r.bank = { rubric: "PRIVATE_RUBRIC_MUST_NOT_LEAK" },
      (r: any) => r.runtime.hashes.pop(), (r: any) => r.runtime.hashes[0].extra = true,
    ]) {
      const bad = structuredClone(good); change(bad);
      assert.throws(() => observeNativeRuntime(bad), /^Error: Native runtime observation mismatch$/);
      assert.deepEqual(io, []);
    }
  });
});

test("pins campaign runtime digest and trial checks at requirement creation", () => {
  for (const drift of ["runtime", "trial"]) {
    const { runtime, input } = inputs();
    if (drift === "runtime") input.spec.bindings.runtimeDigest = "0".repeat(64);
    else input.request.task.prompt += " changed";
    assert.throws(() => bindNativeRuntimeRequirement(input, runtime), /^Error: Native runtime binding mismatch$/);
  }
});

test("rejects process tuple drift without substituting another runtime", async t => {
  for (const [key, value] of [["execPath", "/other/node"], ["version", "v24.19.0"], ["platform", "darwin"], ["arch", "x64"]]) {
    await runtimeFixture(t, ({ runtime, input }) => {
      Object.defineProperty(process, key, { configurable: true, value });
      assert.throws(() => observeNativeRuntime(bindNativeRuntimeRequirement(input, runtime)), /^Error: Native runtime observation mismatch$/, key);
    });
  }
});

test("rejects alternate and deleted kernel executable paths", async t => {
  for (const path of ["/other/node", "/usr/bin/node (deleted)"]) await runtimeFixture(t, ({ runtime, input, kernel }) => {
    kernel.path = path;
    assert.throws(() => observeNativeRuntime(bindNativeRuntimeRequirement(input, runtime)), /^Error: Native runtime observation mismatch$/);
  });
});

test("rejects actual selected CLI byte drift through the filesystem observer", async t => {
  await runtimeFixture(t, ({ runtime, input, files }) => {
    const requirement = bindNativeRuntimeRequirement(input, runtime);
    fs.writeFileSync(files.get(runtime.hashes[2].path)!, "changed inert CLI bytes");
    assert.throws(() => observeNativeRuntime(requirement), /^Error: Native runtime observation mismatch$/);
  });
});

test("rejects wrong actual package identities despite matching supplied hashes and version declarations", async t => {
  for (const index of [1, 10]) for (const change of ["name", "version"]) await runtimeFixture(t, ({ runtime, input, files, bytes }) => {
    const entry = runtime.hashes[index], data = JSON.parse(bytes.get(entry.path)!.toString("utf8"));
    data[change] = change === "name" ? "UNREVIEWED_PACKAGE" : "0.85.2";
    const raw = JSON.stringify(data);
    fs.writeFileSync(files.get(entry.path)!, raw);
    entry.sha256 = createHash("sha256").update(raw).digest("hex");
    input.spec.bindings.runtimeDigest = digest(runtime);
    assert.throws(() => observeNativeRuntime(bindNativeRuntimeRequirement(input, runtime)), /^Error: Native runtime observation mismatch$/);
  });
});

test("returns only verified package identities, not unrelated package fields", async t => {
  await runtimeFixture(t, ({ runtime, input, files, bytes }) => {
    const entry = runtime.hashes[1], data = JSON.parse(bytes.get(entry.path)!.toString("utf8"));
    data.unrelated = "PACKAGE_METADATA_MUST_NOT_RETAIN";
    const raw = JSON.stringify(data); fs.writeFileSync(files.get(entry.path)!, raw);
    entry.sha256 = createHash("sha256").update(raw).digest("hex"); input.spec.bindings.runtimeDigest = digest(runtime);
    const observed = observeNativeRuntime(bindNativeRuntimeRequirement(input, runtime));
    assert.deepEqual(observed.packages, [
      { id: "runtime/file-1", name: "@earendil-works/pi-coding-agent", version: "0.85.1" },
      { id: "runtime/file-10", name: "@earendil-works/pi-ai", version: "0.85.1" },
    ]);
    assert.ok(Object.isFrozen(observed.packages) && observed.packages.every(Object.isFrozen));
    assert.doesNotMatch(JSON.stringify(observed), /PACKAGE_METADATA_MUST_NOT_RETAIN/);
  });
});

test("rejects malformed or non-UTF-8 package JSON with sanitized errors", async t => {
  const invalidUtf8 = Buffer.concat([Buffer.from('{"name":"@earendil-works/pi-coding-agent","version":"0.85.1","extra":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  for (const raw of [Buffer.from("null"), Buffer.from("[]"), Buffer.from("{}"), Buffer.from('{"PRIVATE_METADATA_MUST_NOT_LEAK'), invalidUtf8]) {
    await runtimeFixture(t, ({ runtime, input, write }) => {
      const entry = runtime.hashes[1]; write(entry.path, raw);
      entry.sha256 = createHash("sha256").update(raw).digest("hex"); input.spec.bindings.runtimeDigest = digest(runtime);
      assert.throws(() => observeNativeRuntime(bindNativeRuntimeRequirement(input, runtime)), /^Error: Native runtime observation mismatch$/);
    });
  }
});

test("admits a 64 KiB package document and rejects one byte more", async t => {
  for (const size of [65536, 65537]) await runtimeFixture(t, ({ runtime, input, write, bytes }) => {
    const entry = runtime.hashes[1], base = bytes.get(entry.path)!;
    const raw = Buffer.concat([base, Buffer.alloc(size - base.length, 32)]);
    write(entry.path, raw);
    entry.sha256 = createHash("sha256").update(raw).digest("hex"); input.spec.bindings.runtimeDigest = digest(runtime);
    const requirement = bindNativeRuntimeRequirement(input, runtime);
    if (size === 65536) assert.equal(observeNativeRuntime(requirement).packages.length, 2);
    else assert.throws(() => observeNativeRuntime(requirement), /^Error: Native runtime observation mismatch$/);
  });
});

for (const mode of ["replace-before-open", "rewrite-before-open", "replace-during-read"]) test(`binds semantic package reads to selected evidence: ${mode}`, async t => {
  await runtimeFixture(t, ({ runtime, input, files, bytes, write, hooks }) => {
    const entry = runtime.hashes[1], file = files.get(entry.path)!, raw = bytes.get(entry.path)!;
    const requirement = bindNativeRuntimeRequirement(input, runtime), read = fs.readSync;
    let opens = 0, packageFd: number | undefined, changed = false;
    const change = () => {
      changed = true;
      if (mode === "rewrite-before-open") {
        const data = JSON.parse(raw.toString("utf8"));
        write(entry.path, JSON.stringify({ version: data.version, name: data.name }));
      } else { fs.renameSync(file, file + ".old"); write(entry.path, raw); }
    };
    hooks.beforeOpen = path => { if (path === entry.path && ++opens === 2 && mode !== "replace-during-read") change(); };
    hooks.opened = (path, fd) => { if (path === entry.path && opens === 2) packageFd = fd; };
    const reading = t.mock.method(fs, "readSync", (...args: any[]) => {
      if (mode === "replace-during-read" && args[0] === packageFd && !changed) change();
      return (read as any)(...args);
    });
    try {
      assert.throws(() => observeNativeRuntime(requirement), /^Error: Native runtime observation mismatch$/);
      assert.equal(changed, true); assert.notEqual(packageFd, undefined);
      assert.throws(() => fs.fstatSync(packageFd!), { code: "EBADF" });
    } finally {
      reading.mock.restore();
      if (packageFd !== undefined) { try { fs.closeSync(packageFd); } catch {} }
    }
  });
});

test("closes the semantic-read descriptor after invalid package JSON", async t => {
  await runtimeFixture(t, ({ runtime, input, write, hooks }) => {
    const entry = runtime.hashes[1], raw = '{"PRIVATE_PARSE_DIAGNOSTIC';
    write(entry.path, raw); entry.sha256 = createHash("sha256").update(raw).digest("hex"); input.spec.bindings.runtimeDigest = digest(runtime);
    let opens = 0, packageFd: number | undefined;
    hooks.opened = (path, fd) => { if (path === entry.path && ++opens === 2) packageFd = fd; };
    try {
      assert.throws(() => observeNativeRuntime(bindNativeRuntimeRequirement(input, runtime)), /^Error: Native runtime observation mismatch$/);
      assert.notEqual(packageFd, undefined);
      assert.throws(() => fs.fstatSync(packageFd!), { code: "EBADF" });
    } finally { if (packageFd !== undefined) { try { fs.closeSync(packageFd); } catch {} } }
  });
});

test("binds frozen runtime inputs without distributing the bank, rubric or task to producers", () => {
  for (const arm of ["main-only", "guild-available"] as const) {
    const { runtime, input } = inputs(arm), requirement = bindNativeRuntimeRequirement(input, runtime);
    assert.deepEqual(requirement, { version: 1, kind: "native-runtime-input-requirement", trialId: input.admission.id,
      trialBindingDigest: digest(bindNativeTrial(input)), runtimeDigest: input.spec.bindings.runtimeDigest, runtime });
    assert.ok(Object.isFrozen(requirement) && Object.isFrozen(requirement.runtime) && Object.isFrozen(requirement.runtime.hashes)
      && requirement.runtime.hashes.every(Object.isFrozen));
    assert.doesNotMatch(JSON.stringify(requirement), /"(?:rubric|prompt|allowedChanges)"\s*:|\/campaign/);
    runtime.hashes[0].sha256 = "0".repeat(64);
    assert.notEqual(requirement.runtime.hashes[0].sha256, runtime.hashes[0].sha256);
  }
});

test("runtime binding derives the new requirement revision only from candidate policy v3", () => {
  const { runtime, input } = inputs();
  const migrated = { ...input, spec: { ...input.spec, nativePolicy: CANDIDATE_NATIVE_POLICY_V3 } };
  assert.throws(() => bindNativeRuntimeRequirement(migrated, runtime), /Native runtime binding mismatch/);
  runtime.piVersion = runtime.aiVersion = "0.87.0";
  migrated.spec.bindings.runtimeDigest = digest(runtime);
  const requirement = bindNativeRuntimeRequirement(migrated, runtime);
  assert.equal(requirement.version, 2);
  assert.equal(requirement.runtime.piVersion, "0.87.0");
  assert.throws(() => bindNativeRuntimeRequirement(input, runtime), /Native runtime binding mismatch/);
});

test("candidate observer verifies synthetic 0.87.0 package bytes and rejects rehashed old metadata", async t => {
  await runtimeFixture(t, ({ runtime, input, write }) => {
    const migrated = { ...input, spec: { ...input.spec, nativePolicy: CANDIDATE_NATIVE_POLICY_V3 } };
    runtime.piVersion = runtime.aiVersion = "0.87.0";
    for (const index of [1, 10]) {
      const entry = runtime.hashes[index];
      const raw = JSON.stringify({ name: index === 1 ? "@earendil-works/pi-coding-agent" : "@earendil-works/pi-ai", version: "0.87.0" });
      write(entry.path, raw); entry.sha256 = createHash("sha256").update(raw).digest("hex");
    }
    migrated.spec.bindings.runtimeDigest = digest(runtime);
    const observed = observeNativeRuntime(bindNativeRuntimeRequirement(migrated, runtime));
    assert.deepEqual(observed.packages.map(p => p.version), ["0.87.0", "0.87.0"]);
    const old = JSON.stringify({ name: "@earendil-works/pi-ai", version: "0.85.1" });
    write(runtime.hashes[10].path, old); runtime.hashes[10].sha256 = createHash("sha256").update(old).digest("hex");
    migrated.spec.bindings.runtimeDigest = digest(runtime);
    assert.throws(() => observeNativeRuntime(bindNativeRuntimeRequirement(migrated, runtime)), /Native runtime observation mismatch/);
  });
});
