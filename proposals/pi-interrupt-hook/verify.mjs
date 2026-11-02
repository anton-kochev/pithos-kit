import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const version = '1.4.0';
const files = ['core/extensions/types', 'core/extensions/runner', 'modes/interactive/interactive-mode'];
const protectedFiles = ['package.json', 'dist/bundle/cli.js', ...files.flatMap(file => [
  `dist/${file}.js`, `dist/${file}.d.ts`, `dist/${file}.js.map`,
])];
const sourcePackages = {
  agent: 'pi-agent-core', ai: 'pi-ai', chord: 'chord', codemode: 'pi-codemode',
  'coding-agent': 'pi-coding-agent', durable: 'pi-durable', env: 'pi-env', evals: 'pi-evals',
  mcp: 'pi-mcp', telemetry: 'pi-telemetry', tui: 'pi-tui',
};
const note = message => console.log(`# ${message}`);
const inside = (root, target) => target === root || target.startsWith(root + path.sep);

function checked(target, kind) {
  const stat = lstatSync(target);
  assert(!stat.isSymbolicLink() && realpathSync(target) === target, `Refuse symlink path: ${target}`);
  assert(kind === 'directory' ? stat.isDirectory() : stat.isFile(), `Expected ${kind}: ${target}`);
  return stat;
}

function inputPath(value, kind) {
  const absolute = path.resolve(value);
  assert(!lstatSync(absolute).isSymbolicLink(), `Refuse symlink argument: ${absolute}`);
  // Resolve ancestor aliases (notably /tmp on macOS) once; internal paths must stay canonical.
  const canonical = realpathSync(absolute);
  checked(canonical, kind);
  return canonical;
}

function manifest(directory, name, expectedVersion) {
  const file = path.join(directory, 'package.json');
  checked(file, 'file');
  const value = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(value.name, name, `Package identity: ${file}`);
  if (expectedVersion) assert.equal(value.version, expectedVersion, `Package version: ${file}`);
  note(`Package: ${file} (${value.name} ${value.version})`);
  return value;
}

function sdk(manifest) {
  assert.equal(manifest.type, 'module', 'Pi must be ESM');
  assert.equal(manifest.main, './dist/index.js', 'Expected unbundled SDK main');
  assert.equal(manifest.types, './dist/index.d.ts', 'Expected SDK declarations');
  assert.equal(manifest.exports?.['.']?.import, './dist/index.js', 'Expected public SDK import export');
  assert.equal(manifest.exports?.['.']?.types, './dist/index.d.ts', 'Expected public SDK types export');
}

function digests(installed) {
  return Object.fromEntries(protectedFiles.map(file => {
    const target = path.join(installed, file);
    checked(target, 'file');
    return [file, createHash('sha256').update(readFileSync(target)).digest('hex')];
  }));
}

function runTests(sandbox, node) {
  const args = ['--test', '--test-reporter=tap', path.join(sandbox, 'interrupt.test.mjs')];
  note(`Child command: ${JSON.stringify([node, ...args])}`);
  return new Promise(resolve => {
    const child = spawn(node, args, {
      cwd: path.join(sandbox, 'cwd'), detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      // Deliberately do not merge process.env: no credentials, proxies, NODE_OPTIONS or PI_PACKAGE_DIR.
      env: {
        PATH: `${path.dirname(node)}:/usr/bin:/bin`, HOME: path.join(sandbox, 'home'),
        XDG_CONFIG_HOME: path.join(sandbox, 'config'), XDG_CACHE_HOME: path.join(sandbox, 'cache'),
        XDG_DATA_HOME: path.join(sandbox, 'data'), XDG_STATE_HOME: path.join(sandbox, 'state'),
        TMPDIR: path.join(sandbox, 'tmp'), TMP: path.join(sandbox, 'tmp'), TEMP: path.join(sandbox, 'tmp'),
        PI_CODING_AGENT_DIR: path.join(sandbox, 'agent'), PI_OFFLINE: '1',
        TERM: 'xterm-256color', NO_COLOR: '1', LANG: 'C.UTF-8',
      },
    });
    const stdout = [], stderr = [];
    let stdoutBytes = 0, stderrBytes = 0, closed = false, stopping = false;
    let code = null, signal = null, failure, killTimer;
    const send = signal => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); }
      catch (error) { if (error.code !== 'ESRCH') failure = `${failure ?? ''}; ${error.message}`; }
    };
    const finish = () => {
      if (!closed || killTimer) return;
      clearTimeout(deadline);
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', terminate);
      resolve({ code, signal, failure, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    };
    const stop = reason => {
      failure ??= reason;
      if (stopping) return;
      stopping = true;
      send('SIGTERM');
      // node:test owns a worker process too. Kill the whole group, even if its leader closes first.
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
    const deadline = setTimeout(() => stop('Test deadline exceeded (30000 ms)'), 30000);
    child.stdout.on('data', chunk => {
      const remaining = Math.max(0, 1024 * 1024 - stdoutBytes);
      if (remaining > 0) stdout.push(Buffer.from(chunk.subarray(0, remaining)));
      stdoutBytes += chunk.length;
      if (stdoutBytes > 1024 * 1024) stop('Test stdout exceeded 1048576 bytes');
    });
    child.stderr.on('data', chunk => {
      const remaining = Math.max(0, 64 * 1024 - stderrBytes);
      if (remaining > 0) stderr.push(Buffer.from(chunk.subarray(0, remaining)));
      stderrBytes += chunk.length;
      if (stderrBytes > 64 * 1024) stop('Test stderr exceeded 65536 bytes');
    });
    for (const stream of [child.stdout, child.stderr]) stream.on('error', error => stop(error.message));
    child.on('error', error => stop(`Child process error: ${error.message}`));
    // A timer is not exit evidence: never remove the sandbox until the child and its pipes close.
    child.on('close', (exitCode, exitSignal) => {
      closed = true;
      code = exitCode;
      signal = exitSignal;
      finish();
    });
  });
}

let sandbox, installed, before, childResult;
try {
  assert(process.argv.length === 5 && process.argv.slice(2).every(arg => arg.trim()),
    'Usage: node verify.mjs patched-source-checkout installed-coding-agent-package typescript-module-file');
  assert(process.platform !== 'win32', 'This verifier requires POSIX process groups for worker cleanup');
  const [major, minor] = process.versions.node.split('.').map(Number);
  assert(major > 22 || (major === 22 && minor >= 19), 'Pi 1.4.0 requires Node >=22.19.0');
  const source = inputPath(process.argv[2], 'directory');
  installed = inputPath(process.argv[3], 'directory');
  const typescriptFile = inputPath(process.argv[4], 'file');
  const node = realpathSync(process.execPath);
  const localTest = path.join(realpathSync(path.dirname(fileURLToPath(import.meta.url))), 'interrupt.test.mjs');
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
  const dependencies = realpathSync(path.join(installed, 'node_modules'));
  checked(dependencies, 'directory');
  const typescriptRoot = path.dirname(path.dirname(typescriptFile));
  const typescriptManifest = manifest(typescriptRoot, 'typescript');
  assert.equal(typescriptManifest.main, './lib/typescript.js', 'Expected TypeScript compiler module');
  assert.equal(path.join(typescriptRoot, 'lib/typescript.js'), typescriptFile, 'Expected TypeScript module path');
  before = digests(installed);
  const ts = createRequire(import.meta.url)(typescriptFile);
  assert.equal(ts.version, typescriptManifest.version, 'TypeScript module/manifest version mismatch');
  assert.equal(typeof ts.transpileModule, 'function', 'Expected TypeScript transpileModule API');
  assert(ts.optionDeclarations?.some(option => option.name === 'rewriteRelativeImportExtensions'),
    'TypeScript must support rewriteRelativeImportExtensions (5.7+)');
  note(`TypeScript: ${ts.version}; transpileModule only, not a typecheck or declaration build`);

  const temp = realpathSync(tmpdir());
  for (const input of [source, installed, dependencies, typescriptRoot, path.dirname(localTest)]) {
    assert(!inside(input, temp), `Temporary directory must be outside input paths: ${temp}`);
  }
  sandbox = mkdtempSync(path.join(temp, 'pi-interrupt-verify-'));
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
  const copiedTest = path.join(sandbox, 'interrupt.test.mjs');
  cpSync(localTest, copiedTest, { errorOnExist: true, force: false });
  assert(readFileSync(localTest).equals(readFileSync(copiedTest)), 'Test copy must be byte-exact');
  for (const [index, file] of files.entries()) {
    const output = path.join(runtime, 'dist', `${file}.js`);
    assert(inside(sandbox, output), `Output outside sandbox: ${output}`);
    assert.equal(checked(output, 'file').nlink, 1, `Refuse hardlinked output: ${output}`);
    const result = ts.transpileModule(readFileSync(sourceFiles[index], 'utf8'), {
      fileName: sourceFiles[index], reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, rewriteRelativeImportExtensions: true },
    });
    const errors = (result.diagnostics ?? []).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
    if (errors.length) throw new Error(errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
    writeFileSync(output, result.outputText);
    note(`Transpiled: ${sourceFiles[index]} -> ${output}`);
  }
  childResult = await runTests(sandbox, node);
  process.stdout.write(childResult.stdout);
  process.stderr.write(childResult.stderr);
  note(`Child exit: code=${childResult.code} signal=${childResult.signal ?? 'none'}`);
  if (childResult.failure) throw new Error(childResult.failure);
  process.exitCode = childResult.code ?? 1;
} catch (error) {
  console.error(`Verification failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (!childResult) note('Child exit: not started');
  if (before) {
    try {
      assert.deepEqual(digests(installed), before, 'Installed protected files changed');
      note(`Installed SHA-256: unchanged (${protectedFiles.length} files); not a digest of all dependencies`);
    } catch (error) {
      console.error(`Installed SHA-256 check failed: ${error.message}`);
      process.exitCode = 1;
    }
  } else note('Installed SHA-256: not checked (input validation did not complete)');
  if (sandbox) {
    try {
      checked(sandbox, 'directory');
      rmSync(sandbox, { recursive: true, force: false });
      note(`Cleanup: removed ${sandbox}`);
    } catch (error) {
      console.error(`Cleanup failed for ${sandbox}: ${error.message}`);
      process.exitCode = 1;
    }
  } else note('Cleanup: no sandbox created');
}
