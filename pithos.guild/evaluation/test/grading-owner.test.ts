import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import test, { type TestContext } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, symlink, link, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { inertGradingOwner, gradingCommand, type GradingSelection, type GradingCommand } from '../src/grading-owner.ts';
import { superviseAuthorization } from '../src/grading-boundary.ts';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const producerId = 'c'.repeat(64), graderId = 'd'.repeat(64);
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'grading-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['code', 'producer', 'private', 'exchange']) await mkdir(join(root, name));
  await mkdir(join(root, 'producer/src'));
  await writeFile(join(root, 'producer/src/users.mjs'), 'authored inert bytes');
  const sources = { 'grading-observer.ts': 'inert observer', 'grading-bootstrap.ts': 'inert bootstrap' };
  for (const [name, bytes] of Object.entries(sources)) await writeFile(join(root, 'code', name), bytes);
  const selection: GradingSelection = {
    image: 'sha256:' + 'a'.repeat(64), uid: 1000, gid: 1000,
    code: join(root, 'code'), producer: join(root, 'producer'), retained: join(root, 'private/result'), exchange: join(root, 'exchange'),
    sources: Object.fromEntries(Object.entries(sources).map(([k,v]) => [k, hash(v)])),
    // Invented identities ONLY inside inert fixtures, not operational selections.
    imageFiles: { '/usr/bin/env': hash('inert env'), '/usr/bin/node': hash('inert runtime') },
    producerIdentity: { id: producerId, name: 'guild-grade-producer', image: 'sha256:' + 'b'.repeat(64) },
  };
  return { root, selection };
}
const binding = { attemptId: 'attempt', gradingRunId: 'grading', artifactDigest: 'a'.repeat(64), observerDigest: 'b'.repeat(64) };
function backend(s: GradingSelection, options: { uncertain?: boolean; launchFailure?: boolean; mutation?: boolean; forgedOwner?: boolean; policyDrift?: boolean; userDrift?: boolean; mappingDrift?: boolean; modeMutation?: boolean; pass?: boolean } = {}) {
  const calls: GradingCommand[] = [];
  let name = '', removedProducer = false, removedGrader = false;
  const stdout = new PassThrough(), stderr = new PassThrough();
  return { calls, boundary: {
    async control(command: GradingCommand) {
      calls.push(command);
      const args = command.args;
      let value = '';
      if (args[0] === 'create') { name = args[args.indexOf('--name') + 1]; value = graderId; }
      if (args[0] === 'inspect') {
        const producer = args.at(-1) === producerId;
        const identity = producer ? s.producerIdentity : { id: graderId, name, image: s.image };
        value = JSON.stringify({ Id: identity.id, Image: identity.image, Name: '/' + identity.name,
          Config: { User: options.userDrift ? '0:0' : `${s.uid}:${s.gid}`, Entrypoint: ['/usr/bin/env'], WorkingDir: '/evidence', Labels: { 'pithos.guild.grading-owner': options.forgedOwner ? 'forged' : identity.name }, Volumes: null },
          State: { Running: false },
          // Owner validates actual grader settings before attach.
          HostConfig: { NetworkMode: options.policyDrift ? 'host' : 'none', Privileged: false, ReadonlyRootfs: true,
            CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges=true'], PidsLimit: 64, Memory: 536870912, NanoCpus: 1000000000,
            PidMode: '', IpcMode: 'private', UTSMode: '', Init: true, Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=64m,mode=1777' }, Devices: [], Binds: null },
          Mounts: [{ Type: 'bind', Source: s.code, Destination: '/harness/guild', RW: false },
            { Type: 'bind', Source: options.mappingDrift ? '/wrong-exchange' : producer ? s.producer : s.exchange, Destination: '/evidence', RW: true }],
        });
      }
      if (args[0] === 'rm') {
        if (args.at(-1) === producerId) removedProducer = true;
        else removedGrader = true;
      }
      if (args[0] === 'container') {
        if (options.uncertain) return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('daemon unavailable') };
        const producer = args.includes(`id=${producerId}`);
        value = (producer ? removedProducer : removedGrader) ? '' : producer ? producerId : graderId;
      }
      return { code: 0, stdout: Buffer.from(value), stderr: Buffer.alloc(0) };
    },
    async attach(command: GradingCommand) {
      calls.push(command);
      assert(removedProducer);
      assert.deepEqual(command.args, ['start', '--attach', '--interactive', graderId]);
      assert.equal(await readFile(join(s.retained, 'src/users.mjs'), 'utf8'), 'authored inert bytes');
      if (options.launchFailure) throw new Error('inert partial launch');
      if (options.modeMutation) await chmod(join(s.exchange, 'src/users.mjs'), 0o777);
      return { stdout, stderr, stdin: new Writable({ write(chunk, _encoding, done) {
        const r = JSON.parse(chunk.toString());
        const allowed = [0, 2].includes(r.caseId);
        stdout.write(JSON.stringify({ version: 1, caseId: r.caseId, attemptId: r.attemptId, gradingRunId: r.gradingRunId,
          artifactDigest: r.artifactDigest, observerDigest: r.observerDigest, saves: options.pass && allowed ? 1 : 0, invalidSave: false,
          settlement: options.pass ? (allowed ? 'saved' : 'rejected') : 'other', sameThrownObject: r.caseId === 6, overflow: false }) + '\n');
        if (options.mutation) writeFile(join(s.exchange, 'changed.txt'), 'checker mutation').then(() => done(), done);
        else done();
      } }) };
    },
  } };
}

test('fixed command has exactly two mounts, no shell, pull or private tree', async t => {
  const { selection } = await fixture(t);
  const command = gradingCommand(selection, 'guild-grade-abc');
  assert.equal(command.file, 'docker');
  assert.equal(command.args.filter(v => v === '--mount').length, 2);
  for (const pair of [['--network','none'], ['--user','1000:1000'], ['--cap-drop','ALL'], ['--memory','512m'], ['--pids-limit','64'], ['--cpus','1'], ['--pull','never']]) assert.equal(command.args[command.args.indexOf(pair[0]) + 1], pair[1]);
  assert(command.args.includes('--read-only'));
  assert(command.args.includes('/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777'));
  assert(!JSON.stringify(command).includes(selection.retained));
  assert(!JSON.stringify(command).includes(selection.producer));
  assert.throws(() => gradingCommand({ ...selection, image: 'latest' }, 'guild-grade-abc'));
  assert.throws(() => gradingCommand({ ...selection, uid: 0 }, 'guild-grade-abc'));
  assert.throws(() => gradingCommand({ ...selection, sources: { ...selection.sources, 'bank.ts': hash('private') } }, 'guild-grade-abc'));
  assert.throws(() => gradingCommand({ ...selection, imageFiles: { '/private/bank.ts': hash('private') } }, 'guild-grade-abc'));
  assert.throws(() => gradingCommand({ ...selection, exchange: selection.producer + '/nested' }, 'guild-grade-abc'));
});

test('owner removes producer before import; comparator uses transport; authoritative copies cannot alias exchange', async t => {
  const { selection } = await fixture(t);
  const fake = backend(selection, { pass: true });
  const owner = inertGradingOwner(selection, fake.boundary);
  assert.equal((await superviseAuthorization(binding, owner)).state, 'passed');
  assert.equal(fake.calls.filter(c => c.args[0] === 'rm').length, 2);
  await writeFile(join(selection.exchange, 'src/users.mjs'), 'changed exchange');
  assert.equal(await readFile(join(selection.retained, 'src/users.mjs'), 'utf8'), 'authored inert bytes');
  await assert.rejects(owner.open(binding));
});

for (const kind of ['uncertain', 'symlink', 'hardlink', 'ancestor', 'private-code', 'forgedOwner', 'policyDrift', 'userDrift', 'mappingDrift'] as const) {
  test(`fails before candidate attach: ${kind}`, async t => {
    const { root, selection } = await fixture(t);
    if (kind === 'symlink') await symlink('/private/sentinel', join(selection.producer, 'bad'));
    if (kind === 'hardlink') await link(join(selection.producer, 'src/users.mjs'), join(selection.producer, 'alias'));
    if (kind === 'ancestor') { await symlink(selection.producer, join(root, 'alias')); selection.producer = join(root, 'alias'); }
    if (kind === 'private-code') await writeFile(join(selection.code, 'bank.ts'), 'private sentinel');
    const fake = backend(selection, { [kind]: true });
    const result = await superviseAuthorization(binding, inertGradingOwner(selection, fake.boundary));
    assert.equal(result.passed, false);
    assert.equal(fake.calls.filter(c => c.args[0] === 'start').length, 0);
    if (kind === 'uncertain' || kind === 'mappingDrift') await assert.rejects(readFile(join(selection.retained, 'src/users.mjs')));
  });
}

test('failed attach still removes owned container, checker mutation cannot pass', async t => {
  for (const options of [{ launchFailure: true }, { mutation: true, pass: true }, { modeMutation: true, pass: true }]) {
    const { selection } = await fixture(t);
    const fake = backend(selection, options);
    assert.equal((await superviseAuthorization(binding, inertGradingOwner(selection, fake.boundary))).passed, false);
    assert.equal(fake.calls.filter(c => c.args[0] === 'rm').length, 2);
  }
});


test('oversized directories reject without materializing an unbounded listing', async t => {
  const { selection } = await fixture(t);
  await Promise.all(Array.from({ length: 2001 }, (_, i) => mkdir(join(selection.producer, `empty-${i}`))));
  const listing = t.mock.method(fs, 'readdir');
  const original = fs.opendir;
  let reads = 0, closes = 0;
  const opening = t.mock.method(fs, 'opendir', async (...args: Parameters<typeof original>) => {
    const dir = await original(...args);
    if (args[0] === selection.producer) {
      const read = dir.read.bind(dir), close = dir.close.bind(dir);
      t.mock.method(dir, 'read', async () => { reads++; return read(); });
      t.mock.method(dir, 'close', async () => { closes++; return close(); });
    }
    return dir;
  });
  syncBuiltinESMExports();
  t.after(() => { opening.mock.restore(); listing.mock.restore(); syncBuiltinESMExports(); });
  const fake = backend(selection);
  await assert.rejects(inertGradingOwner(selection, fake.boundary).open(binding), /Artifact entry limit/);
  assert.equal(reads, 2001, 'stop at the first entry beyond the global bound');
  assert.equal(closes, 1);
  assert.equal(listing.mock.callCount(), 0, 'must not materialize directory listings before checking the bound');
  assert.equal(fake.calls.filter(c => c.args[0] === 'create').length, 0);
});

test('candidate relying on an empty directory receives it in both independent copies', async t => {
  const { selection } = await fixture(t);
  await mkdir(join(selection.producer, 'scratch/nested'), { recursive: true });
  const fake = backend(selection, { pass: true });
  const attach = fake.boundary.attach;
  fake.boundary.attach = async command => {
    for (const root of [selection.retained, selection.exchange]) {
      assert.deepEqual(await fs.readdir(join(root, 'scratch/nested')), []);
    }
    return attach(command);
  };
  assert.equal((await superviseAuthorization(binding, inertGradingOwner(selection, fake.boundary))).state, 'passed');
});

test('empty directory presence and original modes change artifact commitments', async t => {
  const { selection } = await fixture(t);
  const commitments: string[] = [];
  for (const variant of ['absent', 'present', 'mode'] as const) {
    if (variant === 'present') await mkdir(join(selection.producer, 'empty'), { mode: 0o700 });
    if (variant === 'mode') await chmod(join(selection.producer, 'empty'), 0o755);
    const fake = backend(selection);
    const owner = inertGradingOwner(selection, fake.boundary);
    const opened = await owner.open(binding);
    commitments.push(opened.binding.artifactDigest);
    assert.equal(await owner.close(), 'confirmed');
    for (const stream of [opened.transport.stdin, opened.transport.stdout, opened.transport.stderr]) stream.destroy();
    await rm(selection.retained, { recursive: true });
    await rm(selection.exchange, { recursive: true });
    await mkdir(selection.exchange);
  }
  assert.equal(new Set(commitments).size, 3);
});

for (const mutation of ['add', 'remove', 'mode'] as const) {
  test(`empty directory ${mutation} during grading prevents success`, async t => {
    const { selection } = await fixture(t);
    await mkdir(join(selection.producer, 'empty'));
    const fake = backend(selection, { pass: true });
    const attach = fake.boundary.attach;
    fake.boundary.attach = async command => {
      if (mutation === 'add') await mkdir(join(selection.exchange, 'added'));
      if (mutation === 'remove') await rm(join(selection.exchange, 'empty'), { recursive: true });
      if (mutation === 'mode') await chmod(join(selection.exchange, 'empty'), 0o777);
      return attach(command);
    };
    assert.equal((await superviseAuthorization(binding, inertGradingOwner(selection, fake.boundary))).state, 'cleanup-pending');
    assert.deepEqual(await fs.readdir(join(selection.retained, 'empty')), []);
  });
}

test('nonempty destination rejects after one entry and closes its directory handle', async t => {
  const { selection } = await fixture(t);
  await Promise.all(Array.from({ length: 20 }, (_, i) => mkdir(join(selection.exchange, `empty-${i}`))));
  const original = fs.opendir;
  let reads = 0, closes = 0;
  const listing = t.mock.method(fs, 'readdir');
  const opening = t.mock.method(fs, 'opendir', async (...args: Parameters<typeof original>) => {
    const dir = await original(...args);
    if (args[0] === selection.exchange) {
      const read = dir.read.bind(dir), close = dir.close.bind(dir);
      t.mock.method(dir, 'read', async () => { reads++; return read(); });
      t.mock.method(dir, 'close', async () => { closes++; return close(); });
    }
    return dir;
  });
  syncBuiltinESMExports();
  t.after(() => { opening.mock.restore(); listing.mock.restore(); syncBuiltinESMExports(); });
  const fake = backend(selection);
  await assert.rejects(inertGradingOwner(selection, fake.boundary).open(binding), /Nonempty artifact destination/);
  assert.equal(reads, 1);
  assert.equal(closes, 1);
  assert.equal(listing.mock.callCount(), 0);
  assert.equal(fake.calls.filter(c => c.args[0] === 'create').length, 0);
});

test('cancellation during directory enumeration stops reads and closes the handle', async t => {
  const { selection } = await fixture(t);
  const controller = new AbortController();
  const reason = new Error('cancel enumeration');
  const original = fs.opendir;
  let reads = 0, closes = 0;
  const opening = t.mock.method(fs, 'opendir', async (...args: Parameters<typeof original>) => {
    const dir = await original(...args);
    if (args[0] === selection.producer) {
      const read = dir.read.bind(dir), close = dir.close.bind(dir);
      t.mock.method(dir, 'read', async () => {
        reads++;
        const entry = await read();
        controller.abort(reason);
        return entry;
      });
      t.mock.method(dir, 'close', async () => { closes++; return close(); });
    }
    return dir;
  });
  syncBuiltinESMExports();
  t.after(() => { opening.mock.restore(); syncBuiltinESMExports(); });
  const fake = backend(selection);
  await assert.rejects(inertGradingOwner(selection, fake.boundary).open(binding, controller.signal), error => error === reason);
  assert.equal(reads, 1);
  assert.equal(closes, 1);
  assert.equal(fake.calls.filter(c => c.args[0] === 'create').length, 0);
});

test('owned snapshot evidence binds original modes and approved index to retained materialization and result', async t => {
  const { selection, root } = await fixture(t);
  const { createFixture, snapshot } = await import('../src/fixture.ts');
  const { readTree } = await import('../src/grading-owner.ts');
  const { approvedGitDigest } = await import('../src/grading-snapshot.ts');
  selection.producer = join(root, 'repository');
  await createFixture(selection.producer, { files: { 'src/users.mjs': 'authored inert bytes' }, staged: {}, untracked: {} });
  await chmod(join(selection.producer, 'src/users.mjs'), 0o755);
  await mkdir(join(selection.producer, 'empty'));
  selection.snapshotGitDigest = approvedGitDigest(await readTree(selection.producer));
  const expected = await snapshot(selection.producer);
  const owner = inertGradingOwner(selection, backend(selection, { pass: true }).boundary);
  assert.equal((await superviseAuthorization(binding, owner)).state, 'passed');
  const evidence = await owner.snapshotEvidence!();
  assert.deepEqual(evidence.snapshot, expected);
  assert.equal(evidence.binding.attemptId, binding.attemptId);
  assert.equal(evidence.gitDigest, selection.snapshotGitDigest);
  assert.equal((await fs.stat(join(selection.retained, 'src/users.mjs'))).mode & 0o777, 0o600);
  assert.equal(evidence.manifest.find(e => e.path === 'src/users.mjs')?.mode, 0o755);
  assert.match(evidence.snapshotDigest, /^[a-f0-9]{64}$/);
  await chmod(join(selection.retained, 'empty'), 0o777);
  await assert.rejects(owner.snapshotEvidence!(), /altered/);
});

test('supervisor returns detached effective owned binding, not the requested placeholders', async t => {
  const { selection } = await fixture(t);
  const owner = inertGradingOwner(selection, backend(selection, { pass: true }).boundary);
  const result = await superviseAuthorization(binding, owner);
  assert.equal(result.state, 'passed');
  assert.equal(result.binding?.attemptId, binding.attemptId);
  assert.notEqual(result.binding?.artifactDigest, binding.artifactDigest);
  assert.equal(result.binding?.observerDigest, hash(JSON.stringify(selection.sources)));
});

test('ambiguous create never resolves ownership or removes a collision by name', async t => {
  const { selection } = await fixture(t);
  const fake = backend(selection);
  const original = fake.boundary.control;
  fake.boundary.control = async command => {
    if (command.args[0] === 'create') {
      await original(command); // daemon may create despite losing the reply
      throw new Error('lost create reply');
    }
    return original(command);
  };
  const owner = inertGradingOwner(selection, fake.boundary);
  await assert.rejects(owner.open(binding));
  assert.equal(await owner.close(), 'uncertain');
  assert.equal(fake.calls.filter(c => c.args[0] === 'rm' && c.args.at(-1) !== producerId).length, 0);
  assert.equal(fake.calls.filter(c => c.args[0] === 'inspect' && c.args.at(-1)?.startsWith('guild-grade-')).length, 0);
});
