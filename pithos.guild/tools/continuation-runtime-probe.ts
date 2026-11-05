import { files, newFiles, protectedFiles, digests, qualifySource, transpileOverlay } from '../../proposals/pi-interrupt-hook/overlay.mjs';
/** Explicit-input, provider-free qualified native harness. Dependencies are read-only by convention. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, readdirSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const caseNames = ['questions-one-batch', 'terminals-after-cleanup', 'notice-not-collection', 'foreign-delivery', 'accepted-escape', 'preparing-escape', 'committed-message-start', 'committed-message-end', 'started-escape-capacity', 'required-plan-guild-first', 'required-plan-plan-first', 'tree-held-wake', 'reload-held-wake', 'shutdown-held-wake', 'fresh-input-only', 'nonjoining-close'];
const selected = process.argv.length === 7 && process.argv[5] === '--case' ? [process.argv[6]] : caseNames;
const focused = selected !== caseNames;
const version = '1.4.0';
const sourcePackages = {
  agent: 'pi-agent-core', ai: 'pi-ai', chord: 'chord', codemode: 'pi-codemode',
  'coding-agent': 'pi-coding-agent', durable: 'pi-durable', env: 'pi-env', evals: 'pi-evals',
  mcp: 'pi-mcp', telemetry: 'pi-telemetry', tui: 'pi-tui',
};
const note = (message: string) => console.log(`# ${message}`);
const inside = (root: string, target: string) => target === root || target.startsWith(root + path.sep);

function checked(target: string, kind: "directory" | "file") {
  const stat = lstatSync(target);
  assert(!stat.isSymbolicLink() && realpathSync(target) === target, `Refuse symlink path: ${target}`);
  assert(kind === 'directory' ? stat.isDirectory() : stat.isFile(), `Expected ${kind}: ${target}`);
  return stat;
}

function inputPath(value: string, kind: "directory" | "file") {
  const absolute = path.resolve(value);
  assert(!lstatSync(absolute).isSymbolicLink(), `Refuse symlink argument: ${absolute}`);
  // Resolve ancestor aliases (notably /tmp on macOS) once; internal paths must stay canonical.
  const canonical = realpathSync(absolute);
  checked(canonical, kind);
  return canonical;
}

function manifest(directory: string, name: string, expectedVersion?: string) {
  const file = path.join(directory, 'package.json');
  checked(file, 'file');
  const value = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(value.name, name, `Package identity: ${file}`);
  if (expectedVersion) assert.equal(value.version, expectedVersion, `Package version: ${file}`);
  note(`Package: ${file} (${value.name} ${value.version})`);
  return value;
}

function sdk(manifest: { type?: string; main?: string; types?: string; exports?: Record<string, { import?: string; types?: string }> }) {
  assert.equal(manifest.type, 'module', 'Pi must be ESM');
  assert.equal(manifest.main, './dist/index.js', 'Expected unbundled SDK main');
  assert.equal(manifest.types, './dist/index.d.ts', 'Expected SDK declarations');
  assert.equal(manifest.exports?.['.']?.import, './dist/index.js', 'Expected public SDK import export');
  assert.equal(manifest.exports?.['.']?.types, './dist/index.d.ts', 'Expected public SDK types export');
}

function runTests(sandbox: string, node: string) {
  const args = [fileURLToPath(new URL('../test/fixtures/continuation-runtime-probe-worker.mjs', import.meta.url)), path.join(sandbox, 'runtime/dist/cli.js'), ...(focused ? ['--case', selected[0]] : [])];
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
let sandbox: string | undefined, installed: string | undefined;
let before: Record<string, string> | undefined, childResult: ChildResult | undefined;
try {
  assert((process.argv.length === 5 || (focused && caseNames.includes(selected[0]))) && process.argv.slice(2).every(arg => arg.trim()),
    'Usage: npm run test:continuation-runtime -- patched-source-checkout installed-package-or-cli typescript-module-file [--case name]');
  note(`Selection: ${JSON.stringify({qualified: false, manifestTotal: 16, selected})}`);
  assert(process.platform !== 'win32', 'This verifier requires POSIX process groups for worker cleanup');
  const [major, minor] = process.versions.node.split('.').map(Number);
  assert(major > 22 || (major === 22 && minor >= 19), 'Pi 1.4.0 requires Node >=22.19.0');
  const source = inputPath(process.argv[2], 'directory');
  installed = inputPath(process.argv[3], lstatSync(path.resolve(process.argv[3])).isDirectory() ? 'directory' : 'file');
  if (lstatSync(installed).isFile()) {
    assert.equal(installed, path.join(path.dirname(path.dirname(installed)), 'dist/cli.js'));
    installed = path.dirname(path.dirname(installed));
  }
  const typescriptFile = inputPath(process.argv[4], 'file');
  const node = realpathSync(process.execPath);
  const localTest = fileURLToPath(new URL('../test/fixtures/continuation-runtime-probe-worker.mjs', import.meta.url));
  checked(localTest, 'file');
  note(`Source checkout: ${source}`);
  note(`Installed runtime: ${installed}`);
  note(`TypeScript module: ${typescriptFile}`);
  note(`Node: ${node} (${process.version})`);
  note(`Test artifact: ${localTest}`);
  manifest(source, 'pi-monorepo'); // The monorepo root has its own version, not the release version.
  for (const [directory, name] of Object.entries(sourcePackages)) {
    const value = manifest(path.join(source, 'packages', directory), `@earendil-works/${name}`, version);
    if (directory === 'coding-agent') sdk(value);
  }
  sdk(manifest(installed, '@earendil-works/pi-coding-agent', version));
  checked(path.join(installed, 'dist/index.js'), 'file');
  checked(path.join(installed, 'dist/index.d.ts'), 'file');
  const sourceFiles = files.map(file => path.join(source, 'packages/coding-agent/src', `${file}.ts`));
  for (const file of sourceFiles) checked(file, 'file');
  qualifySource(source, fileURLToPath(new URL('../../proposals/pi-interrupt-hook/pi-v1.4.0.patch', import.meta.url)));
  const dependencies = realpathSync(path.join(installed, 'node_modules'));
  checked(dependencies, 'directory');
  const typescriptRoot = path.dirname(path.dirname(typescriptFile));
  const typescriptManifest = manifest(typescriptRoot, 'typescript');
  assert.equal(typescriptManifest.main, './lib/typescript.js', 'Expected TypeScript compiler module');
  assert.equal(path.join(typescriptRoot, 'lib/typescript.js'), typescriptFile, 'Expected TypeScript module path');
  before = digests(installed);
  note(`Protected SHA-256 before: ${JSON.stringify(before)}`);
  const ts = createRequire(import.meta.url)(typescriptFile) as typeof import("typescript") & { optionDeclarations: { name: string }[] };
  assert.equal(ts.version, typescriptManifest.version, 'TypeScript module/manifest version mismatch');
  assert.equal(typeof ts.transpileModule, 'function', 'Expected TypeScript transpileModule API');
  assert(ts.optionDeclarations?.some(option => option.name === 'rewriteRelativeImportExtensions'),
    'TypeScript must support rewriteRelativeImportExtensions (5.7+)');
  note(`TypeScript: ${ts.version}; transpileModule only, not a typecheck or declaration build`);

  const temp = realpathSync(tmpdir());
  for (const input of [source, installed, dependencies, typescriptRoot, path.dirname(localTest)]) {
    assert(!inside(input, temp), `Temporary directory must be outside input paths: ${temp}`);
  }
  sandbox = mkdtempSync(path.join(temp, 'guild-continuation-native-'));
  checked(sandbox, 'directory');
  note(`Sandbox: ${sandbox}`);
  const runtime = path.join(sandbox, 'runtime');
  for (const directory of ['runtime', 'home', 'config', 'cache', 'data', 'state', 'cwd', 'tmp', 'agent']) {
    mkdirSync(path.join(sandbox, directory));
  }
  cpSync(path.join(installed, 'package.json'), path.join(runtime, 'package.json'), { errorOnExist: true, force: false });
  const bundle = path.join(installed, 'dist/bundle');
  cpSync(path.join(installed, 'dist'), path.join(runtime, 'dist'), {
    recursive: true, dereference: false, errorOnExist: true, force: false,
    filter: entry => {
      if (inside(bundle, entry)) return false;
      checked(entry, lstatSync(entry).isDirectory() ? 'directory' : 'file');
      return true;
    },
  });
  // This is not an OS sandbox/read-only mount. Dependencies are trusted and read-only by convention.
  symlinkSync(dependencies, path.join(runtime, 'node_modules'), 'dir');
  note(`Dependencies (read-only by convention, not OS-enforced): ${dependencies}`);
  transpileOverlay(source, runtime, sandbox, ts);
  childResult = await runTests(sandbox, node);
  process.stdout.write(childResult.stdout);
  process.stderr.write(childResult.stderr);
  note(`Child exit: code=${childResult.code} signal=${childResult.signal ?? 'none'}`);
  if (childResult.failure) throw new Error(childResult.failure);
  assert.equal(childResult.stderr.length, 0, 'Unexpected worker stderr');
  assert.equal(childResult.code, 0, 'Native continuation cases failed');
  assert.equal(childResult.signal, null);
  assert(childResult.stdout.toString("utf8").endsWith("\n"), "Incomplete worker evidence");
  const records = childResult.stdout.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line));
  const cases = records.filter(record => record.phase === 'case');
  assert.deepEqual(cases.map(record => [record.case, record.status]), selected.map(name => [name, 'passed']));
  assert.deepEqual(records.at(-1), { phase: 'summary', passed: selected.length, total: selected.length,
    failed: 0, qualified: !focused, manifestTotal: 16 });
} catch (error) {
  console.error(`Verification failed: ${String(error)}`);
  process.exitCode = 1;
} finally {
  if (!childResult) note('Child exit: not started');
  if (before) {
    try {
      const after = digests(installed!);
      assert.deepEqual(after, before, 'Installed protected files changed');
      note(`Protected SHA-256 after: ${JSON.stringify(after)}`);
      note(`Installed SHA-256: unchanged (${protectedFiles.length - newFiles.length * 4} files, ${newFiles.length * 4} absence assertions); not a digest of all dependencies`);
    } catch (error) {
      console.error(`Installed SHA-256 check failed: ${String(error)}`);
      process.exitCode = 1;
    }
  } else note('Installed SHA-256: not checked (input validation did not complete)');
  if (sandbox) {
    try {
      checked(sandbox, 'directory');
      try {
        const storage = ['home', 'config', 'cache', 'data', 'state', 'cwd', 'tmp', 'agent']
          .flatMap(directory => readdirSync(path.join(sandbox!, directory), { recursive: true }).map(String));
        assert(!storage.some(file => file.endsWith('.jsonl') || /(?:^|[/\\])(?:auth|settings|models|models-store)\.json$/.test(file)), 'Unexpected persisted storage');
        note('Storage: no session JSONL or persistent auth/settings/model files');
      } finally { rmSync(sandbox, { recursive: true, force: false }); }
      note(`Cleanup: removed ${sandbox}`);
    } catch (error) {
      console.error(`Cleanup failed for ${sandbox}: ${String(error)}`);
      process.exitCode = 1;
    }
  } else note('Cleanup: no sandbox created');
}
