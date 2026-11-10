import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, readdirSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
// Reviewed in-image 1.5.0 deployment, not a caller-selected trust root.
export const manifestSha256 = 'c97a03d9dd5cd2faea87c30192fc1a19b5a6a0c9c33f374a09ae57c85d1a614a';
interface DeploymentManifest { piVersion: string; upstreamCommit: string; expected: Record<string, string>; overlay: Record<string, string> }
export function qualifyManifest(bytes: Buffer): DeploymentManifest {
  assert.equal(createHash('sha256').update(bytes).digest('hex'), manifestSha256, 'Manifest SHA-256');
  const manifest = JSON.parse(bytes.toString('utf8')) as DeploymentManifest;
  assert.equal(manifest.piVersion, '1.5.0');
  assert.equal(manifest.upstreamCommit, 'f9a26365568127461c47a07a37dcb42c140a3ac5');
  assert.equal(Object.keys(manifest.overlay).length, 16);
  return manifest;
}

function regular(file: string) {
  assert(lstatSync(file).isFile() && realpathSync(file) === file, `Expected canonical regular file: ${file}`);
  return readFileSync(file);
}
export function qualifyGuildPackage(root: string, expectedVersion: string): { name: string; version: string } {
  const pkg = JSON.parse(regular(path.join(root, 'package.json')).toString('utf8'));
  assert.equal(pkg.name, '@pithos-kit/guild', 'Guild package identity');
  assert.equal(pkg.version, expectedVersion, 'Guild package version must match the release checkout');
  return pkg;
}
export function qualifyInstalled(root: string, manifestPath: string): Record<string, string> {
  const manifest = qualifyManifest(regular(realpathSync(manifestPath)));
  root = realpathSync(root);
  const pkg = JSON.parse(regular(path.join(root, 'package.json')).toString('utf8'));
  assert.equal(pkg.name, '@earendil-works/pi-coding-agent', 'Package identity');
  assert.equal(pkg.version, '1.5.0', 'Package version');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.exports?.['.']?.import, './dist/index.js');
  const expected = { 'package.json': manifest.expected['package.json'], ...manifest.overlay };
  return Object.fromEntries(Object.entries(expected).map(([file, digest]) => {
    const actual = createHash('sha256').update(regular(path.join(root, file))).digest('hex');
    assert.equal(actual, digest, `Installed SHA-256: ${file}`);
    return [file, actual];
  }));
}

const note = (message: string) => console.log(`# ${message}`);
const inside = (root: string, target: string) => target === root || target.startsWith(root + path.sep);
function checked(target: string, kind: 'directory' | 'file') {
  const stat = lstatSync(target);
  assert(!stat.isSymbolicLink() && realpathSync(target) === target, `Refuse symlink path: ${target}`);
  assert(kind === 'directory' ? stat.isDirectory() : stat.isFile(), `Expected ${kind}: ${target}`);
}
function inputPath(value: string, kind: 'directory' | 'file') {
  const absolute = path.resolve(value);
  assert(!lstatSync(absolute).isSymbolicLink(), `Refuse symlink argument: ${absolute}`);
  const canonical = realpathSync(absolute);
  checked(canonical, kind);
  return canonical;
}
function copy(source: string, destination: string) {
  cpSync(source, destination, { recursive: true, force: false, errorOnExist: true,
    filter: entry => {
      checked(entry, lstatSync(entry).isDirectory() ? 'directory' : 'file');
      return true;
    } });
}
function runTests(sandbox: string, node: string, worker = 'continuation-runtime-probe-worker.mjs') {
  const args = [path.join(sandbox, 'pithos.guild/test/fixtures', worker), path.join(sandbox, 'runtime/dist/cli.js'), '--runtime-version', '1.5.0'];
  note(`Child command: ${JSON.stringify([node, ...args])}`);
  return new Promise<ChildResult>(resolve => {
    const child = spawn(node, args, {
      cwd: path.join(sandbox, 'cwd'), detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      // Deliberately do not merge process.env: no credentials, proxies, NODE_OPTIONS or PI_PACKAGE_DIR.
      env: {
        HOME: path.join(sandbox, 'home'), USERPROFILE: path.join(sandbox, 'home'),
        XDG_CONFIG_HOME: path.join(sandbox, 'config'), XDG_CACHE_HOME: path.join(sandbox, 'cache'),
        TMPDIR: path.join(sandbox, 'tmp'), TMP: path.join(sandbox, 'tmp'), TEMP: path.join(sandbox, 'tmp'),
        PI_CODING_AGENT_DIR: path.join(sandbox, 'agent'), PI_OFFLINE: '1',
        PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
      },
    });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let stdoutBytes = 0, stderrBytes = 0, closed = false, stopping = false;
    let code: number | null = null, signal: NodeJS.Signals | null = null;
    let failure: string | undefined, killTimer: ReturnType<typeof setTimeout> | undefined;
    const send = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) failure = `${failure ?? ''}; ${String(error)}`; }
    };
    const finish = () => {
      if (!closed || killTimer) return;
      clearTimeout(deadline);
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', terminate);
      resolve({ code, signal, failure, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    };
    const stop = (reason: string) => {
      failure ??= reason;
      if (stopping) return;
      stopping = true;
      send('SIGTERM');
      // Kill the process group even if its leader closes first; never infer close from a timer.
      killTimer = setTimeout(() => {
        send('SIGKILL');
        killTimer = undefined;
        finish();
      }, 1000);
    };
    const interrupt = () => stop('Verifier received SIGINT');
    const terminate = () => stop('Verifier received SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    // Sixteen native lifecycle cases include externally released cleanup barriers.
    const deadline = setTimeout(() => stop('Test deadline exceeded (90000 ms)'), 90000);
    child.stdout.on('data', chunk => {
      const remaining = Math.max(0, 128 * 1024 - stdoutBytes);
      if (remaining > 0) stdout.push(Buffer.from(chunk.subarray(0, remaining)));
      stdoutBytes += chunk.length;
      if (stdoutBytes > 128 * 1024) stop('Test stdout exceeded 131072 bytes');
    });
    child.stderr.on('data', chunk => {
      const remaining = Math.max(0, 8192 - stderrBytes);
      if (remaining > 0) stderr.push(Buffer.from(chunk.subarray(0, remaining)));
      stderrBytes += chunk.length;
      if (stderrBytes > 8192) stop('Test stderr exceeded 8192 bytes');
    });
    for (const stream of [child.stdout, child.stderr]) stream.on('error', error => stop(error.message));
    child.on('error', error => stop(`Child process error: ${String(error)}`));
    // A timer is not exit evidence: never remove the sandbox until the child and its pipes close.
    child.on('close', (exitCode, exitSignal) => {
      closed = true;
      code = exitCode;
      signal = exitSignal;
      finish();
    });
  });
}

interface ChildResult { code: number | null; signal: NodeJS.Signals | null; failure?: string; stdout: Buffer; stderr: Buffer }

export async function main(args: string[]) {
  let sandbox: string | undefined, installed: string | undefined, manifestPath: string | undefined;
  let before: Record<string, string> | undefined, childResult: ChildResult | undefined;
  try {
    assert((args.length === 2 || args.length === 3) && args.every(arg => arg.trim()),
      'Usage: node --import tsx tools/deployed-runtime-probe.ts installed-package deployment-manifest [unpacked-guild-root]');
    assert(process.platform !== 'win32', 'POSIX process groups required');
    const [major, minor] = process.versions.node.split('.').map(Number);
    assert(major > 22 || (major === 22 && minor >= 19), 'Pi requires Node >=22.19.0');
    installed = inputPath(args[0], 'directory');
    manifestPath = inputPath(args[1], 'file');
    before = qualifyInstalled(installed, manifestPath);
    note(`Manifest SHA-256: ${manifestSha256}`);
    note(`Installed SHA-256 before: ${JSON.stringify(before)}`);
    const guild = inputPath(args[2] ?? fileURLToPath(new URL('..', import.meta.url)), 'directory');
    const checkout = fileURLToPath(new URL('..', import.meta.url));
    const expectedVersion = JSON.parse(regular(path.join(checkout, 'package.json')).toString('utf8')).version;
    const guildManifest = qualifyGuildPackage(guild, expectedVersion);
    note(`Guild package input: ${guild} (version ${guildManifest.version})`);
    const plan = inputPath(fileURLToPath(new URL('../../pithos.plan', import.meta.url)), 'directory');
    const fixtures = inputPath(fileURLToPath(new URL('../test/fixtures', import.meta.url)), 'directory');
    const dependencies = realpathSync(path.join(installed, 'node_modules'));
    const temp = realpathSync(tmpdir());
    for (const input of [installed, guild, plan, dependencies, fixtures]) assert(!inside(input, temp), 'Temporary root overlaps input');
    sandbox = mkdtempSync(path.join(temp, 'guild-deployed-15-'));
    note(`Sandbox: ${sandbox}`);
    for (const dir of ['runtime', 'home', 'config', 'cache', 'data', 'state', 'cwd', 'tmp', 'agent', 'pithos.guild/test/fixtures', 'pithos.plan']) mkdirSync(path.join(sandbox, dir), {recursive: true});
    const runtime = path.join(sandbox, 'runtime');
    copy(path.join(installed, 'package.json'), path.join(runtime, 'package.json'));
    copy(path.join(installed, 'dist'), path.join(runtime, 'dist'));
    symlinkSync(dependencies, path.join(runtime, 'node_modules'), 'dir');
    // The worker rechecks this pinned manifest and all copied outputs before loading the SDK.
    writeFileSync(path.join(runtime, 'deployed-manifest.json'), regular(manifestPath));
    qualifyInstalled(runtime, path.join(runtime, 'deployed-manifest.json'));
    for (const entry of ['package.json', 'src', 'extensions', 'agents', 'skills']) copy(path.join(guild, entry), path.join(sandbox, 'pithos.guild', entry));
    for (const entry of ['package.json', 'extensions', 'themes']) copy(path.join(plan, entry), path.join(sandbox, 'pithos.plan', entry));
    for (const entry of readdirSync(fixtures).filter(name => name.startsWith('continuation-runtime-probe-'))) copy(path.join(fixtures, entry), path.join(sandbox, 'pithos.guild/test/fixtures', entry));
    note('Dependencies read-only by convention; not an OS sandbox. Plan and fixture code from checkout; Guild source/assets from explicit package input.');
    childResult = await runTests(sandbox, realpathSync(process.execPath));
    process.stdout.write(childResult.stdout);
    process.stderr.write(childResult.stderr);
    note(`Child exit: code=${childResult.code} signal=${childResult.signal ?? 'none'}`);
    if (childResult.failure) throw new Error(childResult.failure);
    assert.equal(childResult.stderr.length, 0, 'Unexpected worker stderr');
    assert.equal(childResult.code, 0, 'Native continuation cases failed');
    assert.equal(childResult.signal, null);
    assert(childResult.stdout.toString('utf8').endsWith('\n'), 'Incomplete worker evidence');
    const records = childResult.stdout.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line));
    const expected = ['questions-one-batch', 'terminals-after-cleanup', 'notice-not-collection', 'foreign-delivery', 'accepted-escape', 'preparing-escape', 'committed-message-start', 'committed-message-end', 'started-escape-capacity', 'required-plan-guild-first', 'required-plan-plan-first', 'tree-held-wake', 'reload-held-wake', 'shutdown-held-wake', 'fresh-input-only', 'nonjoining-close'];
    assert.deepEqual(records.filter(record => record.phase === 'case').map(record => [record.case, record.status]), expected.map(name => [name, 'passed']));
    assert.deepEqual(records.at(-1), {phase: 'summary', passed: 16, total: 16, failed: 0, qualified: true, manifestTotal: 16});
    const idle = await runTests(sandbox, realpathSync(process.execPath), 'continuation-runtime-probe-idle-worker.mjs');
    process.stdout.write(idle.stdout);
    process.stderr.write(idle.stderr);
    note(`Idle child exit: code=${idle.code} signal=${idle.signal ?? 'none'}`);
    assert.equal(idle.failure, undefined);
    assert.equal(idle.code, 0, 'Idle question pin failed');
    assert.equal(idle.signal, null);
    assert.equal(idle.stderr.length, 0);
    assert(idle.stdout.toString('utf8').endsWith('\n'));
    assert.deepEqual(JSON.parse(idle.stdout.toString('utf8').trimEnd().split('\n').at(-1)!),
      {phase: 'idle-question', status: 'passed', notices: 1, autoResponses: 1, exactReply: true, pollingTools: 0, nativeSettledBeforeRelease: true});
  } finally {
    try {
      if (before) {
        assert.deepEqual(qualifyInstalled(installed!, manifestPath!), before, 'Installed outputs changed');
        note('Installed SHA-256: unchanged (package plus 16 overlay outputs; not all dependencies)');
      }
    } finally {
      if (sandbox) {
        try {
          const storage = ['home', 'config', 'cache', 'data', 'state', 'cwd', 'tmp', 'agent'].flatMap(dir => readdirSync(path.join(sandbox!, dir), {recursive: true}).map(String));
          assert(!storage.some(file => file.endsWith('.jsonl') || /(?:^|[/\\])(?:auth|settings|models|models-store)\.json$/.test(file)), 'Unexpected persisted storage');
          note('Storage: no session JSONL or persistent auth/settings/model files');
        } finally { rmSync(sandbox, {recursive: true, force: false}); note(`Cleanup: removed ${sandbox}`); }
      }
    }
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(`Verification failed: ${String(error)}`); process.exitCode = 1; }
}
