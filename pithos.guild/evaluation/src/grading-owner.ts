// Supervisor-private preparation. No operational backend.
// The only adapter constructor is explicitly inert/test-only. A command plan is
// not evidence of Docker policy, image provenance or independent destruction.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { inertSnapshotExport } from './grading-snapshot.ts';
import type { Snapshot } from './fixture.ts';
import type { GradingBinding } from './grading-observer.ts';
import type { GradingProcessTransport } from './grading-transport.ts';
import { assertProducerAttemptPolicy, producerAttemptSelection, type ProducerAttempt } from './producer-launcher.ts';
import { digest as canonicalDigest } from './manifest.ts';

export interface GradingSelection {
  snapshotGitDigest?: string; // Supervisor-approved unborn index/objects, never candidate authorization.
  image: string;
  uid: number;
  gid: number;
  code: string;
  producer: string;
  retained: string;
  exchange: string;
  sources: Record<string, string>;
  imageFiles: Record<string, string>;
  producerIdentity: { id: string; name: string; image: string };
}
export interface GradingCommand { file: 'docker'; args: string[] }
export interface OwnedSnapshotEvidence {
  version: 1;
  binding: GradingBinding;
  gitDigest: string;
  materializationDigest: string;
  snapshotDigest: string;
  snapshot: Snapshot;
  manifest: { path: string; kind: 'file' | 'directory'; mode: number; digest?: string }[];
}
export interface OwnedGradingConnection {
  snapshotEvidence?(signal?: AbortSignal): Promise<OwnedSnapshotEvidence>;
  open(binding: GradingBinding, signal?: AbortSignal): Promise<{ binding: GradingBinding; transport: GradingProcessTransport }>;
  close(): Promise<'confirmed' | 'uncertain'>;
}
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const sourceNames = ['grading-bootstrap.ts', 'grading-observer.ts'];
const normalized = (path: string) => {
  if (!path.startsWith('/') || resolve(path) !== path || !/^\/[a-zA-Z0-9_./-]+$/.test(path) || path === '/') throw new Error('Unsafe grading path');
  return path;
};
function validate(s: GradingSelection) {
  if (!/^sha256:[a-f0-9]{64}$/.test(s.image)
    || ![s.uid, s.gid].every(v => Number.isSafeInteger(v) && v > 0 && v <= 2147483647)) throw new Error('Unreviewed grading identity');
  const paths = [s.code, s.producer, s.retained, s.exchange].map(normalized);
  if (paths.some((p, i) => paths.some((q, j) => i !== j && (p === q || p.startsWith(q + '/'))))) throw new Error('Overlapping grading roots');
  if (Object.keys(s.sources).sort().join(',') !== sourceNames.join(',')
    || Object.values(s.sources).some(v => !/^[a-f0-9]{64}$/.test(v))) throw new Error('Private or incomplete source roster');
  // Prepared executable roster only. A real loader/library/image inventory
  // has not been selected or approved and cannot be supplied operationally.
  if (Object.keys(s.imageFiles).sort().join(',') !== '/usr/bin/env,/usr/bin/node'
    || Object.values(s.imageFiles).some(v => !/^[a-f0-9]{64}$/.test(v))) throw new Error('Unreviewed image roster');
  if (!/^[a-f0-9]{64}$/.test(s.producerIdentity.id)
    || !/^guild-grade-[a-z0-9-]{1,64}$/.test(s.producerIdentity.name)
    || !/^sha256:[a-f0-9]{64}$/.test(s.producerIdentity.image)) throw new Error('Unbound producer owner');
}
export function gradingCommand(s: GradingSelection, name: string): GradingCommand {
  validate(s);
  if (!/^guild-grade-[a-z0-9-]{1,64}$/.test(name)) throw new Error('Invalid owned name');
  return { file: 'docker', args: ['create', '--name', name, '--label', `pithos.guild.grading-owner=${name}`,
    '--pull', 'never', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges=true', '--user', `${s.uid}:${s.gid}`, '--ipc', 'private', '--init',
    '--pids-limit', '64', '--memory', '512m', '--cpus', '1',
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777',
    '--mount', `type=bind,source=${s.code},target=/harness/guild,readonly`,
    '--mount', `type=bind,source=${s.exchange},target=/evidence`,
    '--workdir', '/evidence', '--interactive', '--entrypoint', '/usr/bin/env', s.image,
    '-i', 'PATH=/usr/bin:/bin', 'HOME=/tmp', 'TMPDIR=/tmp',
    '/usr/bin/node', '/harness/guild/grading-bootstrap.ts'] };
}

// Same fixed policy, separate public exporter roster and read-only evidence mount.
export function snapshotCommand(s: GradingSelection, code: string, name: string): GradingCommand {
  normalized(code);
  for (const root of [s.code, s.producer, s.retained, s.exchange]) {
    if (root === code || root.startsWith(code + '/') || code.startsWith(root + '/')) throw new Error('Overlapping exporter root');
  }
  const command = gradingCommand(s, name);
  command.args = command.args.map(arg => arg === `type=bind,source=${s.code},target=/harness/guild,readonly`
    ? `type=bind,source=${code},target=/harness/guild,readonly`
    : arg === `type=bind,source=${s.exchange},target=/evidence` ? arg + ',readonly'
    : arg === '/harness/guild/grading-bootstrap.ts' ? '/harness/guild/grading-snapshot-bootstrap.ts' : arg);
  return command;
}

// Refuse symlinks in *every* ancestor, not merely the leaf. This assumes a
// supervisor-owned parent and a quiescent tree after independent destruction.
// Node path APIs alone cannot defend a concurrently hostile mount/rename owner.
async function directory(path: string) {
  normalized(path);
  let current = '/';
  for (const part of path.split('/').filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe directory');
  }
}
export type Tree = Map<string, { kind: 'file'; bytes: Buffer; mode: number } | { kind: 'directory'; mode: number }>;
export async function readTree(root: string, signal?: AbortSignal): Promise<Tree> {
  await directory(root);
  const tree: Tree = new Map();
  let count = 0, files = 0, total = 0;
  const walk = async (relative: string) => {
    signal?.throwIfAborted();
    // Bound collection before sorting, including entries in empty directories.
    const names: string[] = [];
    const entries = await opendir(join(root, relative), { bufferSize: 1 });
    try {
      while (true) {
        signal?.throwIfAborted();
        const entry = await entries.read();
        signal?.throwIfAborted();
        if (!entry) break;
        if (++count > 2000 || relative.split('/').filter(Boolean).length >= 32) throw new Error('Artifact entry limit');
        const name = entry.name;
        if (!/^[a-zA-Z0-9_.-]+$/.test(name) || name === '.' || name === '..') throw new Error('Unsafe artifact name');
        names.push(name);
      }
    } finally { await entries.close(); }
    signal?.throwIfAborted();
    for (const name of names.sort()) {
      signal?.throwIfAborted();
      const path = relative ? `${relative}/${name}` : name;
      const absolute = join(root, path), before = await lstat(absolute);
      if (before.isDirectory()) {
        tree.set(path, { kind: 'directory', mode: before.mode & 0o777 });
        await walk(path);
        continue;
      }
      if (!before.isFile() || before.nlink !== 1 || ++files > 1000 || before.size > 8 * 1024 * 1024) throw new Error('Unsafe artifact file');
      total += before.size;
      if (total > 8 * 1024 * 1024) throw new Error('Artifact byte limit');
      const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const first = await file.stat();
        if (!first.isFile() || first.nlink !== 1 || first.dev !== before.dev || first.ino !== before.ino || first.size !== before.size) throw new Error('Artifact replacement');
        // A bounded read, not readFile on a potentially growing hostile file.
        const bytes = Buffer.alloc(first.size + 1);
        let length = 0;
        while (length < bytes.length) {
          signal?.throwIfAborted();
          const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
          if (!bytesRead) break;
          length += bytesRead;
        }
        const after = await file.stat(), leaf = await lstat(absolute);
        if (length !== first.size || after.size !== first.size || after.mtimeMs !== first.mtimeMs || after.ctimeMs !== first.ctimeMs
          || leaf.dev !== first.dev || leaf.ino !== first.ino || leaf.nlink !== 1) throw new Error('Artifact mutation');
        tree.set(path, { kind: 'file', bytes: bytes.subarray(0, length), mode: first.mode & 0o777 });
      } finally { await file.close(); }
    }
  };
  await walk('');
  return tree;
}
export const treeDigest = (tree: Tree) => digest(JSON.stringify([...tree].map(([path, file]) => file.kind === 'file' ? [path, file.kind, digest(file.bytes), file.mode] : [path, file.kind, file.mode])));
async function copyTree(tree: Tree, target: string, existing = false, signal?: AbortSignal) {
  await directory(dirname(target));
  if (!existing) await mkdir(target, { mode: 0o700 });
  await directory(target);
  signal?.throwIfAborted();
  const entries = await opendir(target, { bufferSize: 1 });
  try {
    signal?.throwIfAborted();
    const entry = await entries.read();
    signal?.throwIfAborted();
    if (entry) throw new Error('Nonempty artifact destination');
  } finally { await entries.close(); }
  for (const [path, file] of tree) {
    signal?.throwIfAborted();
    const dest = join(target, ...path.split('/'));
    if (file.kind === 'directory') {
      await mkdir(dest, { mode: 0o700 });
      continue;
    }
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
    await writeFile(dest, file.bytes, { flag: 'wx', mode: 0o600 });
  }
}

export interface GradingBoundary {
  control(command: GradingCommand, signal?: AbortSignal): Promise<{ code: number; stdout: Buffer; stderr: Buffer }>;
  attach(command: GradingCommand, signal?: AbortSignal): Promise<Omit<GradingProcessTransport, 'terminate'>>;
}
export function assertGradingPolicy(policy: any, s: GradingSelection, code = s.code, exporter = false) {
  const h = policy.HostConfig;
  if (policy.Config.User !== `${s.uid}:${s.gid}` || policy.Config.WorkingDir !== '/evidence'
    || JSON.stringify(policy.Config.Entrypoint) !== '["/usr/bin/env"]'
    || !h || h.Init !== true || h.UTSMode !== ''
    || JSON.stringify(h.Tmpfs) !== JSON.stringify({ '/tmp': 'rw,nosuid,nodev,noexec,size=64m,mode=1777' })
    || h.NetworkMode !== 'none' || h.Privileged !== false || h.ReadonlyRootfs !== true
    || JSON.stringify(h.CapDrop) !== '["ALL"]' || JSON.stringify(h.SecurityOpt) !== '["no-new-privileges=true"]'
    || h.PidsLimit !== 64 || h.Memory !== 536870912 || h.NanoCpus !== 1000000000
    || h.PidMode !== '' || h.IpcMode !== 'private' || !Array.isArray(h.Devices) || h.Devices.length !== 0
    || (h.Binds !== null && (!Array.isArray(h.Binds) || h.Binds.length))
    || (policy.Config.Volumes !== null && Object.keys(policy.Config.Volumes).length)
    || JSON.stringify(policy.Mounts?.map((m: Record<string, unknown>) => [m.Type, m.Source, m.Destination, m.RW]).sort())
      !== JSON.stringify([['bind', code, '/harness/guild', false], ['bind', s.exchange, '/evidence', !exporter]].sort())) throw new Error('Grading confinement policy mismatch');
}

// Shared full-ID ownership boundary for producer, grader and exporter lifecycles.
export function ownerControl(boundary: GradingBoundary) {
  const control = async (args: string[], signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const result = await boundary.control({ file: 'docker', args }, signal);
    if (result.code !== 0 || !Buffer.isBuffer(result.stdout) || !Buffer.isBuffer(result.stderr)
      || result.stdout.length + result.stderr.length > 65536) throw new Error('Owner command uncertain');
    const value = result.stdout.toString('utf8');
    if (!Buffer.from(value).equals(result.stdout)) throw new Error('Invalid owner encoding');
    signal?.throwIfAborted();
    return value.trim();
  };
  const inspect = async (identity: { id: string; name: string; image: string }, signal?: AbortSignal) => {
    const value = JSON.parse(await control(['inspect', '--type', 'container', '--format', '{{json .}}', identity.id], signal));
    if (!value || !/^[a-f0-9]{64}$/.test(value.Id) || (identity.id && value.Id !== identity.id)
      || value.Name !== '/' + identity.name || value.Image !== identity.image
      || value.Config?.Labels?.['pithos.guild.grading-owner'] !== identity.name) throw new Error('Container ownership mismatch');
    return value;
  };
  const destroy = async (identity: { id: string; name: string; image: string }, signal?: AbortSignal, policy?: (value: any) => void) => {
    const value = await inspect(identity, signal);
    policy?.(value);
    await control(['rm', '--force', value.Id], signal);
    // A failed inspect is ambiguous (daemon loss is not absence). Successful
    // owner-side enumeration must independently confirm removal of the full ID.
    if (await control(['container', 'ls', '--all', '--no-trunc', '--filter', `id=${value.Id}`, '--format', '{{.ID}}'], signal) !== '') throw new Error('Container destruction uncertain');
  };
  return { control, inspect, destroy };
}

// This adapter is deliberately not installed at the operational entry. Test
// callbacks impersonate the external Docker owner, never the producing agent.
export function inertGradingOwner(selection: GradingSelection, boundary: GradingBoundary): OwnedGradingConnection {
  if (!process.env.NODE_TEST_CONTEXT) throw new Error('Inert grading owner is test-only');
  return gradingOwner(selection, boundary, inertSnapshotExport);
}
// One private lifecycle: boundaries and exporters do not supply grades or receipts.
export function gradingOwner(selection: GradingSelection, boundary: GradingBoundary,
  exportSnapshot: (tree: Tree, approved: string, signal?: AbortSignal) => Promise<Snapshot>, producerAttempt?: ProducerAttempt): OwnedGradingConnection {
  const s = structuredClone(selection);
  if (producerAttempt && canonicalDigest(s) !== canonicalDigest(producerAttemptSelection(producerAttempt).grading)) throw new Error('Registered producer selection mismatch');
  const name = `guild-grade-${randomUUID()}`;
  let used = false, launchCommitted = false, stopped = false;
  let cleanup: Promise<'confirmed' | 'uncertain'> | undefined;
  let opening: Promise<{ binding: GradingBinding; transport: GradingProcessTransport }> | undefined;
  let original: string | undefined, graderId: string | undefined;
  let evidence: OwnedSnapshotEvidence | undefined;
  const { control, inspect, destroy } = ownerControl(boundary);
  const close = () => cleanup ??= (async () => {
    stopped = true;
    // Do not race removal ahead of an in-flight create/attach. The supervisor's
    // 500 ms limit marks an unsettled owner cleanup-pending, never successful.
    try { await opening; } catch { /* still own partially created resources */ }
    // A submitted create without its full returned ID is permanently ambiguous.
    // Never discover/remove a name collision, even with matching labels.
    if (!launchCommitted || !graderId) return 'uncertain';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 500);
    try {
      await destroy({ id: graderId, name, image: s.image }, controller.signal, value => assertGradingPolicy(value, s));
      const after = await readTree(s.exchange);
      if (treeDigest(after) !== original) return 'uncertain';
      return 'confirmed';
    } catch { return 'uncertain'; }
    finally { clearTimeout(timer); }
  })();
  return {
    close,
    async snapshotEvidence(signal) {
      signal?.throwIfAborted();
      if (!evidence || !cleanup || await cleanup !== 'confirmed') throw new Error('Owned snapshot evidence unavailable');
      if (treeDigest(await readTree(s.retained, signal)) !== evidence.materializationDigest
        || treeDigest(await readTree(s.exchange, signal)) !== evidence.materializationDigest) throw new Error('Snapshot materialization altered');
      const detached = structuredClone(evidence);
      detached.snapshot.files = Object.assign(Object.create(null), detached.snapshot.files);
      return detached;
    },
    open(binding, signal) {
      if (used || stopped) return Promise.reject(new Error('Grading owner already consumed'));
      used = true;
      opening = (async () => {
        validate(s);
        signal?.throwIfAborted();
        // No producer output, exit marker, PID or claimed acknowledgement can
        // authorize import. The independently selected resource owner removes it.
        const producer = await inspect(s.producerIdentity, signal);
        const producerPolicy = (value: any) => {
          if (producerAttempt) { assertProducerAttemptPolicy(producerAttempt, value); return; }
          // Backward-compatible authored fixtures only. Registered attempts use
          // their own fixed producer roster/root, never this grader code root.
          if (JSON.stringify(value.Mounts?.map((m: Record<string, unknown>) => [m.Type, m.Source, m.Destination, m.RW]).sort())
            !== JSON.stringify([['bind', s.code, '/harness/guild', false], ['bind', s.producer, '/evidence', true]].sort())) throw new Error('Producer exchange mapping mismatch');
        };
        producerPolicy(producer);
        await destroy(s.producerIdentity, signal, producerPolicy);
        signal?.throwIfAborted();
        const code = await readTree(s.code, signal);
        if ([...code.keys()].sort().join(',') !== sourceNames.join(',')
          || [...code].some(([path, file]) => file.kind !== 'file' || digest(file.bytes) !== s.sources[path])) throw new Error('Source roster mismatch');
        const tree = await readTree(s.producer, signal);
        if (tree.get('src/users.mjs')?.kind !== 'file') throw new Error('Candidate module missing');
        await copyTree(tree, s.retained, false, signal);
        await copyTree(tree, s.exchange, true, signal);
        original = treeDigest(await readTree(s.exchange, signal));
        if (s.snapshotGitDigest !== undefined) {
          const snapshot = await exportSnapshot(tree, s.snapshotGitDigest, signal);
          evidence = { version: 1, binding: { ...binding, artifactDigest: treeDigest(tree), observerDigest: digest(JSON.stringify(s.sources)) },
            gitDigest: s.snapshotGitDigest, materializationDigest: original, snapshotDigest: digest(JSON.stringify(snapshot)), snapshot,
            manifest: [...tree].map(([path, entry]) => ({ path, kind: entry.kind, mode: entry.mode, ...(entry.kind === 'file' ? { digest: digest(entry.bytes) } : {}) })) };
        }
        signal?.throwIfAborted();
        if (stopped) throw new Error('Grading owner stopped');
        launchCommitted = true;
        graderId = await control(gradingCommand(s, name).args, signal);
        if (!/^[a-f0-9]{64}$/.test(graderId)) { graderId = undefined; throw new Error('Invalid owned container ID'); }
        const policy = await inspect({ id: graderId, name, image: s.image }, signal);
        assertGradingPolicy(policy, s);
        const pipes = await boundary.attach({ file: 'docker', args: ['start', '--attach', '--interactive', graderId] }, signal);
        if (stopped || signal?.aborted) {
          for (const stream of [pipes.stdin, pipes.stdout, pipes.stderr]) stream.destroy();
          throw new Error('Grading launch cancelled');
        }
        return { binding: { ...binding, artifactDigest: treeDigest(tree), observerDigest: digest(JSON.stringify(s.sources)) },
          transport: { ...pipes, terminate: close } };
      })();
      return opening;
    },
  };
}

export function confinedGradingOwner(): OwnedGradingConnection {
  throw new Error('Connected authorization grading unavailable: owned confined transport and immutable artifact import are not implemented operationally');
}
