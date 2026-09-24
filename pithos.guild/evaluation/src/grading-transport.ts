// Supervisor-private fixed transport. This owns pipes, NOT a launcher or proof
// of confinement. Only a trusted external owner may supply terminate; candidate
// output/exit is never a termination acknowledgment. Operational entry is closed.
import type { Readable, Writable } from 'node:stream';
import type { GradingSession } from './grading-boundary.ts';
import type { PublicCase } from './grading-observer.ts';

export interface GradingProcessTransport {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  clientClosed?: Promise<void>; // Client exit only, never container destruction.
  terminate(): Promise<'confirmed' | 'uncertain'>;
}

export function gradingTransportSession(transport: GradingProcessTransport): GradingSession {
  let pending: { resolve(frame: string): void; reject(error: Error): void } | undefined;
  let frame = Buffer.alloc(0), total = 0, count = 0;
  let failure: Error | undefined, closing = false;
  let closed: Promise<'confirmed' | 'uncertain'> | undefined;
  const fail = () => {
    failure ??= new Error('Invalid grading transport'); // Never retain candidate diagnostics.
    pending?.reject(failure);
    pending = undefined;
  };
  const account = (chunk: unknown): chunk is Buffer => {
    if (!Buffer.isBuffer(chunk)) { fail(); return false; }
    total += chunk.length;
    if (total > 65536) { fail(); return false; }
    return !failure;
  };
  const stdout = (chunk: Buffer) => {
    if (!account(chunk)) return;
    if (!pending) { fail(); return; }
    const newline = chunk.indexOf(10);
    if (frame.length + (newline < 0 ? chunk.length : newline) > 4096) { fail(); return; }
    if (newline < 0) { frame = Buffer.concat([frame, chunk]); return; }
    // A response is exactly one LF-terminated record, never a queued batch.
    if (newline !== chunk.length - 1) { fail(); return; }
    const bytes = Buffer.concat([frame, chunk.subarray(0, newline)]);
    frame = Buffer.alloc(0);
    const value = bytes.toString('utf8');
    if (!Buffer.from(value, 'utf8').equals(bytes)) { fail(); return; }
    const active = pending;
    pending = undefined;
    active.resolve(value);
  };
  const stderr = (chunk: Buffer) => { account(chunk); };
  const ended = () => { if (!closing) fail(); };
  transport.stdout.on('data', stdout);
  transport.stderr.on('data', stderr);
  for (const stream of [transport.stdin, transport.stdout, transport.stderr]) stream.on('error', fail);
  transport.stdout.on('end', ended);
  transport.stdout.on('close', ended);
  return {
    async exchange(request: PublicCase, signal: AbortSignal) {
      signal.throwIfAborted();
      if (failure || closing || pending || count >= 7 || request.caseId !== count) throw new Error('Grading transport unavailable');
      const bytes = Buffer.from(JSON.stringify(request) + '\n');
      if (bytes.length > 4097) throw new Error('Grading request limit');
      count++;
      const abort = () => {
        pending?.reject(new Error('Grading transport cancelled'));
        pending = undefined;
      };
      signal.addEventListener('abort', abort, { once: true });
      try {
        return await new Promise<string>((resolve, reject) => {
          pending = { resolve, reject };
          transport.stdin.write(bytes, error => { if (error) fail(); });
        });
      } finally { signal.removeEventListener('abort', abort); }
    },
    close() {
      if (closed) return closed;
      closing = true;
      pending?.reject(new Error('Grading transport closed'));
      pending = undefined;
      // Start independently owned termination even if pipe disposal fails. A
      // never-settling owner is bounded by the supervisor's existing 500 ms.
      closed = (async () => {
        try {
          const result = await transport.terminate();
          // Late unsolicited output must not promote a completed observation.
          return failure ? 'uncertain' : result;
        } finally {
          for (const stream of [transport.stdin, transport.stdout, transport.stderr]) stream.destroy();
          frame = Buffer.alloc(0);
        }
      })();
      for (const stream of [transport.stdin, transport.stdout, transport.stderr]) stream.destroy();
      return closed;
    },
  };
}
