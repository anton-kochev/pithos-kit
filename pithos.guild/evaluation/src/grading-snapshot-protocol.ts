// Public exporter protocol. No supervisor/private imports or candidate execution.
import { createHash } from 'node:crypto';
import { approvedGitDigest, type Tree, type Snapshot } from './grading-snapshot-core.ts';
export const snapshotInputLimit = 16 * 1024 * 1024;
export const snapshotOutputLimit = 8 * 1024 * 1024;
const hash = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const digestTree = (tree: Tree) => hash(JSON.stringify([...tree].map(([path, e]) => e.kind === 'file' ? [path, e.kind, hash(e.bytes), e.mode] : [path, e.kind, e.mode])));
const keys = (value: unknown, expected: string) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== expected) throw new Error('Snapshot record shape');
};
function frame(bytes: Buffer, limit: number) {
  if (!Buffer.isBuffer(bytes) || bytes.length > limit || bytes.at(-1) !== 10) throw new Error('Snapshot frame limit');
  const text = bytes.subarray(0, -1).toString('utf8');
  if (!Buffer.from(text + '\n').equals(bytes)) throw new Error('Snapshot UTF8');
  const value = JSON.parse(text);
  if (JSON.stringify(value) !== text) throw new Error('Snapshot canonical frame');
  return value;
}
export interface SnapshotRequest { tree: Tree; treeDigest: string; approved: string }
export function decodeSnapshotRequest(bytes: Buffer): SnapshotRequest {
  const value = frame(bytes, snapshotInputLimit);
  keys(value, 'approved,entries,treeDigest,version');
  if (value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.approved) || !/^[a-f0-9]{64}$/.test(value.treeDigest)
    || !Array.isArray(value.entries) || value.entries.length > 2000) throw new Error('Snapshot request');
  const tree: Tree = new Map();
  let total = 0, files = 0;
  for (const entry of value.entries) {
    if (!Array.isArray(entry)) throw new Error('Snapshot entry');
    const [path, kind, mode, data] = entry;
    if (typeof path !== 'string' || !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(path)
      || path.split('/').some(p => p === '.' || p === '..') || path.split('/').length > 32 || tree.has(path)
      || !Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new Error('Snapshot path/mode');
    const parent = path.split('/').slice(0, -1).join('/');
    if (parent && tree.get(parent)?.kind !== 'directory') throw new Error('Snapshot parent');
    if (kind === 'directory' && entry.length === 3) tree.set(path, { kind, mode });
    else if (kind === 'file' && entry.length === 4 && typeof data === 'string') {
      const contents = Buffer.from(data, 'base64');
      total += contents.length;
      if (contents.toString('base64') !== data || total > snapshotOutputLimit || ++files > 1000) throw new Error('Snapshot contents');
      tree.set(path, { kind, mode, bytes: contents });
    } else throw new Error('Snapshot entry kind');
  }
  if (digestTree(tree) !== value.treeDigest || approvedGitDigest(tree) !== value.approved) throw new Error('Snapshot binding mismatch');
  return { tree, treeDigest: value.treeDigest, approved: value.approved };
}
export function encodeSnapshotRequest(tree: Tree, approved: string): Buffer {
  // Serialization owns bytes synchronously, before the caller can mutate input.
  const entries = [...tree].map(([path, e]) => e.kind === 'file' ? [path, e.kind, e.mode, e.bytes.toString('base64')] : [path, e.kind, e.mode]);
  const bytes = Buffer.from(JSON.stringify({ version: 1, treeDigest: digestTree(tree), approved, entries }) + '\n');
  decodeSnapshotRequest(bytes);
  return bytes;
}
export function decodeSnapshotResponse(bytes: Buffer, request: SnapshotRequest): Snapshot {
  const value = frame(bytes, snapshotOutputLimit);
  keys(value, 'approved,snapshot,treeDigest,version');
  if (value.version !== 1 || value.treeDigest !== request.treeDigest || value.approved !== request.approved) throw new Error('Snapshot response binding');
  const s = value.snapshot;
  keys(s, 'diff,files,index,status');
  if (![s.index, s.status, s.diff].every(v => typeof v === 'string') || !s.files || typeof s.files !== 'object' || Array.isArray(s.files)) throw new Error('Snapshot response shape');
  const files: Snapshot['files'] = Object.create(null);
  for (const [path, e] of request.tree) {
    if (e.kind !== 'file' || path.startsWith('.git/')) continue;
    const f = s.files[path];
    keys(f, 'digest,kind,mode');
    if (f.kind !== 'file' || f.mode !== e.mode || f.digest !== hash(e.bytes)) throw new Error('Snapshot file binding');
    files[path] = { kind: 'file', mode: e.mode, digest: hash(e.bytes) };
  }
  if (Object.keys(s.files).sort().join('\0') !== Object.keys(files).sort().join('\0')) throw new Error('Snapshot file roster');
  return { files, index: s.index, status: s.status, diff: s.diff };
}
export function encodeSnapshotResponse(snapshot: Snapshot, request: SnapshotRequest): Buffer {
  const bytes = Buffer.from(JSON.stringify({ version: 1, treeDigest: request.treeDigest, approved: request.approved, snapshot }) + '\n');
  decodeSnapshotResponse(bytes, request);
  return bytes;
}
