import assert from "node:assert/strict";
import fs from "node:fs/promises";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import { createPiDriver } from "../src/pi-driver.ts";
import { digest } from "../src/manifest.ts";
import { NATIVE_RUNTIME_PATHS } from "../src/native-input-contracts.ts";
import { readCodexAuthLease } from "../src/codex-auth.ts";

const stop = 'if (options.nativeRequestGate) throw new Error("Native request observation is disabled pending verified offline isolation and completion of execution binding");';
// Tests wiring, NOT native admission. Copy is generated from the maintained driver,
// guarded to this inert fixture, with mocked spawn/PID and process.kill boundaries.
async function fixture(t: TestContext, visit: (f: any) => Promise<void>) {
  const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "guild-driver-config-test-"));
  const spawns: any[] = [];
  const killMock = t.mock.method(process, "kill", () => true);
  const mock = t.mock.method(cp, "spawn", (...args: any[]) => {
    spawns.push(args);
    const child = Object.assign(new EventEmitter(), { pid: 2147483647, stdout: new PassThrough(), stderr: new PassThrough() });
    queueMicrotask(() => child.emit("close", 0));
    return child as any; // Synthetic PID; process.kill is mocked before spawn.
  });
  syncBuiltinESMExports();
  try {
    const guildRoot = join(root, "guild"), pi = join(root, "pi"), retentionRoot = join(root, "runs");
    const id = "00000000-0000-4000-8000-000000000001", artifactDirectory = join(retentionRoot, "trials", id), cwd = join(artifactDirectory, "repo");
    for (const dir of ["agents", "extensions", "src", "evaluation/src"]) await fs.mkdir(join(guildRoot, dir), { recursive: true });
    await fs.mkdir(join(pi, "dist"), { recursive: true }); await fs.mkdir(cwd, { recursive: true });
    for (const name of ["package.json", "package-lock.json"]) await fs.writeFile(join(guildRoot, name), "{}");
    await fs.writeFile(join(pi, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.85.1" }));
    await fs.writeFile(join(pi, "dist/cli.js"), 'throw Error("INERT_CLI_MUST_NOT_EXECUTE");');
    await fs.writeFile(join(guildRoot, "evaluation/src/native-preload.ts"), 'throw Error("INERT_PRELOAD_MUST_NOT_EXECUTE");');
    const sourceFile = join(root, "synthetic-auth.json"), expires = Math.floor(Date.now() / 1000) * 1000 + 3600000;
    const access = `header.${Buffer.from(JSON.stringify({ exp: expires / 1000, "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64url")}.synthetic-signature`;
    await fs.writeFile(sourceFile, JSON.stringify({ "openai-codex": { type: "oauth", access, refresh: "", expires, accountId: "synthetic-account" } }), { mode: 0o600 });
    const options = { approval: "explicit-model-run-approval", piEntry: join(pi, "dist/cli.js"), piPackageJson: join(pi, "package.json"), guildRoot, credentials: {},
      codexAuth: { sourceFile, temporaryRoot: root }, nativeRequestGate: { version: 1, model: "openai-codex/gpt-6-astra", api: "openai-codex-responses", serviceTier: "base", cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 } },
      nativeRuntime: { version: 1, nodePath: "/usr/bin/node", nodeVersion: "v24.20.0", platform: "linux", arch: "arm64", piVersion: "0.85.1", aiVersion: "0.85.1", hashes: NATIVE_RUNTIME_PATHS.map(path => ({ path, sha256: "1".repeat(64) })) } };
    const request = { task: { prompt: "inert task", rubric: "PRIVATE_RUBRIC_MUST_NOT_FORWARD" }, arm: "main-only", repetition: 1, cohort: { model: options.nativeRequestGate.model, thinking: "high" }, timeoutMs: 300000 };
    const context = { trialIdentity: { version: 1, id, requestDigest: digest(request) }, request, artifactDirectory, retentionRoot, cwd, signal: new AbortController().signal, emit() {}, stderr() {} };
    const sourcePath = resolve("evaluation/src/pi-driver.ts"), source = await fs.readFile(sourcePath, "utf8");
    assert.equal(source.split(stop).length, 2, "the maintained early stop must remain exact and present");
    const guard = `if (cwd !== ${JSON.stringify(cwd)} || options.piEntry !== ${JSON.stringify(options.piEntry)} || options.codexAuth?.sourceFile !== ${JSON.stringify(sourceFile)}) throw Error("inert fixture only");`;
    const copy = source.replace(stop, guard).replace(/from "(\.\/[^\"]+)"/g, (_all, path) => `from ${JSON.stringify(pathToFileURL(join(dirname(sourcePath), path)).href)}`);
    const module = join(root, "driver-copy.mts"); await fs.writeFile(module, copy);
    const factory = (await import(pathToFileURL(module).href)).createPiDriver;
    await visit({ root, options, context, factory, spawns });
  } finally { mock.mock.restore(); killMock.mock.restore(); syncBuiltinESMExports(); await fs.rm(root, { recursive: true, force: true }); }
}

test("production native stop still prevents callback, auth setup and spawn", async t => {
  await fixture(t, async ({ options, context, spawns, root }) => {
    let calls = 0;
    await assert.rejects(createPiDriver(options)({ ...context, prepareNativeLaunch: async () => { calls++; throw Error(); } }), /Native request observation is disabled/);
    assert.equal(calls, 0); assert.equal(spawns.length, 0);
    assert.equal((await fs.readdir(root)).some(name => name.startsWith("guild-codex-")), false);
  });
});

test("runtime inventory cannot silently select an unobserved driver mode", async t => {
  await fixture(t, async ({ options }) => {
    delete options.nativeRequestGate;
    assert.throws(() => createPiDriver(options), /Native runtime inventory requires native observation/);
  });
});

for (const mode of ["missing", "extra key", "preload", "config path", "config hash", "auth hash"]) test(`isolated driver copy rejects invalid configuration response: ${mode}`, async t => {
  await fixture(t, async ({ options, context, factory, spawns }) => {
    let lease: any;
    const driver = factory(options);
    await assert.rejects(driver({ ...context, prepareNativeLaunch: async (input: any) => {
      lease = input.authLease;
      const env: any = { NODE_OPTIONS: `--import=${pathToFileURL(join(options.guildRoot, "evaluation/src/native-preload.ts")).href}`,
        GUILD_EVAL_NATIVE_CONFIG: join(context.artifactDirectory, "native-config.json"), GUILD_EVAL_NATIVE_CONFIG_SHA256: "a".repeat(64), GUILD_EVAL_AUTH_DIGEST: lease.identity.fileDigest };
      if (mode === "missing") return undefined;
      if (mode === "extra key") env.HOME = "/must-not-override";
      if (mode === "preload") env.NODE_OPTIONS += " --eval=forbidden";
      if (mode === "config path") env.GUILD_EVAL_NATIVE_CONFIG += ".other";
      if (mode === "config hash") env.GUILD_EVAL_NATIVE_CONFIG_SHA256 = "bad";
      if (mode === "auth hash") env.GUILD_EVAL_AUTH_DIGEST = "b".repeat(64);
      return env;
    } }), /^Error: Native driver configuration mismatch$/);
    assert.equal(spawns.length, 0); assert.throws(() => readCodexAuthLease(lease), /lease mismatch/);
    await assert.rejects(fs.access(lease.directory));
    await assert.rejects(fs.access(join(context.artifactDirectory, "invocation.json")));
  });
});

for (const missing of ["runtime", "callback"]) test(`isolated driver copy requires ${missing} before auth setup`, async t => {
  await fixture(t, async ({ options, context, factory, spawns, root }) => {
    if (missing === "runtime") delete options.nativeRuntime;
    const driver = factory(options);
    await assert.rejects(driver({ ...context, ...(missing === "callback" ? {} : { prepareNativeLaunch: async () => { throw Error("must not call"); } }) }), /Native driver configuration unavailable/);
    assert.equal(spawns.length, 0); assert.equal((await fs.readdir(root)).some(name => name.startsWith("guild-codex-")), false);
  });
});

for (const mode of ["throw", "dispose", "cancel"]) test(`isolated driver copy stops and cleans the original lease after callback ${mode}`, async t => {
  await fixture(t, async ({ options, context, factory, spawns }) => {
    let lease: any; const controller = new AbortController();
    await assert.rejects(factory(options)({ ...context, signal: controller.signal, prepareNativeLaunch: async (input: any) => {
      lease = input.authLease;
      if (mode === "throw") throw Error("synthetic preparation failure");
      if (mode === "dispose") await lease.dispose();
      if (mode === "cancel") controller.abort();
      return { NODE_OPTIONS: `--import=${pathToFileURL(join(options.guildRoot, "evaluation/src/native-preload.ts")).href}`,
        GUILD_EVAL_NATIVE_CONFIG: join(context.artifactDirectory, "native-config.json"), GUILD_EVAL_NATIVE_CONFIG_SHA256: "a".repeat(64), GUILD_EVAL_AUTH_DIGEST: lease.identity.fileDigest };
    } }), mode === "throw" ? /synthetic preparation failure/ : mode === "dispose" ? /lease mismatch/ : /abort/i);
    assert.equal(spawns.length, 0); assert.throws(() => readCodexAuthLease(lease), /lease mismatch/);
    await assert.rejects(fs.access(lease.directory));
  });
});

test("isolated driver copy forwards exact invocation, original scoped lease and config environment", async t => {
  await fixture(t, async ({ options, context, factory, spawns }) => {
    const runtime = structuredClone(options.nativeRuntime), driver = factory(options);
    options.nativeRuntime.hashes[0].sha256 = "2".repeat(64);
    let calls = 0, lease: any, environment: any;
    const result = await driver({ ...context, prepareNativeLaunch: async (input: any) => {
      calls++; lease = input.authLease;
      const observed = readCodexAuthLease(lease, { timeoutMs: context.request.timeoutMs, forbiddenRoots: [dirname(context.artifactDirectory), context.retentionRoot, context.cwd, options.guildRoot] });
      assert.deepEqual(input.runtime, runtime); assert.equal(input.guildRoot, options.guildRoot);
      assert.deepEqual(input.invocation.trialIdentity, context.trialIdentity); assert.equal(input.invocation.cwd, context.cwd);
      assert.equal(input.invocation.command, process.execPath); assert.equal(input.invocation.args.at(-1), context.request.task.prompt);
      assert.doesNotMatch(JSON.stringify(input.invocation), /PRIVATE_RUBRIC_MUST_NOT_FORWARD/);
      environment = { NODE_OPTIONS: `--import=${pathToFileURL(join(options.guildRoot, "evaluation/src/native-preload.ts")).href}`,
        GUILD_EVAL_NATIVE_CONFIG: join(context.artifactDirectory, "native-config.json"), GUILD_EVAL_NATIVE_CONFIG_SHA256: "a".repeat(64), GUILD_EVAL_AUTH_DIGEST: observed.identity.fileDigest };
      input.invocation.args.push("must-not-change-spawn");
      return environment; // Callback double: no configuration issuance or producer run.
    } });
    assert.equal(result.exitCode, 0); assert.equal(calls, 1); assert.equal(spawns.length, 1);
    assert.equal(spawns[0][1].at(-1), context.request.task.prompt);
    for (const [key, value] of Object.entries(environment)) assert.equal(spawns[0][2].env[key], value);
    const record = JSON.parse(await fs.readFile(join(context.artifactDirectory, "invocation.json"), "utf8"));
    assert.deepEqual(record.nativeEnvironment, environment);
    // Mocked PID/config wiring only; this is not a native launch or receipt.
    assert.equal(result.supervisor.parentPid, 2147483647);
    assert.equal(result.supervisor.configurationSha256, environment.GUILD_EVAL_NATIVE_CONFIG_SHA256);
    assert.equal(result.supervisor.invocationDigest, digest({ version: 1, trialIdentity: context.trialIdentity,
      command: spawns[0][0], args: spawns[0][1], cwd: context.cwd }));
    assert.throws(() => readCodexAuthLease(lease), /lease mismatch/);
    await assert.rejects(fs.access(lease.directory));
  });
});
