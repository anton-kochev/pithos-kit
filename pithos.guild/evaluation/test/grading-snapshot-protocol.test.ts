import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeSnapshotRequest, decodeSnapshotRequest, decodeSnapshotResponse } from '../src/grading-snapshot-protocol.ts';
import { approvedGitDigest, type Tree } from '../src/grading-snapshot-core.ts';
const tree = (): Tree => new Map([
  ['.git', { kind: 'directory', mode: 0o755 }],
  ['.git/HEAD', { kind: 'file', mode: 0o644, bytes: Buffer.from('ref: refs/heads/eval\n') }],
  ['.git/index', { kind: 'file', mode: 0o644, bytes: Buffer.from('authored inert metadata') }],
  ['src', { kind: 'directory', mode: 0o700 }],
  ['src/users.mjs', { kind: 'file', mode: 0o751, bytes: Buffer.from('not executed') }],
]);
test('snapshot request detaches bytes, binds modes and approved Git without executing it', () => {
  const source = tree(), approved = approvedGitDigest(source);
  const bytes = encodeSnapshotRequest(source, approved);
  const entry = source.get('src/users.mjs');
  if (entry?.kind === 'file') entry.bytes.fill(0);
  const decoded = decodeSnapshotRequest(bytes);
  assert.equal(decoded.tree.get('src/users.mjs')?.mode, 0o751);
  assert.notDeepEqual(decoded.tree, source);
  assert.equal(decoded.approved, approved);
});
test('snapshot request rejects malformed frames, modes, bindings and overflow', () => {
  const source = tree(), bytes = encodeSnapshotRequest(source, approvedGitDigest(source));
  for (const mutate of [
    (v: any) => { v.treeDigest = '0'.repeat(64); },
    (v: any) => { v.approved = '0'.repeat(64); },
    (v: any) => { v.entries[4][2] = 4095; },
    (v: any) => { v.entries.push(v.entries[4]); },
    (v: any) => { v.entries[4][0] = '../escape'; },
  ]) {
    const value = JSON.parse(bytes.toString()); mutate(value);
    assert.throws(() => decodeSnapshotRequest(Buffer.from(JSON.stringify(value) + '\n')));
  }
  for (const invalid of [Buffer.concat([bytes, bytes]), Buffer.from([255]), Buffer.alloc(16 * 1024 * 1024 + 1)]) assert.throws(() => decodeSnapshotRequest(invalid));
});
test('snapshot response cannot replace original file modes or hashes', () => {
  const source = tree(), bytes = encodeSnapshotRequest(source, approvedGitDigest(source));
  const request = decodeSnapshotRequest(bytes);
  const response = { version: 1, treeDigest: request.treeDigest, approved: request.approved, snapshot: { files: { 'src/users.mjs': { kind: 'file', digest: '0'.repeat(64), mode: 0o600 } }, index: '', status: '', diff: '' } };
  assert.throws(() => decodeSnapshotResponse(Buffer.from(JSON.stringify(response) + '\n'), request));
});
test('valid snapshot response is detached; each binding, mode, hash and framing defect is rejected', async () => {
  const { createHash } = await import('node:crypto');
  const source = tree(), request = decodeSnapshotRequest(encodeSnapshotRequest(source, approvedGitDigest(source)));
  const value = { version: 1, treeDigest: request.treeDigest, approved: request.approved, snapshot: { files: { 'src/users.mjs': { kind: 'file', digest: createHash('sha256').update('not executed').digest('hex'), mode: 0o751 } }, index: 'inert', status: '', diff: '' } };
  const encode = (v: unknown) => Buffer.from(JSON.stringify(v) + '\n');
  const decoded = decodeSnapshotResponse(encode(value), request);
  assert.equal(Object.getPrototypeOf(decoded.files), null);
  assert.equal(decoded.files['src/users.mjs'].mode, 0o751);
  for (const mutate of [
    (v: any) => { v.treeDigest = '0'.repeat(64); },
    (v: any) => { v.approved = '0'.repeat(64); },
    (v: any) => { v.snapshot.files['src/users.mjs'].mode = 0o600; },
    (v: any) => { v.snapshot.files['src/users.mjs'].digest = '0'.repeat(64); },
    (v: any) => { v.snapshot.files.extra = v.snapshot.files['src/users.mjs']; },
    (v: any) => { v.snapshot.status = false; },
  ]) {
    const changed = structuredClone(value); mutate(changed);
    assert.throws(() => decodeSnapshotResponse(encode(changed), request));
  }
  for (const bytes of [Buffer.alloc(8 * 1024 * 1024 + 1), Buffer.concat([encode(value), encode(value)]), Buffer.from('{}'), Buffer.from([255, 10])]) assert.throws(() => decodeSnapshotResponse(bytes, request));
});
