import assert from 'node:assert/strict';
import test from 'node:test';
import { preparation } from './inert-container-fixture.ts';
import { submitInertProducerCreate } from '../src/producer-launcher.ts';
import { prepareDiagnosticAuth, commitDiagnosticAuth, runDiagnosticContainer, diagnosticState } from '../src/diagnostic-auth-transport.ts';
import { issueRegisteredFinalizationOrigin, finalizeOwnedTrial, auditRetainedFinalization } from '../src/trial-finalization.ts';

test('container diagnostic original attempt connects commitment, spawn, cleanup and retained v2 audit', async t => {
  const p = await preparation(t, '', true);
  await submitInertProducerCreate(p.attempt, p.fake.launch);
  await prepareDiagnosticAuth(p.attempt);
  assert.equal(diagnosticState(p.attempt), 'bound');
  commitDiagnosticAuth(p.attempt);
  await runDiagnosticContainer(p.attempt);
  assert.equal(diagnosticState(p.attempt), 'cleanup-pending');
  const origin = await issueRegisteredFinalizationOrigin(p.deployment, p.attempt, p.storage);
  const result = await finalizeOwnedTrial(origin, p.directory, p.identity, p.task, p.baseline);
  assert.equal(result.finalization.version, 2);
  assert.equal(result.finalization.state, 'completed');
  assert.equal(diagnosticState(p.attempt), 'closed');
  const retained = await auditRetainedFinalization(p.directory, p.identity, p.task, p.baseline, result.finalization);
  assert.deepEqual(retained.grade, result.grade);
  assert(!retained.raw.includes('synthetic-secret-'));
  assert(!retained.raw.includes('synthetic-account-'));
});
test('uncommitted container cannot release or finalize', async t => {
  const p = await preparation(t, '', true);
  await submitInertProducerCreate(p.attempt, p.fake.launch);
  await prepareDiagnosticAuth(p.attempt);
  await assert.rejects(runDiagnosticContainer(p.attempt));
  await assert.rejects(issueRegisteredFinalizationOrigin(p.deployment, p.attempt, p.storage));
});

for (const fault of ['scope-missing', 'scope-reordered', 'lease-clone', 'lease-disposed', 'local-replacement', 'missing-file-ack', 'missing-endpoint-ack', 'cancel'] as const) {
  test(`diagnostic ${fault} blocks finalization and revokes before cleanup`, async t => {
    const p = await preparation(t, '', true);
    await submitInertProducerCreate(p.attempt, p.fake.launch);
    await prepareDiagnosticAuth(p.attempt); commitDiagnosticAuth(p.attempt);
    await assert.rejects(runDiagnosticContainer(p.attempt, fault));
    assert.equal(diagnosticState(p.attempt), 'cleanup-pending');
    await assert.rejects(issueRegisteredFinalizationOrigin(p.deployment, p.attempt, p.storage));
    assert.equal(p.fake.removed.size, 0);
    await assert.rejects(runDiagnosticContainer(p.attempt));
  });
}
test('uncertain full-ID owner destruction cannot close diagnostic lifecycle', async t => {
  const p = await preparation(t, 'producer-uncertain', true);
  await submitInertProducerCreate(p.attempt, p.fake.launch);
  await prepareDiagnosticAuth(p.attempt); commitDiagnosticAuth(p.attempt); await runDiagnosticContainer(p.attempt);
  const origin = await issueRegisteredFinalizationOrigin(p.deployment, p.attempt, p.storage);
  const result = await finalizeOwnedTrial(origin, p.directory, p.identity, p.task, p.baseline);
  assert.equal(result.finalization.state, 'pending'); assert.equal(result.grade, undefined);
  assert.equal(diagnosticState(p.attempt), 'cleanup-pending');
});
test('clone, replay and cross-attempt diagnostic handles do not transfer authority', async t => {
  const p = await preparation(t, '', true), q = await preparation(t, '', true);
  await submitInertProducerCreate(p.attempt, p.fake.launch); await submitInertProducerCreate(q.attempt, q.fake.launch);
  await assert.rejects(prepareDiagnosticAuth(structuredClone(p.attempt)));
  await prepareDiagnosticAuth(p.attempt); await assert.rejects(prepareDiagnosticAuth(p.attempt));
  assert.throws(() => commitDiagnosticAuth(q.attempt));
  commitDiagnosticAuth(p.attempt); assert.throws(() => commitDiagnosticAuth(p.attempt));
  await runDiagnosticContainer(p.attempt); await assert.rejects(runDiagnosticContainer(p.attempt));
  await assert.rejects(issueRegisteredFinalizationOrigin(q.deployment, q.attempt, p.storage));
});

test('shared retained audit rederives namespace, auth and cleanup, not a success summary', async t => {
  const { readFile, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const { digest } = await import('../src/manifest.ts');
  const p = await preparation(t, '', true);
  await submitInertProducerCreate(p.attempt, p.fake.launch);
  await prepareDiagnosticAuth(p.attempt); commitDiagnosticAuth(p.attempt); await runDiagnosticContainer(p.attempt);
  const origin = await issueRegisteredFinalizationOrigin(p.deployment, p.attempt, p.storage);
  const result = await finalizeOwnedTrial(origin, p.directory, p.identity, p.task, p.baseline);
  assert.equal(result.finalization.state, 'completed');
  if (result.finalization.state !== 'completed') return;
  const file = join(p.data.retention.trialParent, '.finalization', p.identity.trialId, 'finalization.json');
  const original = JSON.parse(await readFile(file, 'utf8'));
  const mutations: [string, (r: any) => void][] = [
    ['old runtime', r => { r.container.evidence.envelope.runtime.pi = '0.85.1'; }],
    ['namespace', r => { r.container.evidence.envelope.processes[0].process.namespace = digest('wrong'); }],
    ['creator', r => { r.container.evidence.envelope.processes[0].parent.pid++; }],
    ['Docker PID substitution', r => { r.container.evidence.envelope.processes[0].parent = r.container.expected.dockerClient; }],
    ['endpoint', r => { r.container.expected.binding.endpoint = 'unix:///wrong.sock'; r.container.evidence.expected = r.container.expected; }],
    ['full ID', r => { r.container.evidence.cleanup.ownerId = 'a'.repeat(64); }],
    ['missing cleanup', r => { delete r.container.evidence.cleanup.localFile; }],
    ['uncertain cleanup', r => { r.container.evidence.cleanup.localFile = 'uncertain'; }],
    ['reordered lifecycle', r => { r.container.evidence.transitions.reverse(); }],
    ['replayed spawn', r => { r.container.evidence.envelope.processes.push(r.container.evidence.envelope.processes[0]); }],
    ['auth replacement', r => { r.container.evidence.localAuth.ino += '1'; }],
    ['auth bytes', r => { r.container.evidence.localAuth.fileDigest = digest('other'); }],
    ['forged trusted auth', r => { r.container.observedAuth.local.ino += '1'; }],
    ['expired at observation', r => { r.container.evidence.observedAt = r.container.evidence.hostAuth.expires; }],
    ['self-consistent replacement', r => {
      const e = r.container.evidence, b = e.expected.binding; e.localAuth.ino += '1';
      e.authBinding = digest({ intent: b.intentDigest, host: e.hostAuth, local: e.localAuth, receiver: b.receiver, namespace: b.namespace });
    }],
    ['cross-attempt', r => { r.container.evidence.expected.binding.identity.requestDigest = digest('other'); }],
    ['missing v2 evidence', r => { delete r.container; }],
    ['downgraded record', r => { r.version = 1; delete r.container; }],
    ['claimed success', r => { r.container.evidence.success = true; }],
  ];
  for (const [name, mutate] of mutations) {
    const record = structuredClone(original); mutate(record);
    const raw = JSON.stringify(record); await writeFile(file, raw);
    await assert.rejects(auditRetainedFinalization(p.directory, p.identity, p.task, p.baseline,
      { ...result.finalization, recordDigest: createHash('sha256').update(raw).digest('hex') }), name);
  }
  await writeFile(file, JSON.stringify(original));
});

test('pre-aborted owned channel blocks release; operational transport stays closed', async t => {
  const { provisionDiagnosticAuthTransport } = await import('../src/diagnostic-auth-transport.ts');
  assert.throws(provisionDiagnosticAuthTransport, /CLOSED/);
  const p = await preparation(t, '', true);
  await submitInertProducerCreate(p.attempt, p.fake.launch); await prepareDiagnosticAuth(p.attempt); commitDiagnosticAuth(p.attempt);
  await assert.rejects(runDiagnosticContainer(p.attempt, '', AbortSignal.abort()));
  assert.equal(diagnosticState(p.attempt), 'cleanup-pending');
  await assert.rejects(issueRegisteredFinalizationOrigin(p.deployment, p.attempt, p.storage));
});
test('historical attempts cannot silently acquire container evidence', async t => {
  const p = await preparation(t);
  await submitInertProducerCreate(p.attempt, p.fake.launch);
  await assert.rejects(prepareDiagnosticAuth(p.attempt));
});

// Regression list: cancellation at both cleanup awaits; elapsed run deadline;
// failed lease deletion must not skip independent resource cleanup.
for (const phase of ['lease', 'source'] as const) {
  test(`abort during ${phase} cleanup is latched without a finalization signal`, async t => {
    const fs = (await import('node:fs/promises')).default;
    const { syncBuiltinESMExports } = await import('node:module');
    const p = await preparation(t, '', true);
    await submitInertProducerCreate(p.attempt, p.fake.launch);
    await prepareDiagnosticAuth(p.attempt); commitDiagnosticAuth(p.attempt);
    const controller = new AbortController(), remove = fs.rm;
    let interrupted = false, sourceRemoved = false;
    const mock = t.mock.method(fs, 'rm', async (path: Parameters<typeof fs.rm>[0], options: Parameters<typeof fs.rm>[1]) => {
      const lease = String(path).includes('/guild-codex-');
      if (String(path).includes('/guild-diagnostic-')) {
        if ((phase === 'lease') === lease) { interrupted = true; controller.abort('synthetic-secret-abort'); }
        if (!lease) sourceRemoved = true;
      }
      return remove(path, options);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(runDiagnosticContainer(p.attempt, '', controller.signal));
      assert(interrupted); assert(sourceRemoved);
      assert.equal(diagnosticState(p.attempt), 'cleanup-pending');
      await assert.rejects(issueRegisteredFinalizationOrigin(p.deployment, p.attempt, p.storage));
    } finally { mock.mock.restore(); syncBuiltinESMExports(); }
  });
}

for (const phase of ['provision', 'lease', 'source'] as const) {
  test(`elapsed execution deadline during ${phase} blocks diagnostic success`, async t => {
    const fs = (await import('node:fs/promises')).default;
    const { syncBuiltinESMExports } = await import('node:module');
    const p = await preparation(t, '', true);
    await submitInertProducerCreate(p.attempt, p.fake.launch);
    await prepareDiagnosticAuth(p.attempt); commitDiagnosticAuth(p.attempt);
    let now = 0, elapsed = false;
    t.mock.method(performance, 'now', () => now);
    const remove = fs.rm, write = fs.writeFile;
    const removal = t.mock.method(fs, 'rm', async (path: Parameters<typeof fs.rm>[0], options: Parameters<typeof fs.rm>[1]) => {
      if (String(path).includes('/guild-diagnostic-') &&
        ((phase === 'lease' && String(path).includes('/guild-codex-')) ||
         (phase === 'source' && !String(path).includes('/guild-codex-')))) { now = 300001; elapsed = true; }
      return remove(path, options);
    });
    const writing = t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
      await write(...args);
      if (phase === 'provision' && String(args[0]).endsWith('/source.json')) { now = 300001; elapsed = true; }
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(runDiagnosticContainer(p.attempt));
      assert(elapsed);
      await assert.rejects(issueRegisteredFinalizationOrigin(p.deployment, p.attempt, p.storage));
    } finally { removal.mock.restore(); writing.mock.restore(); syncBuiltinESMExports(); }
  });
}

test('lease deletion failure still closes endpoint, clears transit and removes source/receiver', async t => {
  const fs = (await import('node:fs/promises')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { PassThrough } = await import('node:stream');
  const p = await preparation(t, '', true);
  await submitInertProducerCreate(p.attempt, p.fake.launch);
  await prepareDiagnosticAuth(p.attempt); commitDiagnosticAuth(p.attempt);
  const remove = fs.rm, read = fs.readFile, destroy = PassThrough.prototype.destroy;
  let root = '', attempted = false, closed = false, transit: Buffer | undefined;
  const removal = t.mock.method(fs, 'rm', async (path: Parameters<typeof fs.rm>[0], options: Parameters<typeof fs.rm>[1]) => {
    if (String(path).includes('/guild-diagnostic-')) {
      if (String(path).includes('/guild-codex-')) throw new Error('synthetic-secret-removal');
      root = String(path); attempted = true;
    }
    return remove(path, options);
  });
  const reading = t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
    const bytes = await read(...args);
    if (String(args[0]).includes('/guild-diagnostic-') && Buffer.isBuffer(bytes)) transit = bytes;
    return bytes;
  });
  const destruction = t.mock.method(PassThrough.prototype, 'destroy', function(this: InstanceType<typeof PassThrough>, ...args: Parameters<typeof destroy>) {
    closed = true; return destroy.apply(this, args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(runDiagnosticContainer(p.attempt), error => {
      assert(!String(error).includes('synthetic-secret')); return true;
    });
    assert(attempted, 'source/receiver cleanup must follow rejected lease disposal');
    assert(closed); assert(transit?.every(byte => byte === 0));
    await assert.rejects(fs.lstat(root), { code: 'ENOENT' });
    await assert.rejects(issueRegisteredFinalizationOrigin(p.deployment, p.attempt, p.storage));
  } finally {
    removal.mock.restore(); reading.mock.restore(); destruction.mock.restore(); syncBuiltinESMExports();
    // The fixture root can be inferred from the failed deletion even on red.
    for (const call of removal.mock.calls) {
      const path = String(call.arguments[0]);
      if (path.includes('/guild-diagnostic-')) await remove(path.split('/guild-codex-')[0], { recursive: true, force: true });
    }
  }
});

test('run deadline bounds a pending filesystem await without extending the trial window', async t => {
  const fs = (await import('node:fs/promises')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { default: events } = await import('node:events');
  const p = await preparation(t, '', true);
  await submitInertProducerCreate(p.attempt, p.fake.launch);
  await prepareDiagnosticAuth(p.attempt); commitDiagnosticAuth(p.attempt);
  const controller = new AbortController(), write = fs.writeFile;
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const writing = t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
    await write(...args);
    if (String(args[0]).endsWith('/source.json')) { entered(); await pending; }
  });
  syncBuiltinESMExports();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const run = runDiagnosticContainer(p.attempt, '', controller.signal);
  let settled = false;
  const result = run.then(() => { settled = true; return 'success'; }, () => { settled = true; return 'failed'; });
  try {
    await waiting;
    t.mock.timers.tick(300000);
    t.mock.timers.tick(500); // existing owned-cleanup ceiling, not another trial window
    await new Promise<void>(resolve => setImmediate(resolve));
    assert(settled, 'deadline must bound the returned run even if filesystem IO is pending');
    assert.equal(await result, 'failed');
    assert.equal(events.getEventListeners(controller.signal, 'abort').length, 0);
    await assert.rejects(issueRegisteredFinalizationOrigin(p.deployment, p.attempt, p.storage));
  } finally {
    release();
    // Uncancellable filesystem operations remain owned and clean up on settlement.
    for (let i = 0; i < 100 && diagnosticState(p.attempt) !== 'cleanup-pending'; i++) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    writing.mock.restore(); syncBuiltinESMExports();
  }
});
