// Exclusive supervisor storage, not a mount/UID isolation proof. All issuers are
// test-only while real topology/namespace provisioning remains unavailable.
import { lstat, mkdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { deploymentData, deploymentCheck as check, deploymentPath, overlaps, type ProducerDeployment } from './producer-deployment.ts';
declare const storageBrand: unique symbol;
export type FinalizationStorage = { readonly [storageBrand]: true };
interface DirectoryIdentity { path: string; dev: number; ino: number; uid: number; gid: number; mode: number }
export interface FinalizationStorageEvidence { root: string; directory: string; mounts: string[]; ancestry: DirectoryIdentity[] }
const storage = new WeakMap<FinalizationStorage, { deployment: ProducerDeployment; attempt: object; evidence: FinalizationStorageEvidence; used: boolean }>();
async function ancestry(path: string) {
  deploymentPath(path);
  const result: DirectoryIdentity[] = [];
  let current = '/';
  for (const part of path.split('/').filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current);
    check(info.isDirectory() && !info.isSymbolicLink());
    result.push({ path: current, dev: info.dev, ino: info.ino, uid: info.uid, gid: info.gid, mode: info.mode & 0o7777 });
  }
  return result;
}
export async function reserveFinalizationStorage(deployment: ProducerDeployment, directory: string, attempt: object): Promise<FinalizationStorage> {
  const d = deploymentData(deployment);
  deploymentPath(directory);
  check(attempt && typeof attempt === 'object' && dirname(directory) === d.retention.trialParent && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(basename(directory)));
  const root = join(d.retention.trialParent, '.finalization', basename(directory));
  const mounted = [d.producer.root, d.grader.root, d.exporter.root, d.exchange, join(directory, 'repo'), ...d.mountAliases];
  check(mounted.every(path => !overlaps(path, root) && !overlaps(path, dirname(root))));
  const before = await ancestry(directory);
  const mountAncestry = await Promise.all(mounted.map(ancestry));
  const privateOwner = (entry: DirectoryIdentity) => check(entry.uid === d.retention.uid && entry.gid === d.retention.gid && entry.mode === d.retention.mode);
  before.filter(e => e.path === directory || e.path === d.retention.trialParent).forEach(privateOwner);
  try { await mkdir(dirname(root), { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const parent = await ancestry(dirname(root)); privateOwner(parent.at(-1)!);
  await mkdir(root, { mode: 0o700 }); // Exclusive; never resume/adopt/erase an old reservation.
  const held = await ancestry(root); privateOwner(held.at(-1)!);
  check(mountAncestry.every(entries => !held.some(e => e.dev === entries.at(-1)!.dev && e.ino === entries.at(-1)!.ino)));
  const unique = new Map([...before, ...held, ...mountAncestry.flat()].map(e => [e.path, e]));
  const evidence = { root, directory, mounts: mounted, ancestry: [...unique.values()] };
  await recheckFinalizationStorage(evidence);
  const handle = Object.freeze({}) as FinalizationStorage;
  storage.set(handle, { deployment, attempt, evidence, used: false }); return handle;
}
export function consumeFinalizationStorage(handle: FinalizationStorage, deployment: ProducerDeployment, directory: string, attempt: object) {
  const held = storage.get(handle); check(held && !held.used); held.used = true;
  check(held.deployment === deployment && held.attempt === attempt && held.evidence.directory === directory);
  return structuredClone(held.evidence);
}
export async function recheckFinalizationStorage(evidence: FinalizationStorageEvidence) {
  check(evidence.root === join(dirname(evidence.directory), '.finalization', basename(evidence.directory)));
  check(Array.isArray(evidence.mounts) && evidence.mounts.length <= 69 && evidence.mounts.every(p => !overlaps(p, dirname(evidence.root))));
  const observed = [...await ancestry(evidence.directory), ...await ancestry(evidence.root), ...(await Promise.all(evidence.mounts.map(ancestry))).flat()];
  check(evidence.ancestry.length > 0 && evidence.ancestry.length <= 128);
  for (const entry of observed) {
    const original = evidence.ancestry.find(e => e.path === entry.path);
    check(original && JSON.stringify(original) === JSON.stringify(entry));
  }
}
