// Exporter image entry only; never run candidate metadata on the supervisor.
import { snapshotCore } from './grading-snapshot-core.ts';
import { decodeSnapshotRequest, encodeSnapshotResponse, snapshotInputLimit } from './grading-snapshot-protocol.ts';

async function main() {
  const controller = new AbortController();
  const deadline = Date.now() + 4500;
  const timer = setTimeout(() => { controller.abort(); process.stdin.destroy(); process.stdout.destroy(); }, 4500);
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      controller.signal.throwIfAborted();
      if (!Buffer.isBuffer(chunk) || (size += chunk.length) > snapshotInputLimit) throw new Error('Snapshot input limit');
      chunks.push(chunk);
    }
    const request = decodeSnapshotRequest(Buffer.concat(chunks));
    const snapshot = await snapshotCore(request.tree, request.approved, controller.signal, deadline);
    const response = encodeSnapshotResponse(snapshot, request);
    controller.signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      process.stdout.once('error', reject);
      process.stdout.end(response, resolve);
    });
  } finally { clearTimeout(timer); }
}
// No host execution even if this module is accidentally imported by the harness.
if (process.argv[1] === '/harness/guild/grading-snapshot-bootstrap.ts') {
  main().catch(() => { process.exitCode = 1; process.stdin.destroy(); process.stdout.destroy(); });
}
