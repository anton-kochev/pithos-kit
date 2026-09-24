import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { DockerGradingSelection } from '../src/grading-composition.ts';
import { readTree, type GradingSelection } from '../src/grading-owner.ts';
import { approvedGitDigest } from '../src/grading-snapshot-core.ts';
import { decodeSnapshotRequest, encodeSnapshotResponse } from '../src/grading-snapshot-protocol.ts';
import type { DockerSpawn } from '../src/grading-docker.ts';
const hash = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
export async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'docker-composition-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ['code', 'exporter', 'producer', 'private', 'exchange', 'producer/src', 'producer/.git']) await mkdir(join(root, path));
  await writeFile(join(root, 'producer/src/users.mjs'), 'inert never executed', { mode: 0o751 });
  await writeFile(join(root, 'producer/.git/HEAD'), 'ref: refs/heads/eval\n');
  await writeFile(join(root, 'producer/.git/index'), 'authored inert not real Git');
  const sources: Record<string, string> = {}, exporter: Record<string, string> = {};
  for (const name of ['grading-bootstrap.ts', 'grading-observer.ts']) { await writeFile(join(root, 'code', name), name); sources[name] = hash(name); }
  for (const name of ['grading-snapshot-bootstrap.ts', 'grading-snapshot-core.ts', 'grading-snapshot-protocol.ts']) { await writeFile(join(root, 'exporter', name), name); exporter[name] = hash(name); }
  const grading: GradingSelection = { code: join(root, 'code'), producer: join(root, 'producer'), retained: join(root, 'private/result'), exchange: join(root, 'exchange'),
    uid: 1000, gid: 1000, image: 'sha256:' + 'a'.repeat(64), sources, imageFiles: { '/usr/bin/env': hash('inert'), '/usr/bin/node': hash('inert') },
    producerIdentity: { id: 'c'.repeat(64), name: 'guild-grade-producer', image: 'sha256:' + 'b'.repeat(64) } };
  grading.snapshotGitDigest = approvedGitDigest(await readTree(grading.producer));
  const selection: DockerGradingSelection = { docker: { executable: '/reviewed/docker', endpoint: 'unix:///private/docker.sock', config: '/private/config' }, grading, exporter: { code: join(root, 'exporter'), sources: exporter } };
  return selection;
}
export function backend(s: DockerGradingSelection, fault = '', producerCode = s.grading.code, producerCommand?: string[]) {
  const calls: string[][] = [], names = new Map<string, string>(), removed = new Set<string>();
  const exporterId = 'd'.repeat(64), graderId = 'e'.repeat(64);
  let releasedBeforeRemoval = false, producerInspections = 0;
  const launch: DockerSpawn = (_file, argv, options) => {
    assert.deepEqual(options.env, {});
    const args = argv.slice(4); calls.push(args);
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => { queueMicrotask(() => child.emit('close', null, 'SIGKILL')); return true; } });
    const done = (text = '', code = 0) => { child.stdout.end(text); child.stderr.end(); child.emit('close', code, null); };
    queueMicrotask(() => {
      const id = args.at(-1)!;
      if (args[0] === 'create') {
        const producer = args.at(-1)!.includes('native-preload');
        if (producer) {
          names.set(s.grading.producerIdentity.id, args[2]);
          if (fault === 'producer-unknown-id') return done('unknown');
          if (fault === 'producer-collision') return done('collision', 1);
          if (fault === 'producer-late-id') { setTimeout(() => done(s.grading.producerIdentity.id), 550); return; }
          return done(s.grading.producerIdentity.id);
        }
        const exporter = args.at(-1)!.includes('snapshot');
        if (!exporter && !removed.has(exporterId)) releasedBeforeRemoval = true;
        names.set(exporter ? exporterId : graderId, args[2]);
        if (fault === 'late-id') { setTimeout(() => done(exporterId), 550); return; }
        if (fault === 'collision') return done('collision', 1);
        if (fault === 'unknown-id') return done('not-a-full-id');
        return done(exporter ? exporterId : graderId);
      }
      if (args[0] === 'inspect') {
        const producer = id === s.grading.producerIdentity.id, exporter = id === exporterId;
        if (producer) producerInspections++;
        const name = producer ? s.grading.producerIdentity.name : names.get(id)!;
        const wrongMount = producer && (fault === 'producer-mount' || (fault === 'producer-remount' && producerInspections === 3));
        return done(JSON.stringify({ Id: id, Name: '/' + name, Image: producer ? (fault === 'producer-image' ? 'sha256:' + 'f'.repeat(64) : s.grading.producerIdentity.image) : s.grading.image,
          Config: { ...(producerCommand && producer ? { Cmd: producerCommand.slice(producerCommand.indexOf(s.grading.producerIdentity.image) + 1) } : {}), User: '1000:1000', WorkingDir: '/evidence', Entrypoint: ['/usr/bin/env'], Labels: { 'pithos.guild.grading-owner': producer && fault === 'producer-token' ? 'wrong-token' : name }, Volumes: null },
          HostConfig: { Init: true, UTSMode: '', Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=64m,mode=1777' }, NetworkMode: 'none', Privileged: false, ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges=true'], PidsLimit: 64, Memory: 536870912, NanoCpus: 1000000000, PidMode: '', IpcMode: 'private', Devices: [], Binds: null },
          Mounts: [{ Type: 'bind', Source: exporter ? (fault === 'private-mount' ? s.grading.retained : s.exporter.code) : producer ? (wrongMount ? s.grading.code : producerCode) : s.grading.code, Destination: '/harness/guild', RW: false },
            { Type: 'bind', Source: producer ? s.grading.producer : s.grading.exchange, Destination: '/evidence', RW: !exporter }],
        }));
      }
      if (args[0] === 'rm') { removed.add(id); return done(); }
      if (args[0] === 'container') return done(fault === 'uncertain-destruction' && args.includes('id=' + exporterId) ? exporterId
        : fault === 'producer-uncertain' && args.includes('id=' + s.grading.producerIdentity.id) ? s.grading.producerIdentity.id : '');
      if (args[0] === 'start' && id === exporterId) {
        const chunks: Buffer[] = [];
        child.stdin.on('data', b => chunks.push(Buffer.from(b)));
        child.stdin.on('end', () => {
          const request = decodeSnapshotRequest(Buffer.concat(chunks));
          const files: any = {};
          for (const [path, e] of request.tree) if (e.kind === 'file' && !path.startsWith('.git/')) files[path] = { kind: 'file', digest: hash(e.bytes), mode: e.mode };
          const bytes = encodeSnapshotResponse({ files, index: 'inert', status: '', diff: '' }, request);
          done(fault === 'bad-frame' ? '{}\n' : bytes.toString());
        });
        return;
      }
      if (args[0] === 'start') {
        child.stdin.on('data', bytes => {
          const r = JSON.parse(bytes.toString()), allowed = [0, 2].includes(r.caseId);
          child.stdout.write(JSON.stringify({ version: 1, caseId: r.caseId, attemptId: r.attemptId, gradingRunId: r.gradingRunId, artifactDigest: r.artifactDigest, observerDigest: r.observerDigest,
            saves: allowed ? 1 : 0, invalidSave: fault === 'rejected', settlement: allowed ? 'saved' : 'rejected', sameThrownObject: r.caseId === 6, overflow: false }) + '\n');
        });
        return;
      }
      throw new Error('Unexpected inert command');
    });
    return child as unknown as ReturnType<DockerSpawn>;
  };
  return { launch, calls, removed, early: () => releasedBeforeRemoval };
}
