// Public disposable process only; never import supervisor/bank/comparator code.
import type { Readable, Writable } from 'node:stream';
import { observeAuthorizationCase, type AuthorizationCandidate, type PublicCase } from './grading-observer.ts';

export async function serveAuthorization(candidate: AuthorizationCandidate, input: Readable, output: Writable) {
  let buffer = Buffer.alloc(0), total = 0, count = 0;
  let identity: string | undefined;
  for await (const chunk of input) {
    if (!Buffer.isBuffer(chunk)) throw new Error('Invalid public input');
    total += chunk.length;
    if (total > 7 * 4097) throw new Error('Public input limit');
    buffer = Buffer.concat([buffer, chunk]);
    let newline: number;
    while ((newline = buffer.indexOf(10)) >= 0) {
      if (newline > 4096 || count >= 7) throw new Error('Public record limit');
      const bytes = buffer.subarray(0, newline), text = bytes.toString('utf8');
      buffer = buffer.subarray(newline + 1);
      if (!Buffer.from(text).equals(bytes)) throw new Error('Invalid public encoding');
      const r = JSON.parse(text) as PublicCase;
      if (!r || JSON.stringify(r) !== text
        || Object.keys(r).sort().join(',') !== 'actor,artifactDigest,attemptId,caseId,gradingRunId,name,observerDigest,saveBehavior,target,version'
        || r.version !== 1 || r.caseId !== count
        || ![r.attemptId, r.gradingRunId].every(v => typeof v === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(v))
        || ![r.artifactDigest, r.observerDigest].every(v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v))
        || !r.actor || Array.isArray(r.actor) || typeof r.actor.id !== 'string'
        || Object.keys(r.actor).some(k => k !== 'id' && k !== 'admin')
        || (r.actor.admin !== undefined && !['boolean', 'string', 'number'].includes(typeof r.actor.admin))
        || typeof r.target !== 'string' || typeof r.name !== 'string'
        || !['return', 'throw'].includes(r.saveBehavior)) throw new Error('Invalid public request');
      const binding = JSON.stringify([r.attemptId, r.gradingRunId, r.artifactDigest, r.observerDigest]);
      identity ??= binding;
      if (identity !== binding) throw new Error('Public binding changed');
      count++;
      const response = Buffer.from(JSON.stringify(await observeAuthorizationCase(candidate, r)) + '\n');
      if (response.length > 4097) throw new Error('Public response limit');
      await new Promise<void>((resolve, reject) => output.write(response, error => error ? reject(error) : resolve()));
    }
    if (buffer.length > 4096) throw new Error('Public record limit');
  }
  if (buffer.length) throw new Error('Incomplete public record');
}

// Fixed image path only. Importing this module in inert tests does not execute a
// candidate, probe a runtime or launch anything. One module instance per owner.
if (process.argv[1] === '/harness/guild/grading-bootstrap.ts') {
  try {
    const candidatePath = 'file:///evidence/src/users.mjs';
    const { updateUser } = await import(candidatePath);
    if (typeof updateUser !== 'function') throw new Error('Candidate export missing');
    await serveAuthorization(updateUser, process.stdin, process.stdout);
  } catch { process.exitCode = 1; }
}
