// Supervisor wrapper: never call the core on real candidate metadata here.
import { snapshotCore, type Tree, type Snapshot } from './grading-snapshot-core.ts';
export { approvedGitDigest } from './grading-snapshot-core.ts';
export async function inertSnapshotExport(input: Tree, approved: string, signal?: AbortSignal): Promise<Snapshot> {
  if (!process.env.NODE_TEST_CONTEXT) throw new Error('Inert snapshot exporter is test-only');
  return snapshotCore(input, approved, signal);
}
export function confinedSnapshotExport(): never {
  throw new Error('Confined snapshot export unavailable: isolated owner/image not approved');
}
