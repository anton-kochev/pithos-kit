import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { prepareNativeLaunch } from "../src/native-launch.ts";
import { captureScopedAuth } from "../src/scoped-auth-identity.ts";
import { pathToFileURL } from "node:url";
import { digest } from "../src/manifest.ts";
import { NATIVE_RUNTIME_PATHS } from "../src/native-input-contracts.ts";

// Configuration-writer fixture only, not a ledger-issued native admission.
function binding() {
  return { version: 1 as const, kind: "native-campaign-input-binding" as const, trialId: "00000000-0000-4000-8000-000000000001",
    campaignDigest: "a".repeat(64), historyDigest: "b".repeat(64), admissionDigest: "c".repeat(64), trialBindingDigest: "d".repeat(64), invocationDigest: "e".repeat(64), runtimeRequirementDigest: "f".repeat(64), runtimeRequirementSha256: "1".repeat(64) };
}
function auth() {
  const expires = Math.floor(Date.now() / 1000) * 1000 + 3600000, accountId = "ACCOUNT_MUST_NOT_RETAIN";
  const claims = { exp: expires / 1000, "https://api.openai.com/auth": { chatgpt_account_id: accountId } };
  return JSON.stringify({ "openai-codex": { type: "oauth", access: `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.synthetic-signature`, refresh: "", expires, accountId } });
}

test("snapshots launch inputs before asynchronous preparation", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "guild-native-input-test-"));
  try {
    const agent = join(root, "agent"); await mkdir(agent, { mode: 0o700 });
    await writeFile(join(agent, "auth.json"), auth(), { mode: 0o600 });
    const options = { artifactDirectory: root, agent, cwd: "/original", guildRoot: "/guild", piEntry: "/pi/dist/cli.js", pricing: structuredClone(pricing), arm: "main-only" as const };
    const pending = prepareNativeLaunch(options);
    options.cwd = "/mutated"; options.guildRoot = "/mutated"; options.pricing.cost.input++;
    const env = await pending, config = JSON.parse(await readFile(env.GUILD_EVAL_NATIVE_CONFIG, "utf8"));
    assert.equal(config.cwd, "/original"); assert.deepEqual(config.pricing, pricing);
    assert.match(env.NODE_OPTIONS, /file:\/\/\/guild\//);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects auth drift during preparation without deleting partial launch evidence", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "guild-native-auth-drift-test-"));
  try {
    const agent = join(root, "agent"), file = join(agent, "auth.json"), raw = auth();
    await mkdir(agent, { mode: 0o700 }); await writeFile(file, raw, { mode: 0o600 });
    const pending = prepareNativeLaunch({ artifactDirectory: root, agent, cwd: "/fixture", guildRoot: "/guild", piEntry: "/pi/dist/cli.js", pricing, arm: "main-only" });
    fs.writeFileSync(file, raw + " ");
    await assert.rejects(pending, /^Error: Scoped Codex authentication mismatch$/);
    assert.equal(await readFile(file, "utf8"), raw + " ");
    assert.ok(await stat(join(root, "native-config.json")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const mode of ["mismatched auth", "unsupported bound config", "unsupported migrated bound config", "changed CLI selector", "missing config digest", "missing config path"]) test(`preload rejects ${mode} before the inert SDK import boundary`, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "guild-native-auth-boundary-test-"));
  try {
    const agent = join(root, "agent"), cli = join(root, "dist/cli.js");
    await mkdir(agent, { mode: 0o700 }); await mkdir(join(root, "dist/core"), { recursive: true });
    await writeFile(join(agent, "auth.json"), auth(), { mode: 0o600 });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.85.1", type: "module" }));
    await writeFile(cli, 'console.log("CLI_MUST_NOT_EXECUTE");');
    // Inert tripwire only: no SDK, provider, network or model implementation.
    await writeFile(join(root, "dist/core/agent-session.js"), 'console.log("IMPORT_BOUNDARY_REACHED"); throw Error("inert tripwire");');
    const env = await prepareNativeLaunch({ artifactDirectory: root, agent, cwd: root, guildRoot: resolve("."), piEntry: cli, pricing, arm: "main-only" });
    const config = JSON.parse(await readFile(env.GUILD_EVAL_NATIVE_CONFIG, "utf8"));
    if (mode === "mismatched auth") config.scopedAuthIdentity.ino += "0";
    else if (mode.includes("bound config")) {
      // Valid input-only fixture, not an issued native admission. No installed file reads.
      const runtime = { version: 1, nodePath: "/usr/bin/node", nodeVersion: "v24.20.0", platform: "linux", arch: "arm64", piVersion: "0.85.1", aiVersion: "0.85.1",
        hashes: NATIVE_RUNTIME_PATHS.map(path => ({ path, sha256: "1".repeat(64) })) };
      const migrated = mode === "unsupported migrated bound config";
      if (migrated) runtime.piVersion = runtime.aiVersion = "0.87.0";
      const b = binding(), requirement = { version: migrated ? 2 : 1, kind: "native-runtime-input-requirement", trialId: b.trialId, trialBindingDigest: b.trialBindingDigest, runtimeDigest: digest(runtime), runtime };
      const raw = JSON.stringify(requirement) + "\n", sibling = join(root, "runtime-requirement.json");
      await writeFile(sibling, raw, { mode: 0o600 });
      config.admissionBinding = { ...b, runtimeRequirementDigest: digest(requirement), runtimeRequirementSha256: createHash("sha256").update(raw).digest("hex") };
      const probe = join(root, "read-boundary.mjs");
      await writeFile(probe, `import fs from "node:fs";
        const open = fs.openSync;
        fs.openSync = (file, ...args) => {
          if (file === ${JSON.stringify(sibling)}) console.log("RUNTIME_REQUIREMENT_READ");
          if (String(file).startsWith("/opt/pi-npm/") || file === "/usr/bin/node") { console.log("FORBIDDEN_RUNTIME_OBSERVATION"); throw Error(); }
          return open(file, ...args);
        };
        const link = fs.readlinkSync;
        fs.readlinkSync = (file, ...args) => { if (file === "/proc/self/exe") { console.log("FORBIDDEN_RUNTIME_OBSERVATION"); throw Error(); } return link(file, ...args); };
        await import(${JSON.stringify(pathToFileURL(resolve("evaluation/src/native-preload.ts")).href)});`);
      env.NODE_OPTIONS = `--import=${pathToFileURL(probe).href}`;
    }
    else if (mode === "changed CLI selector") config.piEntry += ".different";
    const raw = JSON.stringify(config);
    await writeFile(env.GUILD_EVAL_NATIVE_CONFIG, raw);
    // Preserve the auth/unsupported-config checks independently of byte correlation.
    if (mode === "mismatched auth" || mode.includes("bound config")) env.GUILD_EVAL_NATIVE_CONFIG_SHA256 = createHash("sha256").update(raw).digest("hex");
    const child = spawnSync(process.execPath, [cli], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH, HOME: agent, TMPDIR: agent, PI_CODING_AGENT_DIR: agent, ...env,
      GUILD_EVAL_NATIVE_CONFIG: mode === "missing config path" ? undefined : env.GUILD_EVAL_NATIVE_CONFIG,
      GUILD_EVAL_NATIVE_CONFIG_SHA256: mode === "missing config digest" ? undefined : env.GUILD_EVAL_NATIVE_CONFIG_SHA256 } });
    assert.notEqual(child.status, 0); assert.match(child.stderr, /Native observation initialization failed/);
    assert.doesNotMatch(child.stdout, /IMPORT_BOUNDARY_REACHED|CLI_MUST_NOT_EXECUTE|FORBIDDEN_RUNTIME_OBSERVATION/);
    if (mode.includes("bound config")) assert.match(child.stdout, /RUNTIME_REQUIREMENT_READ/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects malformed scoped auth before creating launch artifacts", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "guild-native-invalid-auth-test-"));
  try {
    const agent = join(root, "agent"), artifacts = join(root, "artifacts");
    await mkdir(agent, { mode: 0o700 }); await mkdir(artifacts);
    await writeFile(join(agent, "auth.json"), "{}", { mode: 0o600 });
    await assert.rejects(prepareNativeLaunch({ artifactDirectory: artifacts, agent, cwd: "/fixture", guildRoot: "/guild", piEntry: "/pi/dist/cli.js", pricing, arm: "main-only" }), /^Error: Scoped Codex authentication mismatch$/);
    assert.deepEqual(await readdir(artifacts), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const drift of ["bytes", "inode"]) test(`configuration preparation cannot rebase expected auth identity after ${drift} drift`, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "guild-native-expected-auth-test-"));
  try {
    const agent = join(root, "agent"), artifacts = join(root, "artifacts"), file = join(agent, "auth.json");
    await mkdir(agent, { mode: 0o700 }); await mkdir(artifacts);
    const raw = auth(); await writeFile(file, raw, { mode: 0o600 });
    const scopedAuthIdentity = captureScopedAuth(file, 0);
    if (drift === "bytes") await writeFile(file, raw + " ");
    else { await fs.promises.rename(file, file + ".old"); await writeFile(file, raw, { mode: 0o600 }); }
    await assert.rejects(prepareNativeLaunch({ artifactDirectory: artifacts, agent, scopedAuthIdentity, cwd: "/fixture", guildRoot: "/guild", piEntry: "/pi/dist/cli.js", pricing, arm: "main-only" }), /^Error: Scoped Codex authentication mismatch$/);
    assert.deepEqual(await readdir(artifacts), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("retains closed digest-only campaign input correlation in configuration", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "guild-native-binding-config-test-"));
  try {
    const agent = join(root, "agent"); await mkdir(agent, { mode: 0o700 });
    await writeFile(join(agent, "auth.json"), auth(), { mode: 0o600 });
    const admissionBinding = binding();
    const env = await prepareNativeLaunch({ artifactDirectory: root, agent, cwd: "/fixture", guildRoot: "/guild", piEntry: "/pi/dist/cli.js", pricing, arm: "main-only", admissionBinding, scopedAuthIdentity: captureScopedAuth(join(agent, "auth.json"), 0) });
    assert.deepEqual(JSON.parse(await readFile(env.GUILD_EVAL_NATIVE_CONFIG, "utf8")).admissionBinding, admissionBinding);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects malformed or unanchored campaign binding metadata before writing configuration", async () => {
  const unanchored = binding();
  for (const bad of [undefined, {}, { ...binding(), bank: "PRIVATE_BANK_MUST_NOT_RETAIN" },
    { ...binding(), version: 2 }, { ...binding(), kind: "unapproved" }, { ...binding(), trialId: "wrong" },
    { ...binding(), historyDigest: "wrong" }, unanchored]) {
    const root = await mkdtemp(join(await realpath(tmpdir()), "guild-native-invalid-binding-test-"));
    try {
      const agent = join(root, "agent"), artifacts = join(root, "artifacts"); await mkdir(agent, { mode: 0o700 }); await mkdir(artifacts);
      await writeFile(join(agent, "auth.json"), auth(), { mode: 0o600 });
      await assert.rejects(prepareNativeLaunch({ artifactDirectory: artifacts, agent, cwd: "/fixture", guildRoot: "/guild", piEntry: "/pi/dist/cli.js", pricing, arm: "main-only", admissionBinding: bad as any,
        ...(bad === unanchored ? {} : { scopedAuthIdentity: captureScopedAuth(join(agent, "auth.json"), 0) }) }), /^Error: Native launch binding mismatch$/);
      assert.deepEqual(await readdir(artifacts), []);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("rejects oversized UTF8 configuration before artifacts are created", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "guild-config-write-bound-test-"));
  try {
    const agent = join(root, "agent"), artifacts = join(root, "artifacts"); await mkdir(agent, { mode: 0o700 }); await mkdir(artifacts);
    await writeFile(join(agent, "auth.json"), auth(), { mode: 0o600 });
    await assert.rejects(prepareNativeLaunch({ artifactDirectory: artifacts, agent, cwd: "/" + "é".repeat(32768), guildRoot: "/guild", piEntry: "/pi/dist/cli.js", pricing, arm: "main-only" }), /^Error: Native configuration size mismatch$/);
    assert.deepEqual(await readdir(artifacts), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

const pricing = { version: 1 as const, model: "openai-codex/gpt-6-astra", api: "openai-codex-responses", serviceTier: "base" as const, cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 } };

test("the inherited preload ignores non-Pi tools and fails closed before an unverified CLI executes", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "guild-native-preload-test-"));
  try {
    const artifacts = join(root, "artifacts"), agent = join(root, "agent"), cli = join(root, "dist/cli.js");
    await mkdir(artifacts); await mkdir(agent, { mode: 0o700 }); await mkdir(join(root, "dist"));
    await writeFile(join(agent, "auth.json"), auth(), { mode: 0o600 });
    await writeFile(cli, 'console.log("must-not-execute");');
    const env = await prepareNativeLaunch({ artifactDirectory: artifacts, agent, cwd: root, guildRoot: resolve("."), piEntry: cli, pricing, arm: "main-only" });
    const launch = (args: string[]) => spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH, HOME: agent, TMPDIR: agent, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", ...env } });
    const tool = launch(["-e", 'console.log("ordinary-tool")']);
    assert.equal(tool.status, 0, tool.stderr); assert.equal(tool.stdout.trim(), "ordinary-tool");
    const pi = launch([cli]);
    assert.notEqual(pi.status, 0); assert.doesNotMatch(pi.stdout, /must-not-execute/);
    assert.match(pi.stderr, /Native observation initialization failed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("prepares inherited observation without retaining authentication content or storage path", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "guild-native-launch-test-"));
  try {
    const artifacts = join(root, "artifacts"), agent = join(root, "unretained-auth-directory");
    await mkdir(artifacts); await mkdir(agent, { mode: 0o700 });
    await writeFile(join(agent, "auth.json"), auth(), { mode: 0o600 });
    const env = await prepareNativeLaunch({ artifactDirectory: artifacts, agent, cwd: "/fixture", guildRoot: "/guild", piEntry: "/pi/dist/cli.js", pricing, arm: "main-only" });
    const raw = await readFile(env.GUILD_EVAL_NATIVE_CONFIG, "utf8");
    assert.equal(env.GUILD_EVAL_NATIVE_CONFIG_SHA256, createHash("sha256").update(raw).digest("hex"));
    assert.doesNotMatch(raw, /unretained|ACCOUNT_MUST_NOT_RETAIN|synthetic-signature/);
    assert.deepEqual(JSON.parse(raw).scopedAuthIdentity, captureScopedAuth(join(agent, "auth.json"), 0));
    assert.equal(env.GUILD_EVAL_AUTH_DIGEST, JSON.parse(raw).scopedAuthIdentity.fileDigest);
    assert.equal(Object.hasOwn(JSON.parse(raw), "authIdentity"), false);
    assert.match(env.NODE_OPTIONS, /--import=file:/);
    assert.match(env.GUILD_EVAL_AUTH_DIGEST, /^[a-f0-9]{64}$/);
    assert.equal((await stat(env.GUILD_EVAL_NATIVE_CONFIG)).mode & 0o777, 0o600);
    assert.equal((await stat(join(artifacts, "native"))).mode & 0o777, 0o700);
    await assert.rejects(prepareNativeLaunch({ artifactDirectory: artifacts, agent, cwd: "/fixture", guildRoot: "/guild", piEntry: "/pi/dist/cli.js", pricing, arm: "main-only" }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
