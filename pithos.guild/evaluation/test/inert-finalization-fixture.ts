import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { type GradingSelection, type GradingCommand } from '../src/grading-owner.ts';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const producerId = 'c'.repeat(64), graderId = 'd'.repeat(64);
export async function fixture(t: TestContext) {
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
export function backend(s: GradingSelection, options: { uncertain?: boolean; launchFailure?: boolean; mutation?: boolean; forgedOwner?: boolean; policyDrift?: boolean; userDrift?: boolean; mappingDrift?: boolean; modeMutation?: boolean; pass?: boolean } = {}) {
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
