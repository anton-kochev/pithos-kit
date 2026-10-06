import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, rename, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config.ts';
import * as destinations from '../src/destinations.ts';

const config = parseConfig({docsDirs: ['handbook']});
async function fixture(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'clio-create-'));
  try { await fn(root); } finally { await rm(root, {recursive: true, force: true}); }
}
test('destination discovery includes empty and missing docs without creating anything', () => fixture(async root => {
  const missing = await destinations.discoverDestinations(root, ['src/cache.ts'], config);
  assert.deepEqual(missing.map(d => [d.path, d.missing]), [['docs', true]]);
  assert.deepEqual(await readdir(root), []);
  await mkdir(join(root, 'docs/sub'), {recursive: true});
  await mkdir(join(root, 'handbook'));
  await mkdir(join(root, 'src/docs'), {recursive: true});
  await mkdir(join(root, 'docs/generated'));
  await symlink(join(root, 'handbook'), join(root, 'docs/alias'));
  const found = await destinations.discoverDestinations(root, ['src/cache.ts'], config);
  assert.deepEqual(found.map(d => d.path).sort(), ['docs', 'docs/sub', 'handbook', 'src/docs']);
  await assert.rejects(destinations.discoverDestinations(root + '/.', [], config), /canonical/);
}));

import { safeFile, validateProposal } from '../src/evidence.ts';
test('grounded creates share references, count, content and duplicate destination validation', () => fixture(async root => {
  await writeFile(join(root, 'cache.ts'), 'export const ttl = 30;');
  const files = [await safeFile(root, 'cache.ts', config)];
  const dirs = await destinations.discoverDestinations(root, [], config);
  const proposal = {findings: [{claim: 'TTL is 30', kind: 'observed', sources: [{path: 'cache.ts', startLine: 1, endLine: 1}]}], edits: [], creates: [{path: 'docs/cache.md', content: '# Cache\nTTL is 30.\n', findings: [0]}], unresolved: []};
  const validate = (p: unknown, c = config) => validateProposal(JSON.stringify(p), files, c, [], dirs);
  assert.deepEqual(validate(proposal), proposal);
  for (const path of ['README.md', 'docs/../cache.md', 'docs/sub/cache.md', 'docs/AGENTS.md', 'docs/token.md', 'docs/a b.md', 'docs/é.md', 'docs/a.md.md', '@docs/cache.md']) {
    assert.throws(() => validate({...proposal, creates: [{...proposal.creates[0], path}]}), /Clio:/, path);
  }
  for (const content of ['password=supersecret123', '\0', '<!-- generated -->']) assert.throws(() => validate({...proposal, creates: [{...proposal.creates[0], content}]}));
  assert.throws(() => validate({...proposal, creates: [proposal.creates[0], proposal.creates[0]]}));
  assert.throws(() => validate({...proposal, creates: [...proposal.creates, {...proposal.creates[0], path: 'docs/other.md'}]}, {...config, maxEdits: 1}));
  assert.throws(() => validate({...proposal, findings: [{...proposal.findings[0], sources: [{path: 'forged.ts', startLine: 1, endLine: 1}]}]}));
  assert.throws(() => validate({...proposal, creates: [{...proposal.creates[0], findings: [1]}]}));
  assert.throws(() => validate({...proposal, creates: [{...proposal.creates[0], extra: true}]}));
}));

import { prepareCreate, publishCreate } from '../src/create.ts';
test('exclusive publication creates complete pages in existing and missing docs', () => fixture(async root => {
  const dirs = await destinations.discoverDestinations(root, [], config);
  const operation = await prepareCreate(root, {path: 'docs/cache.md', content: '# Cache\nTTL is 30.\n', findings: [0]}, dirs, config, async () => {});
  assert.equal(operation.args.createDirectory, join(root, 'docs'));
  assert.equal(operation.ledger.state, 'not-published');
  await publishCreate(operation);
  assert.equal(await readFile(join(root, 'docs/cache.md'), 'utf8'), '# Cache\nTTL is 30.\n');
  assert.equal(operation.ledger.state, 'published');
  assert.deepEqual(operation.ledger.createdDirectories, [join(root, 'docs')]);
  assert.deepEqual(operation.ledger.leftoverTemps, []);
  const next = await prepareCreate(root, {path: 'docs/second.md', content: 'Second page', findings: [0]}, dirs, config, async () => {});
  assert.equal(next.args.createDirectory, undefined);
  await publishCreate(next);
  assert.deepEqual((await readdir(join(root, 'docs'))).sort(), ['cache.md', 'second.md']);
  await assert.rejects(prepareCreate(root, {path: 'docs/cache.md', content: 'overwrite', findings: [0]}, dirs, config, async () => {}), /exists/);
}));

import { CreateAuthorization } from '../src/create-authorization.ts';
test('create authorization binds exact args and parent/runtime ids once before waits', () => {
  const authorization = new CreateAuthorization();
  const args = {path: '/project/docs/cache.md', content: 'Cache', capability: 'a', createDirectory: '/project/docs'};
  let valid = true;
  const guard = () => { if (!valid) throw new Error('cancelled'); };
  authorization.issue('capture', args, guard);
  assert.throws(() => authorization.observe('other', 'call', args));
  assert.throws(() => authorization.observe('capture', 'call', {...args, content: 'attack'}));
  assert.throws(() => authorization.claim('call', args));
  authorization.observe('capture', 'capture/1', {...args});
  assert.throws(() => authorization.observe('capture', 'capture/2', args));
  assert.throws(() => authorization.claim('capture/1', {...args, createDirectory: undefined}));
  authorization.claim('capture/1', {...args});
  assert.throws(() => authorization.claim('capture/1', args));
  authorization.issue('capture', args, guard);
  authorization.observe('capture', 'capture/2', args);
  valid = false;
  assert.throws(() => authorization.claim('capture/2', args), /cancelled/);
  authorization.revoke();
  assert.throws(() => authorization.observe('capture', 'capture/3', args));
});

import { link, unlink } from 'node:fs/promises';
import { withFileMutationQueue } from '@earendil-works/pi-coding-agent';
test('publication ledger preserves ambiguous publication and awaited cleanup failure', () => fixture(async root => {
  await mkdir(join(root, 'docs'));
  const dirs = await destinations.discoverDestinations(root, [], config);
  const operation = await prepareCreate(root, {path: 'docs/cache.md', content: 'Complete', findings: [0]}, dirs, config, async () => {});
  await assert.rejects(publishCreate(operation, undefined, {link: async (from, to) => { await link(from, to); throw new Error('lost acknowledgement'); }, unlink}), /lost acknowledgement/);
  assert.equal(operation.ledger.state, 'uncertain');
  assert.equal(await readFile(join(root, 'docs/cache.md'), 'utf8'), 'Complete');
  assert.deepEqual(operation.ledger.leftoverTemps, []);
  const second = await prepareCreate(root, {path: 'docs/second.md', content: 'Second', findings: [0]}, dirs, config, async () => {});
  await assert.rejects(publishCreate(second, undefined, {link, unlink: async () => { throw new Error('cleanup denied'); }}), /cleanup denied/);
  assert.equal(second.ledger.state, 'published');
  assert.equal(second.ledger.leftoverTemps.length, 1);
  assert.equal(await readFile(second.ledger.leftoverTemps[0], 'utf8'), 'Second');
}));

import { completion } from '../src/ui.ts';
test('partial creation completion names directories and leftover private temps without capture credit', () => {
  const text = completion({changed: ['docs/cache.md'], uncertain: [], documented: [], problems: ['cleanup denied'], createdDirectories: ['/project/docs'], leftoverTemps: ['/project/docs/.clio-owned.tmp']}, 10, undefined, []);
  assert.match(text!, /0 findings captured/);
  assert.match(text!, /Created directories: \/project\/docs/);
  assert.match(text!, /Leftover temporary files: \/project\/docs\/\.clio-owned.tmp/);
});

test('publication refuses collisions aliases changed identities and queued cancellation', async t => {
  for (const kind of ['file', 'directory', 'dangling', 'parent', 'root', 'race', 'cancel']) await t.test(kind, () => fixture(async root => {
    await mkdir(join(root, 'docs'));
    const dirs = await destinations.discoverDestinations(root, [], config);
    const operation = await prepareCreate(root, {path: 'docs/cache.md', content: 'Clio content', findings: [0]}, dirs, config, async () => {});
    const target = join(root, 'docs/cache.md');
    if (kind === 'file') await writeFile(target, 'winner');
    if (kind === 'directory') await mkdir(target);
    if (kind === 'dangling') await symlink(join(root, 'absent'), target);
    if (kind === 'parent') { await rename(join(root, 'docs'), join(root, 'old-docs')); await mkdir(join(root, 'docs')); }
    if (kind === 'root') { await rename(root, root + '-old'); await mkdir(root); await mkdir(join(root, 'docs')); }
    try {
      if (kind === 'race') {
        await assert.rejects(publishCreate(operation, undefined, {link: async (from, to) => { await writeFile(to, 'winner'); await link(from, to); }, unlink}), /EEXIST/);
        assert.equal(await readFile(target, 'utf8'), 'winner');
      } else if (kind === 'cancel') {
        let release!: () => void, entered!: () => void;
        const ready = new Promise<void>(resolve => { entered = resolve; });
        const held = withFileMutationQueue(target, async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
        await ready;
        const controller = new AbortController();
        const pending = publishCreate(operation, controller.signal);
        controller.abort(); release(); await held;
        await assert.rejects(pending, /abort/i);
      } else await assert.rejects(publishCreate(operation), /exists|identity changed/);
      assert.equal(operation.ledger.state, 'not-published');
      assert.deepEqual(operation.ledger.leftoverTemps, []);
    } finally { if (kind === 'root') await rm(root + '-old', {recursive: true, force: true}); }
  }));
});

test('prepublication cancellation awaits owned-temp cleanup and retains created-directory ledger', () => fixture(async root => {
  const dirs = await destinations.discoverDestinations(root, [], config);
  const check = async () => {
    const entries = await readdir(join(root, 'docs')).catch(() => []);
    if (entries.some(name => name.startsWith('.clio-'))) throw new Error('cancelled before publication');
  };
  const operation = await prepareCreate(root, {path: 'docs/cache.md', content: 'Complete', findings: [0]}, dirs, config, check);
  await assert.rejects(publishCreate(operation), /cancelled before publication/);
  assert.equal(operation.ledger.state, 'not-published');
  assert.deepEqual(operation.ledger.createdDirectories, [join(root, 'docs')]);
  assert.deepEqual(operation.ledger.leftoverTemps, []);
  assert.deepEqual(await readdir(join(root, 'docs')), []);
}));

test('cleanup never unlinks a replacement at the private temporary path', () => fixture(async root => {
  await mkdir(join(root, 'docs'));
  const dirs = await destinations.discoverDestinations(root, [], config);
  const operation = await prepareCreate(root, {path: 'docs/cache.md', content: 'Complete', findings: [0]}, dirs, config, async () => {});
  await assert.rejects(publishCreate(operation, undefined, {link: async (from, to) => {
    await link(from, to);
    await rename(from, join(root, 'owned-original'));
    await writeFile(from, 'unrelated replacement');
  }, unlink}), /temporary identity changed/);
  assert.equal(operation.ledger.state, 'published');
  assert.equal(await readFile(operation.ledger.leftoverTemps[0], 'utf8'), 'unrelated replacement');
  assert.equal(await readFile(join(root, 'docs/cache.md'), 'utf8'), 'Complete');
}));

test('prepublication replacement is never linked and remains untouched', () => fixture(async root => {
  await mkdir(join(root, 'docs'));
  const dirs = await destinations.discoverDestinations(root, [], config);
  let replacement: string | undefined;
  const guard = async () => {
    if (replacement) return;
    const name = (await readdir(join(root, 'docs'))).find(name => name.startsWith('.clio-'));
    if (!name) return;
    replacement = join(root, 'docs', name);
    await rename(replacement, join(root, 'owned-original'));
    await writeFile(replacement, 'unrelated replacement');
  };
  const operation = await prepareCreate(root, {path: 'docs/cache.md', content: 'Complete', findings: [0]}, dirs, config, guard);
  await assert.rejects(publishCreate(operation), /temporary identity changed/);
  await assert.rejects(lstat(operation.args.path), {code: 'ENOENT'});
  assert.equal(operation.ledger.state, 'not-published');
  assert.deepEqual(operation.ledger.leftoverTemps, [replacement]);
  assert.equal(await readFile(replacement!, 'utf8'), 'unrelated replacement');
  assert.equal(await readFile(join(root, 'owned-original'), 'utf8'), 'Complete');
}));

test('prepublication content tampering on the owned inode is refused', async t => {
  for (const content of ['Tampered', 'Complete plus extra', '', 'x'.repeat(config.maxContextBytes + 1)]) await t.test(`changed ${content.length} bytes`, () => fixture(async root => {
    await mkdir(join(root, 'docs'));
    const dirs = await destinations.discoverDestinations(root, [], config);
    let changed = false;
    const guard = async () => {
      if (changed) return;
      const name = (await readdir(join(root, 'docs'))).find(name => name.startsWith('.clio-'));
      if (!name) return;
      changed = true;
      await writeFile(join(root, 'docs', name), content);
    };
    const operation = await prepareCreate(root, {path: 'docs/cache.md', content: 'Complete', findings: [0]}, dirs, config, guard);
    await assert.rejects(publishCreate(operation), /temporary contents changed/);
    await assert.rejects(lstat(operation.args.path), {code: 'ENOENT'});
    assert.equal(operation.ledger.state, 'not-published');
    assert.deepEqual(operation.ledger.leftoverTemps, []);
    assert.deepEqual(await readdir(join(root, 'docs')), []);
  }));
});

test('prepublication aliases are refused without removing unrelated entries', async t => {
  for (const kind of ['symlink', 'hardlink', 'directory']) await t.test(kind, () => fixture(async root => {
    await mkdir(join(root, 'docs'));
    const dirs = await destinations.discoverDestinations(root, [], config);
    const alias = join(root, 'owned-alias');
    let temporary: string | undefined;
    const guard = async () => {
      if (temporary) return;
      const name = (await readdir(join(root, 'docs'))).find(name => name.startsWith('.clio-'));
      if (!name) return;
      temporary = join(root, 'docs', name);
      if (kind === 'hardlink') await link(temporary, alias);
      else {
        await rename(temporary, alias);
        if (kind === 'symlink') await symlink(alias, temporary);
        else await mkdir(temporary);
      }
    };
    const operation = await prepareCreate(root, {path: 'docs/cache.md', content: 'Complete', findings: [0]}, dirs, config, guard);
    await assert.rejects(publishCreate(operation));
    await assert.rejects(lstat(operation.args.path), {code: 'ENOENT'});
    assert.equal(operation.ledger.state, 'not-published');
    assert.equal(await readFile(alias, 'utf8'), 'Complete');
    if (kind === 'hardlink') {
      // Ownership is of the inode, not its bytes: remove only our private name.
      assert.deepEqual(operation.ledger.leftoverTemps, []);
      await assert.rejects(lstat(temporary!), {code: 'ENOENT'});
      assert.equal((await lstat(alias)).nlink, 1);
    } else {
      assert.deepEqual(operation.ledger.leftoverTemps, [temporary]);
      const stat = await lstat(temporary!);
      assert.equal(kind === 'symlink' ? stat.isSymbolicLink() : stat.isDirectory(), true);
    }
  }));
});

test('publication retains the primary failure when cleanup also fails', async t => {
  for (const phase of ['guard', 'link']) await t.test(phase, () => fixture(async root => {
    await mkdir(join(root, 'docs'));
    const dirs = await destinations.discoverDestinations(root, [], config);
    const primary = new Error(phase === 'guard' ? 'cancelled before publication' : 'lost acknowledgement');
    const cleanup = new Error('cleanup denied');
    const guard = async () => {
      if (phase === 'guard' && (await readdir(join(root, 'docs'))).some(name => name.startsWith('.clio-'))) throw primary;
    };
    const operation = await prepareCreate(root, {path: 'docs/cache.md', content: 'Complete', findings: [0]}, dirs, config, guard);
    await assert.rejects(publishCreate(operation, undefined, {
      link: async (from, to) => { await link(from, to); throw primary; },
      unlink: async () => { throw cleanup; },
    }), error => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [primary, cleanup]);
      assert.ok(error.message.includes(primary.message));
      assert.ok(error.message.includes(cleanup.message));
      return true;
    });
    assert.equal(operation.ledger.state, phase === 'guard' ? 'not-published' : 'uncertain');
    assert.equal(operation.ledger.leftoverTemps.length, 1);
    assert.equal(await readFile(operation.ledger.leftoverTemps[0], 'utf8'), 'Complete');
    if (phase === 'guard') await assert.rejects(lstat(operation.args.path), {code: 'ENOENT'});
    else assert.equal(await readFile(operation.args.path, 'utf8'), 'Complete');
  }));
});

test('prepublication removal does not report a nonexistent leftover temp', () => fixture(async root => {
  await mkdir(join(root, 'docs'));
  const dirs = await destinations.discoverDestinations(root, [], config);
  const guard = async () => {
    const name = (await readdir(join(root, 'docs'))).find(name => name.startsWith('.clio-'));
    if (name) await unlink(join(root, 'docs', name));
  };
  const operation = await prepareCreate(root, {path: 'docs/cache.md', content: 'Complete', findings: [0]}, dirs, config, guard);
  await assert.rejects(publishCreate(operation));
  await assert.rejects(lstat(operation.args.path), {code: 'ENOENT'});
  assert.equal(operation.ledger.state, 'not-published');
  assert.deepEqual(operation.ledger.leftoverTemps, []);
  assert.deepEqual(await readdir(join(root, 'docs')), []);
}));
