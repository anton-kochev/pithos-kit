import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { inertDockerBoundary, type DockerSpawn } from '../src/grading-docker.ts';
const selected = { executable: '/reviewed/docker', endpoint: 'unix:///private/docker.sock', config: '/private/config' };
const id = 'a'.repeat(64);
function fixture(reply: (child: any) => void) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: (_signal: string) => { queueMicrotask(() => child.emit('close', null, 'SIGKILL')); return true; } });
  const calls: unknown[][] = [];
  const spawn: DockerSpawn = (file, args, options) => { calls.push([file, args, options]); queueMicrotask(() => reply(child)); return child as unknown as ReturnType<DockerSpawn>; };
  return { boundary: inertDockerBoundary(selected, spawn), calls, child };
}
test('fixed absolute Docker argv and empty inherited environment through inert spawn', async () => {
  const f = fixture(c => { c.stdout.end('ok'); c.emit('close', 0, null); });
  assert.equal((await f.boundary.control({ file: 'docker', args: ['rm', '--force', id] })).stdout.toString(), 'ok');
  assert.deepEqual(f.calls, [[selected.executable, ['--host', selected.endpoint, '--config', selected.config, 'rm', '--force', id], { shell: false, env: {}, stdio: ['pipe', 'pipe', 'pipe'] }]]);
});
test('rejects arbitrary commands and removal by name without spawn', async () => {
  const f = fixture(() => {});
  for (const args of [['version'], ['rm', '--force', 'guild-grade-collision'], ['inspect', id]]) await assert.rejects(f.boundary.control({ file: 'docker', args }));
  assert.equal(f.calls.length, 0);
});
for (const [name, reply] of Object.entries({ overflow: (c: any) => c.stdout.write(Buffer.alloc(65537)), combined: (c: any) => { c.stdout.write(Buffer.alloc(32768)); c.stderr.write(Buffer.alloc(32769)); }, utf8: (c: any) => { c.stdout.write(Buffer.from([255])); c.emit('close', 0, null); }, signal: (c: any) => c.emit('close', null, 'SIGTERM'), error: (c: any) => { c.emit('error', new Error('lost')); c.emit('close', -1, null); } })) {
  test(`bounded control rejects ${name}`, async () => {
    const f = fixture(reply);
    await assert.rejects(f.boundary.control({ file: 'docker', args: ['rm', '--force', id] }));
    assert.equal(f.child.listenerCount('close'), 0);
    assert.equal(f.child.stdout.listenerCount('data'), 0);
  });
}
test('abort kills and reaps client but does not attest container destruction', async () => {
  const f = fixture(() => {}), abort = new AbortController();
  const result = f.boundary.control({ file: 'docker', args: ['rm', '--force', id] }, abort.signal);
  abort.abort();
  await assert.rejects(result);
  assert.equal(f.child.listenerCount('close'), 0);
});
test('client timeout remains failure after reap', async () => {
  const f = fixture(() => {});
  await assert.rejects(f.boundary.control({ file: 'docker', args: ['rm', '--force', id] }), /deadline/);
  assert.equal(f.child.listenerCount('close'), 0);
});
test('unselected endpoint and traversal are rejected without spawn', () => {
  for (const selection of [{ ...selected, executable: 'docker' }, { ...selected, config: '/private/../config' }, { ...selected, endpoint: 'tcp://localhost:2375' }]) {
    assert.throws(() => inertDockerBoundary(selection, () => { throw new Error('must not spawn'); }), /Unselected/);
  }
});
test('attach exposes bounded pipes and cancellation kills client', async () => {
  const f = fixture(() => {}), abort = new AbortController();
  const pipes = await f.boundary.attach({ file: 'docker', args: ['start', '--attach', '--interactive', id] }, abort.signal);
  assert.notEqual(pipes.stdin, f.child.stdin);
  abort.abort();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pipes.stdout.destroyed, true);
});
for (const name of ['stdin-error', 'stdout-error', 'stderr-error', 'unreaped', 'late-error']) test(`bounded real spawn seam handles ${name}`, async () => {
  const f = fixture(c => {
    if (name.endsWith('-error') && name !== 'late-error') c[name.split('-')[0]].emit('error', new Error('inert stream failure'));
    else { c.kill = () => true; c.emit('error', new Error('inert lost client')); }
  });
  await assert.rejects(f.boundary.control({ file: 'docker', args: ['rm', '--force', id] }));
  f.child.emit('error', new Error('late error'));
  f.child.stdout.emit('error', new Error('late pipe error'));
});
test('attach bounds combined output and reports abnormal completion', async () => {
  const f = fixture(() => {});
  const pipes = await f.boundary.attach({ file: 'docker', args: ['start', '--attach', '--interactive', id] });
  f.child.stdout.write(Buffer.alloc(8 * 1024 * 1024 + 1));
  await assert.rejects(pipes.clientClosed!);
  assert.equal(pipes.stdout.destroyed, true);
});
test('attach retains backpressure and rejects stream error without destruction attestation', async () => {
  const f = fixture(() => {});
  const pipes = await f.boundary.attach({ file: 'docker', args: ['start', '--attach', '--interactive', id] });
  pipes.stdin.write(Buffer.alloc(1024 * 1024));
  assert.equal(pipes.stdin.write(Buffer.alloc(1024 * 1024)), false);
  f.child.stdin.emit('error', new Error('blocked write'));
  await assert.rejects(pipes.clientClosed!);
});
test('create accepts only the detached selected exact plan, never extra private mounts', async () => {
  const { gradingCommand } = await import('../src/grading-owner.ts');
  const grading = { image: 'sha256:' + 'b'.repeat(64), uid: 1000, gid: 1000, code: '/public/code', producer: '/producer', retained: '/private/retained', exchange: '/exchange',
    sources: { 'grading-bootstrap.ts': id, 'grading-observer.ts': id }, imageFiles: { '/usr/bin/env': id, '/usr/bin/node': id }, producerIdentity: { id, image: 'sha256:' + id, name: 'guild-grade-producer' } };
  const f = fixture(c => { c.stdout.end(id); c.stderr.end(); c.emit('close', 0, null); });
  const command = gradingCommand(grading, 'guild-grade-selected');
  await assert.rejects(f.boundary.control(command));
  const boundary = inertDockerBoundary({ ...selected, grading }, (_file, args, _options) => {
    f.calls.push(args); queueMicrotask(() => { f.child.stdout.end(id); f.child.stderr.end(); f.child.emit('close', 0, null); });
    return f.child as unknown as ReturnType<DockerSpawn>;
  });
  grading.exchange = '/private/changed';
  const changed = structuredClone(command); changed.args.splice(1, 0, '--mount', 'type=bind,source=/private/retained,target=/private');
  await assert.rejects(boundary.control(changed));
  assert.equal((await boundary.control(command)).stdout.toString(), id);
  assert.equal(f.calls.length, 1);
});
