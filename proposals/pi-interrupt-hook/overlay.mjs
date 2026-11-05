import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const trackedFiles = ['core/agent-session', 'core/agent-session-runtime', 'core/agent-session-services', 'core/sdk', 'main', 'modes/print-mode', 'modes/rpc/rpc-mode', 'core/extensions/types', 'core/extensions/runner', 'core/extensions/loader', 'core/extensions/index', 'index', 'modes/interactive/interactive-mode'].sort();
const newFiles = ['core/extensions/atomic-owned-tools', 'core/extensions/tool-registry-write', 'core/parent-continuation'].sort();
const files = [...trackedFiles, ...newFiles];
const protectedFiles = ['package.json', 'dist/bundle/cli.js', ...files.flatMap(file => [
  `dist/${file}.js`, `dist/${file}.d.ts`, `dist/${file}.js.map`, `dist/${file}.d.ts.map`,
])];
const note = message => console.log(`# ${message}`);
const inside = (root, target) => target === root || target.startsWith(root + path.sep);

function checked(target, kind) {
  const stat = lstatSync(target);
  assert(!stat.isSymbolicLink() && realpathSync(target) === target, `Refuse symlink path: ${target}`);
  assert(kind === 'directory' ? stat.isDirectory() : stat.isFile(), `Expected ${kind}: ${target}`);
  return stat;
}

function digests(installed) {
  return Object.fromEntries(protectedFiles.map(file => {
    const target = path.join(installed, file);
    if (newFiles.some(module => file.startsWith(`dist/${module}.`))) {
      assert(!lstatSync(target, { throwIfNoEntry: false }), `New proposal output already installed: ${target}`);
      return [file, 'absent'];
    }
    checked(target, 'file');
    return [file, createHash('sha256').update(readFileSync(target)).digest('hex')];
  }));
}

// Canonical selected-source diff includes untracked helpers; never admit unrelated future work.
function qualifySource(source, proposal) {
  const git = (args, expected = 0) => {
    const result = spawnSync('git', ['-C', source, ...args], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 2 * 1024 * 1024,
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' },
    });
    assert(!result.error && result.status === expected && !result.signal,
      `Source qualification git failure: ${result.error ?? result.stderr}`);
    return result.stdout;
  };
  assert.equal(git(['rev-parse', 'HEAD']).trim(), '4a080252f06caf63a525d7873c5d94d3c23887e0', 'Exact source base required');
  const relativePath = file => `packages/coding-agent/src/${file}.ts`;
  const spec = ':(glob)packages/*/src/**';
  const changed = git(['diff', '--name-only', 'HEAD', '--', spec]).trim().split('\n').filter(Boolean);
  const added = git(['ls-files', '--others', '--exclude-standard', '--', spec]).trim().split('\n').filter(Boolean);
  assert.deepEqual(changed.sort(), trackedFiles.map(relativePath).sort(), 'Unexpected tracked production inventory');
  assert.deepEqual(added.sort(), newFiles.map(relativePath).sort(), 'Unexpected new production inventory');
  for (const file of files) checked(path.join(source, relativePath(file)), 'file');
  const flags = ['--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/'];
  const relative = (file) => `packages/coding-agent/src/${file}.ts`;
  let diff = git(['diff', ...flags, 'HEAD', '--', ...trackedFiles.map(relative)]);
  for (const file of newFiles) {
    assert.equal(git(['ls-tree', 'HEAD', '--', relative(file)]), '', 'New source must be absent at pinned base');
    // no-index returns 1 for the expected nonempty addition, not an execution failure.
    diff += git(['diff', '--no-index', ...flags, '--', '/dev/null', relative(file)], 1);
  }
  assert(Buffer.from(diff).equals(readFileSync(proposal)), 'Source qualification failed: exact sixteen-file patch must equal current proposal');
  note('Source sixteen-file patch matches proposal: true (13 tracked + 3 new modules)');
}

function transpileOverlay(source, runtime, sandbox, ts) {
  const sourceFiles = files.map(file => path.join(source, 'packages/coding-agent/src', `${file}.ts`));
  const hashes = {};
  for (const [index, file] of files.entries()) {
    const output = path.join(runtime, 'dist', `${file}.js`);
    assert(inside(sandbox, output), `Output outside sandbox: ${output}`);
    checked(path.dirname(output), 'directory');
    if (newFiles.includes(file)) assert(!lstatSync(output, { throwIfNoEntry: false }), `Expected new disposable output: ${output}`);
    else assert.equal(checked(output, 'file').nlink, 1, `Refuse hardlinked output: ${output}`);
    const result = ts.transpileModule(readFileSync(sourceFiles[index], 'utf8'), {
      fileName: sourceFiles[index], reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, rewriteRelativeImportExtensions: true },
    });
    const errors = (result.diagnostics ?? []).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
    if (errors.length) throw new Error(errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
    writeFileSync(output, result.outputText);
    hashes[file] = createHash('sha256').update(result.outputText).digest('hex');
    note(`Transpiled: ${sourceFiles[index]} -> ${output}`);
  }
  note(`Runtime SHA-256: ${JSON.stringify(hashes)}`);
  return hashes;
}
export { trackedFiles, newFiles, files, protectedFiles, digests, qualifySource, transpileOverlay };
