import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { withFileMutationQueue } from '@earendil-works/pi-coding-agent';
import type { Config } from './config.ts';
import { assertCreatePath, assertSafeContent, safeDirectory, safeFile, type Proposal } from './evidence.ts';
import { canonicalRoot, isMissing, sameIdentity, type Destination, type Identity } from './destinations.ts';

export interface CreateArgs { path: string; content: string; capability: string; createDirectory?: string }
export interface CreateLedger { state: 'not-published' | 'published' | 'uncertain'; createdDirectories: string[]; leftoverTemps: string[] }
// Host-only completion is separate from publication accounting and tool results.
type CreateCompletion = {state: 'pending' | 'succeeded'} | {state: 'failed'; error: unknown};
export interface CreateOperation { args: CreateArgs; ledger: CreateLedger; completion: CreateCompletion; check: () => Promise<void>; destination: Destination; config: Config; relative: string }
async function absent(path: string): Promise<void> {
  try { await lstat(path); } catch (error) { if (isMissing(error)) return; throw error; }
  throw new Error('Clio: destination already exists');
}
export async function prepareCreate(root: string, create: NonNullable<Proposal['creates']>[number], destinations: Destination[], config: Config, guard: () => Promise<void>): Promise<CreateOperation> {
  const destination = assertCreatePath(create.path, destinations, config);
  if (destination.root !== root) throw new Error('Clio: destination root mismatch');
  assertSafeContent(create.content, config);
  const args: CreateArgs = {path: join(root, create.path), content: create.content, capability: randomUUID(), ...(destination.missing ? {createDirectory: join(root, 'docs')} : {})};
  const check = async () => {
    await guard();
    if (!sameIdentity(await canonicalRoot(root), destination.rootIdentity)) throw new Error('Clio: root identity changed');
    if (destination.missing) await absent(join(root, destination.path));
    else {
      const directory = await safeDirectory(root, destination.path);
      if (!destination.identity || !sameIdentity(await lstat(directory), destination.identity)) throw new Error('Clio: parent identity changed');
    }
    await absent(args.path);
    await guard();
  };
  await check();
  return {args, check, destination, config, relative: create.path, completion: {state: 'pending'}, ledger: {state: 'not-published', createdDirectories: [], leftoverTemps: []}};
}
export async function publishCreate(operation: CreateOperation, signal?: AbortSignal, io: Pick<typeof import('node:fs/promises'), 'link' | 'unlink'> = {link, unlink}): Promise<void> {
  const {args, destination, ledger} = operation;
  await withFileMutationQueue(args.path, async () => {
    signal?.throwIfAborted();
    await operation.check();
    signal?.throwIfAborted();
    if (destination.missing) {
      await mkdir(args.createDirectory!, {mode: 0o755}); // Deliberately not recursive.
      ledger.createdDirectories.push(args.createDirectory!);
      const stat = await lstat(args.createDirectory!);
      destination.identity = {dev: stat.dev, ino: stat.ino};
      destination.missing = false;
    }
    await operation.check();
    const temporary = join(dirname(args.path), `.clio-${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let owned: Identity | undefined;
    const failures: unknown[] = [];
    try {
      handle = await open(temporary, 'wx+', 0o600);
      ledger.leftoverTemps.push(temporary);
      owned = await handle.stat();
      await handle.writeFile(args.content, 'utf8');
      await handle.sync();
      await operation.check();
      const expected = Buffer.from(args.content, 'utf8');
      const checkTemporary = async () => {
        const current = await lstat(temporary);
        if (!current.isFile() || current.nlink !== 1 || !owned || !sameIdentity(current, owned)) throw new Error('Clio: temporary identity changed; not published');
        if (current.size !== expected.length) throw new Error('Clio: temporary contents changed; not published');
      };
      await checkTemporary();
      // Read the still-owned inode, never a reopened (possibly substituted) path.
      const buffer = Buffer.alloc(expected.length + 1);
      let length = 0;
      while (length < buffer.length) {
        const {bytesRead} = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (!buffer.subarray(0, length).equals(expected)) throw new Error('Clio: temporary contents changed; not published');
      await checkTemporary();
      signal?.throwIfAborted();
      try {
        await io.link(temporary, args.path); // Atomic no-replace. Never rename or ordinary write.
        ledger.state = 'published';
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') ledger.state = 'uncertain';
        throw error;
      }
    } catch (error) { failures.push(error); }
    finally {
      try {
        if (owned) {
          const parent = await safeDirectory(destination.root, destination.path);
          if (!sameIdentity(await canonicalRoot(destination.root), destination.rootIdentity) || !destination.identity || !sameIdentity(await lstat(parent), destination.identity)) throw new Error('Clio: temporary parent changed; not removed');
          const current = await lstat(temporary).catch(error => { if (isMissing(error)) return undefined; throw error; });
          if (current) {
            if (!sameIdentity(current, owned) || current.isSymbolicLink()) throw new Error('Clio: temporary identity changed; not removed');
            await io.unlink(temporary);
          }
          ledger.leftoverTemps.splice(ledger.leftoverTemps.indexOf(temporary), 1);
        }
      } catch (error) { failures.push(error); }
      finally {
        // Keep the inode alive until cleanup finishes; dev/ino alone can be reused.
        try { await handle?.close(); } catch (error) { failures.push(error); }
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, failures.map(String).join('; '));
    const after = await safeFile(destination.root, operation.relative, operation.config, true);
    if (!owned || !sameIdentity(after, owned) || after.text !== args.content) throw new Error('Clio: unexpected published contents');
    const directory = await open(dirname(args.path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }).then(() => {
    operation.completion = {state: 'succeeded'};
  }, error => {
    operation.completion = {state: 'failed', error};
    throw error;
  });
}
