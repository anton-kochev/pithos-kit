// Supervisor-private concrete consumer. No operational registry is installed.
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { gradingOwner, ownerControl, assertGradingPolicy, snapshotCommand, readTree,
  type GradingSelection, type OwnedGradingConnection, type GradingBoundary, type Tree } from './grading-owner.ts';
import { inertDockerBoundary, confinedDockerBoundary, type DockerSelection, type DockerSpawn } from './grading-docker.ts';
import { encodeSnapshotRequest, decodeSnapshotRequest, decodeSnapshotResponse, snapshotOutputLimit } from './grading-snapshot-protocol.ts';
import type { Snapshot } from './grading-snapshot-core.ts';
import { producerAttemptSelection, type ProducerAttempt } from './producer-launcher.ts';
import { digest } from './manifest.ts';
export interface DockerGradingSelection {
  docker: DockerSelection;
  grading: GradingSelection;
  exporter: { code: string; sources: Record<string, string> };
}
const roster = ['grading-snapshot-bootstrap.ts', 'grading-snapshot-core.ts', 'grading-snapshot-protocol.ts'];
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
async function exportSnapshot(s: DockerGradingSelection, boundary: GradingBoundary, tree: Tree, approved: string, signal?: AbortSignal): Promise<Snapshot> {
  // Own the original modes and bytes before any await; do not reread reduced-mode copies.
  const bytes = encodeSnapshotRequest(tree, approved), request = decodeSnapshotRequest(bytes);
  const name = `guild-grade-${randomUUID()}`;
  const command = snapshotCommand(s.grading, s.exporter.code, name);
  const { control, inspect, destroy } = ownerControl(boundary);
  const code = await readTree(s.exporter.code, signal);
  if (Object.keys(s.exporter.sources).sort().join(',') !== roster.join(',') || [...code.keys()].sort().join(',') !== roster.join(',')
    || [...code].some(([path, e]) => e.kind !== 'file' || hash(e.bytes) !== s.exporter.sources[path])) throw new Error('Exporter source roster mismatch');
  let id: string | undefined;
  let pipes: Awaited<ReturnType<GradingBoundary['attach']>> | undefined;
  let response: Buffer | undefined;
  let failure: unknown;
  try {
    const result = await control(command.args, signal);
    if (!/^[a-f0-9]{64}$/.test(result)) throw new Error('Exporter create uncertain');
    id = result;
    const identity = { id, name, image: s.grading.image };
    assertGradingPolicy(await inspect(identity, signal), s.grading, s.exporter.code, true);
    pipes = await boundary.attach({ file: 'docker', args: ['start', '--attach', '--interactive', id] }, signal);
    if (!pipes.clientClosed) throw new Error('Missing exporter client completion');
    let size = 0;
    const collect = async (stream: import('node:stream').Readable, retain: boolean) => {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        signal?.throwIfAborted();
        if (!Buffer.isBuffer(chunk) || (size += chunk.length) > snapshotOutputLimit) throw new Error('Exporter output limit');
        if (retain) chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    };
    const write = async () => {
      for (let offset = 0; offset < bytes.length; offset += 65536) {
        signal?.throwIfAborted();
        if (!pipes!.stdin.write(bytes.subarray(offset, offset + 65536))) await once(pipes!.stdin, 'drain', { signal });
      }
      pipes!.stdin.end();
    };
    const results = await Promise.all([collect(pipes.stdout, true), collect(pipes.stderr, false), write(), pipes.clientClosed]);
    response = results[0];
  } catch (error) { failure = error; }
  finally {
    for (const stream of pipes ? [pipes.stdin, pipes.stdout, pipes.stderr] : []) stream.destroy();
    // Submitted create without a full ID is an unresolved obligation, not absence.
    if (!id) throw new Error('Exporter ownership uncertain');
    const cleanup = new AbortController(), timer = setTimeout(() => cleanup.abort(), 500);
    try {
      await destroy({ id, name, image: s.grading.image }, cleanup.signal,
        policy => assertGradingPolicy(policy, s.grading, s.exporter.code, true));
    } catch { throw new Error('Exporter destruction uncertain'); }
    finally { clearTimeout(timer); }
  }
  // No response leaves this consumer before independently confirmed destruction.
  if (failure) throw failure;
  signal?.throwIfAborted();
  if (!response) throw new Error('Exporter response unavailable');
  return decodeSnapshotResponse(response, request);
}
function dockerGradingOwner(s: DockerGradingSelection, boundary: GradingBoundary, producerAttempt?: ProducerAttempt): OwnedGradingConnection {
  const owner = gradingOwner(s.grading, boundary, (tree, approved, signal) => exportSnapshot(s, boundary, tree, approved, signal), producerAttempt);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unlink = () => {};
  controller.signal.addEventListener('abort', () => { clearTimeout(timer); unlink(); }, { once: true });
  return {
    snapshotEvidence: signal => owner.snapshotEvidence!(signal),
    open(binding, signal) {
      if (!timer) timer = setTimeout(() => controller.abort(), 4500);
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      unlink = () => signal?.removeEventListener('abort', abort);
      if (signal?.aborted) abort();
      return owner.open(binding, controller.signal);
    },
    close() { clearTimeout(timer); unlink(); controller.abort(); return owner.close(); },
  };
}
export function inertDockerGradingOwner(selection: DockerGradingSelection, spawn: DockerSpawn, producerAttempt?: ProducerAttempt): OwnedGradingConnection {
  if (!process.env.NODE_TEST_CONTEXT) throw new Error('Inert Docker composition is test-only');
  const s = structuredClone(selection);
  if (producerAttempt && digest(s) !== digest(producerAttemptSelection(producerAttempt))) throw new Error('Registered daemon/deployment mismatch');
  return dockerGradingOwner(s, inertDockerBoundary({ ...s.docker, grading: s.grading, exporterCode: s.exporter.code }, spawn), producerAttempt);
}
export function confinedDockerGradingOwner(selection: DockerGradingSelection): OwnedGradingConnection {
  throw new Error('CLOSED: reviewed operational selection and trusted producer registry required');
  const s = structuredClone(selection);
  return dockerGradingOwner(s, confinedDockerBoundary({ ...s.docker, grading: s.grading, exporterCode: s.exporter.code }));
}
