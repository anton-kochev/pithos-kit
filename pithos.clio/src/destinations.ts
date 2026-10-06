import { lstat, opendir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import type { Config } from './config.ts';
import { assertStableEditPath, safeDirectory } from './evidence.ts';

export interface Identity { dev: number; ino: number }
export interface Destination { path: string; missing: boolean; root: string; rootIdentity: Identity; identity?: Identity }
export const sameIdentity = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
export const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
export async function canonicalRoot(root: string): Promise<Identity> {
  assertStableEditPath(root);
  if (await realpath(root) !== root) throw new Error('Clio: canonical root required');
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Clio: unsafe root');
  return {dev: stat.dev, ino: stat.ino};
}
export async function discoverDestinations(root: string, observed: string[], config: Config): Promise<Destination[]> {
  const rootIdentity = await canonicalRoot(root);
  const seeds = new Set(['docs', ...config.docsDirs]);
  for (const raw of observed) {
    let dir = dirname(isAbsolute(raw) ? relative(root, raw) : raw);
    for (let depth = 0; depth < 12 && dir !== '.' && dir !== '..'; depth++, dir = dirname(dir)) seeds.add(`${dir}/docs`);
  }
  const result: Destination[] = [];
  const visited = new Set<string>();
  async function walk(path: string, depth: number): Promise<void> {
    if (depth > 3 || visited.size >= 100 || visited.has(path)) return;
    visited.add(path);
    try {
      const absolute = await safeDirectory(root, path);
      assertStableEditPath(absolute);
      const stat = await lstat(absolute);
      result.push({path, missing: false, root, rootIdentity, identity: {dev: stat.dev, ino: stat.ino}});
      let count = 0;
      for await (const entry of await opendir(absolute)) {
        if (++count > 100) break;
        if (entry.isDirectory()) await walk(`${path}/${entry.name}`, depth + 1);
      }
    } catch (error) {
      if (path === 'docs' && isMissing(error)) result.push({path, missing: true, root, rootIdentity});
    }
  }
  for (const seed of seeds) await walk(seed, 0);
  return result;
}
