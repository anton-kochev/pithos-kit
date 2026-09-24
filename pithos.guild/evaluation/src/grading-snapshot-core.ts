// Exporter-only core. Real candidate metadata must run inside prospective confinement,
// never in the supervisor. No private harness imports belong in this roster.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
export type Tree = Map<string, { kind: 'file'; bytes: Buffer; mode: number } | { kind: 'directory'; mode: number }>;
export interface Snapshot { files: Record<string, { kind: 'file' | 'symlink'; digest: string; mode: number }>; index: string; status: string; diff: string }
const hash = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const exec = promisify(execFile);

// Explicit narrow layout: SHA-1, unborn eval branch, full approved index and
// loose objects. No linked worktrees, split/sparse index configuration, packs,
// alternates, refs/replacements, shallow repositories or executable hooks.
function metadata(tree: Tree): Tree {
  if (tree.size > 2000) throw new Error('Snapshot entry limit');
  const result: Tree = new Map();
  let bytes = 0;
  for (const [path, entry] of tree) {
    if (entry.kind === 'file') bytes += entry.bytes.length;
    if (bytes > 8 * 1024 * 1024) throw new Error('Snapshot byte limit');
    if (path !== '.git' && !path.startsWith('.git/')) continue;
    if (['.git/config', '.git/description'].includes(path) && entry.kind === 'file') continue;
    const directory = /^\.git(?:\/(?:objects(?:\/(?:[a-f0-9]{2}|info|pack))?|refs(?:\/(?:heads|tags))?|branches))?$/.test(path);
    const file = /^\.git\/(?:HEAD|index|objects\/[a-f0-9]{2}\/[a-f0-9]{38})$/.test(path);
    if (!(entry.kind === 'directory' ? directory : file)) throw new Error('Unsupported grading Git layout');
    result.set(path, entry);
  }
  const head = result.get('.git/HEAD');
  if (head?.kind !== 'file' || head.bytes.toString() !== 'ref: refs/heads/eval\n' || result.get('.git/index')?.kind !== 'file') throw new Error('Unsupported grading Git baseline');
  return result;
}
export function approvedGitDigest(tree: Tree): string {
  return hash(JSON.stringify([...metadata(tree)].map(([p, e]) => [p, e.kind, e.kind === 'file' ? hash(e.bytes) : null])));
}
export async function snapshotCore(input: Tree, approved: string, signal?: AbortSignal, deadline = Date.now() + 4500): Promise<Snapshot> {
  deadline = Math.min(deadline, Date.now() + 4500);
  const remaining = () => {
    const value = deadline - Date.now();
    if (!Number.isFinite(value) || value <= 0) throw new Error('Snapshot deadline');
    return value;
  };
  remaining();
  signal?.throwIfAborted();
  // Detach every entry and its bytes before approval validation or any await.
  // Approval, materialization and hashing must all observe this one owned view.
  if (input.size > 2000) throw new Error('Snapshot entry limit');
  const tree: Tree = new Map();
  let copiedBytes = 0;
  for (const [path, entry] of input) {
    if (entry.kind === 'file') {
      copiedBytes += entry.bytes.length;
      if (copiedBytes > 8 * 1024 * 1024) throw new Error('Snapshot byte limit');
      tree.set(path, { kind: 'file', bytes: Buffer.from(entry.bytes), mode: entry.mode });
    } else {
      tree.set(path, { kind: 'directory', mode: entry.mode });
    }
  }
  const git = metadata(tree);
  if (approvedGitDigest(tree) !== approved) throw new Error('Git materialization approval mismatch');
  if (tree.size > 2000) throw new Error('Snapshot entry limit');
  const root = await mkdtemp(join(tmpdir(), 'grading-snapshot-'));
  try {
    const files: Snapshot['files'] = Object.create(null);
    let bytes = 0, count = 0;
    for (const [path, entry] of tree) {
      signal?.throwIfAborted();
      if (!/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(path) || path.split('/').some(p => p === '.' || p === '..') || path.split('/').length > 32) throw new Error('Unsafe snapshot path');
      if (path === '.git' || path.startsWith('.git/')) { if (!git.has(path)) continue; }
      if (path.split('/').slice(1).includes('.git') || path.split('/').includes('.gitmodules')) throw new Error('Unsupported nested Git layout');
      const dest = join(root, path);
      if (entry.kind === 'directory') { await mkdir(dest, { recursive: true, mode: 0o700 }); continue; }
      bytes += entry.bytes.length;
      if (++count > 1000 || bytes > 8 * 1024 * 1024) throw new Error('Snapshot byte/file limit');
      await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
      await writeFile(dest, entry.bytes, { flag: 'wx', mode: 0o600, signal });
      if (!path.startsWith('.git/')) {
        await chmod(dest, entry.mode);
        files[path] = { kind: 'file', digest: hash(entry.bytes), mode: entry.mode };
      }
    }
    const run = async (args: string[]) => {
      signal?.throwIfAborted();
      const { stdout } = await exec('/usr/bin/git', ['--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false', '-c', 'core.filemode=true', '-c', 'core.attributesFile=/dev/null', ...args], {
        cwd: root, env: { PATH: '/usr/bin:/bin', HOME: root, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' },
        timeout: remaining(), maxBuffer: 8 * 1024 * 1024, signal, killSignal: 'SIGKILL', encoding: 'buffer',
      });
      const text = stdout.toString('utf8');
      if (!Buffer.from(text).equals(stdout)) throw new Error('Invalid snapshot encoding');
      return text;
    };
    const result = { files, index: await run(['ls-files', '--stage', '-z']), status: await run(['status', '--porcelain=v1', '-z', '--untracked-files=all']), diff: await run(['diff', '--binary', '--no-ext-diff', '--no-textconv']) };
    if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024) throw new Error('Snapshot emission limit');
    signal?.throwIfAborted();
    remaining();
    return result;
  } finally { await rm(root, { recursive: true, force: true }); }
}
