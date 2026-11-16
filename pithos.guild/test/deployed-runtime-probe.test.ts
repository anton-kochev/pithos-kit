import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { qualifyManifest } from '../tools/deployed-runtime-probe.ts';

const bytes = readFileSync(new URL('./fixtures/deployed-runtime-manifest.json', import.meta.url));
test('deployed qualification accepts only the reviewed manifest bytes, not self-consistent replacements', () => {
  assert.equal(Object.keys(qualifyManifest(bytes).overlay).length, 16);
  for (const mutation of [Buffer.from(bytes.toString().replace('1.5.0', '1.6.0')), Buffer.from(bytes.toString().replace('907576d', '007576d')), Buffer.concat([bytes, Buffer.from('\n')])]) {
    assert.throws(() => qualifyManifest(mutation), /Manifest SHA-256/);
  }
});

test('packed Guild version follows the release checkout rather than a fixed old version', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { qualifyGuildPackage } = await import('../tools/deployed-runtime-probe.ts');
  const root = mkdtempSync(path.join(tmpdir(), 'guild-release-version-'));
  try {
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@pithos-kit/guild', version: '0.11.0' }));
    assert.equal(qualifyGuildPackage(root, '0.11.0').version, '0.11.0');
    assert.throws(() => qualifyGuildPackage(root, '0.10.0'), /Guild package version/);
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'not-guild', version: '0.11.0' }));
    assert.throws(() => qualifyGuildPackage(root, '0.11.0'), /Guild package identity/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Opt-in deployed artifact pin; normal unit runs require no /opt installation.
test('installed qualification rejects isolated package and helper mutations', { skip: !process.env.GUILD_DEPLOYED_TEST_ROOT }, async () => {
  const { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { qualifyInstalled } = await import('../tools/deployed-runtime-probe.ts');
  const root = mkdtempSync(path.join(tmpdir(), 'guild-deployment-pin-'));
  try {
    const manifest = qualifyManifest(bytes);
    const manifestPath = path.join(root, 'manifest.json');
    writeFileSync(manifestPath, bytes);
    for (const file of ['package.json', ...Object.keys(manifest.overlay)]) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      cpSync(path.join(process.env.GUILD_DEPLOYED_TEST_ROOT!, file), path.join(root, file));
    }
    assert.equal(Object.keys(qualifyInstalled(root, manifestPath)).length, 17);
    writeFileSync(manifestPath, bytes.toString().replace('907576d', '007576d'));
    assert.throws(() => qualifyInstalled(root, manifestPath), /Manifest SHA-256/);
    writeFileSync(manifestPath, bytes);
    const pkg = readFileSync(path.join(root, 'package.json'));
    writeFileSync(path.join(root, 'package.json'), pkg.toString().replace('1.5.0', '1.6.0'));
    assert.throws(() => qualifyInstalled(root, manifestPath), /Package version/);
    writeFileSync(path.join(root, 'package.json'), pkg);
    writeFileSync(path.join(root, 'dist/core/parent-continuation.js'), '// drift');
    assert.throws(() => qualifyInstalled(root, manifestPath), /Installed SHA-256: dist\/core\/parent-continuation.js/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('explicit deployed launcher runs the strict connected matrix from the selected Guild package', { skip: !process.env.GUILD_DEPLOYED_TEST_ROOT || !process.env.GUILD_DEPLOYED_TEST_PACKAGE, timeout: 200000 }, async () => {
  const { spawnSync } = await import('node:child_process');
  const child = spawnSync(process.execPath, ['--import', 'tsx', 'tools/deployed-runtime-probe.ts',
    process.env.GUILD_DEPLOYED_TEST_ROOT!, new URL('./fixtures/deployed-runtime-manifest.json', import.meta.url).pathname,
    process.env.GUILD_DEPLOYED_TEST_PACKAGE!], { encoding: 'utf8', timeout: 190000, maxBuffer: 256 * 1024 });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.match(child.stdout, /"passed":16,"total":16,"failed":0,"qualified":true/);
  assert.match(child.stdout, /Installed SHA-256: unchanged/);
  assert.match(child.stdout, /"phase":"idle-question","status":"passed"/);
  assert.match(child.stdout, /"phase":"writer-second-request","status":"passed","route":"editor"/);
});
