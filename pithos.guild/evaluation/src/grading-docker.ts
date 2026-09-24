// Supervisor-private, bounded subprocess preparation. No operational issuer.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { gradingCommand, snapshotCommand, type GradingSelection, type GradingCommand, type GradingBoundary } from './grading-owner.ts';
import { Transform } from 'node:stream';
import { producerCommand, producerAttemptSelection, type ProducerAttempt } from './producer-launcher.ts';
export interface DockerSelection {
  executable: string;
  endpoint: string;
  config: string;
  grading?: GradingSelection;
  exporterCode?: string;
  producerAttempt?: ProducerAttempt; // Original registry handle, never serialized mount overrides.
}
export type DockerSpawn = (file: string, args: string[], options: { shell: false; env: Record<string, string>; stdio: ['pipe', 'pipe', 'pipe'] }) => ChildProcessWithoutNullStreams;
const absolute = /^\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/;
const id = /^[a-f0-9]{64}$/;
function vocabulary(command: GradingCommand, attach: boolean, selection: DockerSelection) {
  const a = command.args;
  if (command.file !== 'docker') throw new Error('Docker command vocabulary');
  const fullId = (value: string) => typeof value === 'string' && id.test(value);
  if (attach && a.length === 4 && a.slice(0, 3).join(' ') === 'start --attach --interactive' && fullId(a[3])) return;
  if (!attach && ((a.length === 3 && a[0] === 'rm' && a[1] === '--force' && fullId(a[2]))
    || (a.length === 6 && a.slice(0, 5).join(' ') === 'inspect --type container --format {{json .}}' && fullId(a[5]))
    || (a.length === 8 && a.slice(0, 5).join(' ') === 'container ls --all --no-trunc --filter' && /^id=[a-f0-9]{64}$/.test(a[5]) && a[6] === '--format' && a[7] === '{{.ID}}'))) return;
  if (!attach && selection.producerAttempt && JSON.stringify(a) === JSON.stringify(producerCommand(selection.producerAttempt).args)) return;
  if (!attach && a[0] === 'create' && a[1] === '--name' && selection.grading) {
    const plans = [gradingCommand(selection.grading, a[2])];
    if (selection.exporterCode) plans.push(snapshotCommand(selection.grading, selection.exporterCode, a[2]));
    if (plans.some(plan => JSON.stringify(plan.args) === JSON.stringify(a))) return;
  }
  throw new Error('Docker command vocabulary unavailable');
}
function dockerBoundary(selection: DockerSelection, launch: DockerSpawn): GradingBoundary {
  const { producerAttempt, ...data } = selection;
  const s = { ...structuredClone(data), producerAttempt };
  if (producerAttempt) {
    const expected = producerAttemptSelection(producerAttempt).docker;
    if (s.executable !== expected.executable || s.endpoint !== expected.endpoint || s.config !== expected.config) throw new Error('Registered producer daemon mismatch');
  }
  if (!absolute.test(s.executable) || !absolute.test(s.config) || !s.endpoint.startsWith('unix://') || !absolute.test(s.endpoint.slice(7))
    || [s.executable, s.config, s.endpoint.slice(7)].some(p => p.split('/').some(v => v === '.' || v === '..'))) throw new Error('Unselected Docker boundary');
  const start = (command: GradingCommand, attach: boolean) => {
    vocabulary(command, attach, s);
    return launch(s.executable, ['--host', s.endpoint, '--config', s.config, ...command.args], { shell: false, env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
  };
  return {
    async control(command, signal) {
      signal?.throwIfAborted();
      const child = start(command, false);
      return new Promise((resolve, reject) => {
        const stdout: Buffer[] = [], stderr: Buffer[] = [];
        let size = 0, failure: Error | undefined, settled = false;
        let reap: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => {
          clearTimeout(timer); clearTimeout(reap);
          signal?.removeEventListener('abort', abort);
          child.stdout.off('data', out); child.stderr.off('data', err);
          child.off('close', close); child.off('error', error);
          child.stdin.off('error', error); child.stdout.off('error', error); child.stderr.off('error', error);
          // A timed-out, unreaped OS client may report errors after settlement.
          for (const emitter of [child, child.stdin, child.stdout, child.stderr]) emitter.on('error', () => {});
        };
        const finish = (code: number | null, killed: NodeJS.Signals | null) => {
          if (settled) return;
          settled = true; cleanup();
          if (failure || code === null || killed) {
            child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
            reject(failure ?? new Error('Abnormal Docker client exit')); return;
          }
          const out = Buffer.concat(stdout), err = Buffer.concat(stderr);
          if (![out, err].every(b => Buffer.from(b.toString('utf8')).equals(b))) { reject(new Error('Invalid Docker UTF8')); return; }
          resolve({ code, stdout: out, stderr: err });
        };
        const stop = (reason: Error) => {
          if (failure || settled) return;
          failure = reason;
          try { child.kill('SIGKILL'); } catch { /* uncertainty is retained */ }
          // Never turn an unreaped client into successful cleanup. Keep the
          // owner-facing call bounded even if the OS cannot deliver close.
          reap = setTimeout(() => { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); finish(null, null); }, 100);
        };
        const collect = (target: Buffer[], chunk: Buffer) => {
          if (failure) return;
          size += chunk.length;
          if (size > 65536) { stop(new Error('Docker output limit')); return; }
          target.push(Buffer.from(chunk));
        };
        const out = (b: Buffer) => collect(stdout, b), err = (b: Buffer) => collect(stderr, b);
        const error = (e: Error) => stop(e), abort = () => { stop(new Error('Docker client aborted')); finish(null, null); };
        const close = (code: number | null, killed: NodeJS.Signals | null) => finish(code, killed);
        const timer = setTimeout(() => stop(new Error('Docker client deadline')), 400);
        child.stdout.on('data', out); child.stderr.on('data', err);
        child.on('error', error); child.once('close', close);
        child.stdin.on('error', error); child.stdout.on('error', error); child.stderr.on('error', error);
        signal?.addEventListener('abort', abort, { once: true });
        child.stdin.end();
        if (signal?.aborted) abort();
      });
    },
    async attach(command, signal) {
      signal?.throwIfAborted();
      const child = start(command, true);
      let output = 0, input = 0, stopped = false, exited = false;
      let resolveExit!: () => void, rejectExit!: (error: Error) => void;
      const clientClosed = new Promise<void>((resolve, reject) => { resolveExit = resolve; rejectExit = reject; });
      void clientClosed.catch(() => {});
      let reap: ReturnType<typeof setTimeout> | undefined;
      const bounded = (writing: boolean) => new Transform({ transform(chunk, _encoding, callback) {
        if (writing) input += chunk.length; else output += chunk.length;
        if (input > 16 * 1024 * 1024 || output > 8 * 1024 * 1024) callback(new Error('Docker attach byte limit'));
        else callback(null, chunk);
      } });
      const stdin = bounded(true), stdout = bounded(false), stderr = bounded(false);
      const streams = [stdin, stdout, stderr, child.stdin, child.stdout, child.stderr];
      const dispose = () => { for (const stream of streams) stream.destroy(); };
      const cleanup = () => {
        clearTimeout(timer); clearTimeout(reap);
        signal?.removeEventListener('abort', stop);
        child.off('error', stop); child.off('close', close);
        child.on('error', () => {});
      };
      const stop = () => {
        if (stopped) return;
        stopped = true;
        rejectExit(new Error('Docker attach failed or unreaped'));
        dispose();
        try { child.kill('SIGKILL'); } catch { /* no destruction attestation */ }
        reap = setTimeout(cleanup, 100);
      };
      const close = (code: number | null, killed: NodeJS.Signals | null) => {
        if (code !== 0 || killed) stop();
        else if (!stopped) { exited = true; resolveExit(); }
        if (stopped || (child.stdout.readableEnded && child.stderr.readableEnded)) cleanup();
      };
      const timer = setTimeout(stop, 4500);
      // Error handlers remain on disposed streams to absorb late OS errors.
      for (const stream of streams) stream.on('error', stop);
      child.on('error', stop); child.once('close', close);
      signal?.addEventListener('abort', stop, { once: true });
      const ended = () => { if (exited && child.stdout.readableEnded && child.stderr.readableEnded) cleanup(); };
      child.stdout.once('end', ended); child.stderr.once('end', ended);
      stdin.pipe(child.stdin); child.stdout.pipe(stdout); child.stderr.pipe(stderr);
      if (signal?.aborted) stop();
      return { stdin, stdout, stderr, clientClosed };
    },
  };
}
export function inertDockerBoundary(selection: DockerSelection, launch: DockerSpawn): GradingBoundary {
  if (!process.env.NODE_TEST_CONTEXT) throw new Error('Inert Docker seam is test-only');
  return dockerBoundary(selection, launch);
}
// Real spawn is selected only after a future private operational registration;
// this stop is unconditional, including under NODE_TEST_CONTEXT.
export function confinedDockerBoundary(selection: DockerSelection): GradingBoundary {
  throw new Error('Docker boundary unavailable: trusted producer launcher and reviewed selection required');
  return dockerBoundary(selection, spawn as DockerSpawn);
}
