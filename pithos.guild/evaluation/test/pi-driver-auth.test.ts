import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createPiDriver } from "../src/pi-driver.ts";
import { loadDevelopmentBank } from "../src/bank.ts";
import { runTrial } from "../src/runner.ts";
import { digest } from "../src/manifest.ts";

async function fileContents(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await fileContents(path));
    else if (entry.isFile()) result.push(await readFile(path, "utf8"));
  }
  return result;
}

test("rejects ambiguous authentication and a Codex credential for a different provider", async () => {
  const common = { approval: "explicit-model-run-approval" as const, piEntry: resolve("unused-cli"), piPackageJson: resolve("unused-package"), guildRoot: resolve("."), codexAuth: { sourceFile: resolve("unused-auth"), temporaryRoot: tmpdir() } };
  assert.throws(() => createPiDriver({ ...common, credentials: { OPENAI_API_KEY: "synthetic-key" } }), /mix|ambiguous/i);
  const driver = createPiDriver({ ...common, credentials: {} });
  await assert.rejects(driver({ request: { cohort: { model: "anthropic/not-codex" } } } as any), /Codex.*provider/i);
});

for (const piVersion of ["0.84.0", "0.85.2", "0.87.0"]) test(`fails before credential access when Pi ${piVersion}'s refresh policy is unverified`, async () => {
  const root = await mkdtemp(join(tmpdir(), "guild-auth-runtime-test-"));
  try {
    const piPackageJson = join(root, "package.json");
    await writeFile(piPackageJson, JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: piVersion }));
    const driver = createPiDriver({ approval: "explicit-model-run-approval", piEntry: join(root, "unused-cli.mjs"), piPackageJson, guildRoot: resolve("."), credentials: {}, codexAuth: { sourceFile: join(root, "nonexistent-auth"), temporaryRoot: root } });
    await assert.rejects(driver({
      trialIdentity: { version: 1, id: "00000000-0000-4000-8000-000000000000", requestDigest: "0".repeat(64) }, // Rejected at runtime-version preflight, before identity/credential access.
      cwd: root, artifactDirectory: root, signal: new AbortController().signal, emit: () => {}, stderr: () => {},
      request: { task: loadDevelopmentBank().tasks[0], arm: "main-only", repetition: 1, cohort: { model: "openai-codex/test-synthetic", thinking: "high" }, timeoutMs: 1000 },
    }), /Codex.*0\.83\.0/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("excludes the entire campaign retention root from transient Codex storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "guild-auth-retention-test-"));
  try {
    const retentionRoot = join(root, "campaign"), sourceFile = join(root, "source.json"), marker = join(root, "spawned");
    await mkdir(retentionRoot, { mode: 0o700 });
    const expires = Date.now() + 3600000;
    const claims = { exp: Math.floor(expires / 1000), "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } };
    const token = `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.synthetic-signature`;
    const source = JSON.stringify({ "openai-codex": { type: "oauth", access: token, refresh: "synthetic-refresh", expires, accountId: "synthetic-account" } });
    await writeFile(sourceFile, source, { mode: 0o600 });
    const piPackageJson = join(root, "package.json"), cli = join(root, "fake-cli.mjs");
    await writeFile(piPackageJson, JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.83.0" }));
    await writeFile(cli, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'spawned');`);
    const result = await runTrial(join(retentionRoot, "trials"), { task: loadDevelopmentBank().tasks[0], arm: "main-only", repetition: 1, cohort: { model: "openai-codex/test-synthetic", thinking: "high" }, timeoutMs: 1000 },
      createPiDriver({ approval: "explicit-model-run-approval", piEntry: cli, piPackageJson, guildRoot: resolve("."), credentials: {}, codexAuth: { sourceFile, temporaryRoot: retentionRoot } }), undefined, { retentionRoot });
    assert.equal(result.status, "driver_error");
    assert.match(result.error!, /scoped Codex/);
    await assert.rejects(access(marker));
    assert.equal(await readFile(sourceFile, "utf8"), source);
    assert.deepEqual(await readdir(retentionRoot), ["trials"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rechecks token lifetime before spawn and removes the lease after setup failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "guild-auth-preflight-test-"));
  try {
    const sourceFile = join(root, "source.json"), temporaryRoot = join(root, "private"), storage = join(root, "runs"), marker = join(root, "spawned");
    await mkdir(temporaryRoot);
    const now = Date.now(), expires = now + 3600000;
    const claims = { exp: Math.floor(expires / 1000), "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } };
    const token = `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.synthetic-signature`;
    await writeFile(sourceFile, JSON.stringify({ "openai-codex": { type: "oauth", access: token, refresh: "synthetic-refresh", expires, accountId: "synthetic-account" } }), { mode: 0o600 });
    const piPackageJson = join(root, "package.json"), cli = join(root, "fake-cli.mjs");
    await writeFile(piPackageJson, JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.83.0" }));
    await writeFile(cli, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'spawned');`);
    const driver = createPiDriver({ approval: "explicit-model-run-approval", piEntry: cli, piPackageJson, guildRoot: resolve("."), credentials: {}, codexAuth: { sourceFile, temporaryRoot } });
    const request = { task: loadDevelopmentBank().tasks[0], arm: "main-only" as const, repetition: 1, cohort: { model: "openai-codex/test-synthetic", thinking: "high" }, timeoutMs: 1000 };
    const setupFailure = await runTrial(storage, request, async context => {
      await writeFile(join(context.artifactDirectory, "invocation.json"), "existing record");
      return driver(context);
    });
    assert.equal(setupFailure.status, "driver_error");
    assert.deepEqual(await readdir(temporaryRoot), []);
    await assert.rejects(access(marker));
    let invocation: string | undefined;
    const clock = t.mock.method(Date, "now", () => invocation && existsSync(invocation) ? expires : now);
    try {
      const expiredDuringSetup = await runTrial(storage, request, context => {
        invocation = join(context.artifactDirectory, "invocation.json");
        return driver(context);
      });
      assert.equal(expiredDuringSetup.status, "driver_error");
      assert.match(expiredDuringSetup.error!, /outlive the trial/);
      await assert.rejects(access(marker));
      assert.deepEqual(await readdir(temporaryRoot), []);
    } finally { clock.mock.restore(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const piVersion of ["0.83.0", "0.85.1"]) test(`native Codex borrowing on Pi ${piVersion} reaches parent/child privately and cleans up on completion, failure, and timeout`, async () => {
  const root = await mkdtemp(join(tmpdir(), "guild-native-auth-test-"));
  try {
    const sourceFile = join(root, "SOURCE_AUTH_PATH"), temporaryRoot = join(root, "private"), storage = join(root, "runs");
    await mkdir(temporaryRoot);
    const expires = Date.now() + 3600000;
    const claims = { exp: Math.floor(expires / 1000), "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } };
    const token = `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.synthetic-signature`;
    const source = JSON.stringify({ "openai-codex": { type: "oauth", access: token, refresh: "SYNTHETIC_REFRESH_DO_NOT_COPY", expires, accountId: "synthetic-account" }, unrelated: { type: "api_key", key: "UNRELATED_SECRET" } });
    await writeFile(sourceFile, source, { mode: 0o600 });
    const piPackageJson = join(root, "package.json");
    await writeFile(piPackageJson, JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: piVersion }));
    for (const outcome of ["success", "error", "timeout"]) {
      const cli = join(root, `${outcome}.mjs`);
      await writeFile(cli, `import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const dir = process.env.PI_CODING_AGENT_DIR;
const bytes = readFileSync(dir + '/auth.json'), info = statSync(dir + '/auth.json', {bigint:true});
const auth = JSON.parse(bytes.toString('utf8'));
const observed = {fileDigest:createHash('sha256').update(JSON.stringify(bytes.toString('base64'))).digest('hex'),dev:info.dev.toString(),ino:info.ino.toString(),uid:Number(info.uid)};
if (Object.keys(auth).join() !== 'openai-codex' || auth['openai-codex'].refresh !== '' || auth['openai-codex'].access !== ${JSON.stringify(token)}) throw Error('Incorrect scoped credential');
if (process.env.HOME !== dir || process.env.OPENAI_API_KEY || process.env.NODE_OPTIONS) throw Error('Ambient credential/config leak');
if ((statSync(dir + '/auth.json').mode & 0o777) !== 0o600) throw Error('Unsafe auth permissions');
if (!process.argv.includes('--probe-child')) {
  const probe = spawnSync(process.execPath, [process.argv[1], '--probe-child'], {encoding:'utf8'});
  if (probe.status !== 0) throw Error('Child auth probe failed');
  writeFileSync(dir + '/private-debug.log', auth['openai-codex'].access);
  console.log(JSON.stringify({type:'offline_auth_check',directory:dir,observed}));
  ${outcome === "timeout" ? "setInterval(() => {}, 1000);" : `process.exitCode = ${outcome === "error" ? 7 : 0};`}
}
`);
      const driver = createPiDriver({ approval: "explicit-model-run-approval", piEntry: cli, piPackageJson, guildRoot: resolve("."), credentials: {}, codexAuth: { sourceFile, temporaryRoot } });
      const run = await runTrial(storage, { task: loadDevelopmentBank().tasks[0], arm: "guild-available", repetition: 1, cohort: { model: "openai-codex/test-synthetic", thinking: "high" }, timeoutMs: 1500 }, driver);
      const artifact = join(storage, run.id);
      const raw = await readFile(join(artifact, "parent.jsonl"), "utf8");
      const check = raw.trim().split("\n").filter(Boolean).map(line => JSON.parse(line)).find(event => event.type === "offline_auth_check");
      assert.ok(check, `Missing synthetic auth check: ${run.status}`);
      await assert.rejects(access(check.directory));
      assert.deepEqual(await readdir(temporaryRoot), []);
      assert.equal(await readFile(sourceFile, "utf8"), source);
      assert.equal(run.status, outcome === "success" ? "incomplete_trace" : outcome === "error" ? "process_error" : "timeout");
      const recorded = (await fileContents(artifact)).join("\n");
      for (const secret of [token, "SYNTHETIC_REFRESH_DO_NOT_COPY", "UNRELATED_SECRET", "synthetic-account", sourceFile]) assert.equal(recorded.includes(secret), false, "Credential material/source path entered retained artifacts");
      const invocation = JSON.parse(await readFile(join(artifact, "invocation.json"), "utf8"));
      assert.equal(invocation.authentication, "codex-access-only; transient storage; no refresh");
      assert.deepEqual(invocation.scopedAuthIdentity, { version: 1, kind: "scoped-codex-auth-file-observation", ...check.observed,
        expires: Math.floor(expires / 1000) * 1000, accountDigest: digest("synthetic-account") });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
