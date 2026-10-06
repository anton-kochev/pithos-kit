import { randomUUID } from 'node:crypto';

// Session data is a runtime boundary, including older extensions' persisted entries.
function object(value: unknown): Record<string, any> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined;
}
export function planInactive(entries: readonly unknown[]): boolean {
  for (const raw of [...entries].reverse()) {
    const entry = object(raw);
    if (entry?.type === 'custom' && entry.customType === 'plan-theme-state') return object(entry.data)?.active === false;
  }
  return true;
}
export function latestUser(entries: readonly unknown[]): string | undefined {
  return [...entries].reverse().map(object).find(e => e?.type === 'message' && e.message?.role === 'user')?.id;
}
export function readOnlyTask(entries: readonly unknown[]): boolean {
  return entries.some(raw => {
    const entry = object(raw);
    if (entry?.type !== 'message' || entry.message?.role !== 'user') return false;
    const content = entry.message.content;
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n') : '';
    // Fail closed across the branch: prose cannot safely establish revocation of an earlier restriction.
    return /read[ -]?only|(?:do not|never) (?:\w+\s+){0,3}(?:edit|write|change|modify)|no (?:edits|changes|writes)|only (?:inspect|review|explain)|without (?:editing|changing|writing)|ask before (?:\w+\s+){0,3}(?:edit|writ|chang|modif)/i.test(text);
  });
}
export interface Run { runId: string; paths: string[] }
export function eligibleRun(entries: readonly unknown[]): Run | undefined {
  if (!planInactive(entries) || readOnlyTask(entries)) return;
  const runId = latestUser(entries);
  if (!runId) return;
  const branch = entries.map(object);
  if (branch.some(e => e?.type === 'custom' && e.customType === 'clio-attempt' && e.data?.runId === runId)) return;
  const start = branch.findIndex(e => e?.id === runId);
  const calls = new Map<string, {name: string; path: string}>();
  const paths = new Set<string>();
  let reads = 0, changed = false;
  for (const entry of branch.slice(start + 1)) {
    const m = entry?.message;
    if (m?.role === 'assistant' && Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c?.type === 'toolCall' && ['read', 'edit', 'write'].includes(c.name) && typeof c.arguments?.path === 'string') calls.set(c.id, {name: c.name, path: c.arguments.path});
      }
    }
    if (m?.role === 'toolResult' && !m.isError) {
      const c = calls.get(m.toolCallId);
      if (c) { paths.add(c.path); if (c.name === 'read') reads++; else changed = true; }
      // Pi 1.0.3 preserves bounded nested calls (for example from codemode).
      if (Array.isArray(m.nestedCalls?.calls)) for (const nested of m.nestedCalls.calls) {
        if (nested?.status !== 'ok' || typeof nested.arguments?.path !== 'string' || !['read', 'edit', 'write'].includes(nested.name)) continue;
        paths.add(nested.arguments.path);
        if (nested.name === 'read') reads++; else changed = true;
      }
    }
  }
  if (!changed && reads < 2) return;
  return {runId, paths: [...paths].slice(0, 64)};
}
export class Lease {
  private current?: {nonce: string; session: string; run: string};
  schedule(session: string, run: string): string {
    const nonce = randomUUID();
    this.current = {nonce, session, run};
    return nonce;
  }
  invalidate(): void { this.current = undefined; }
  claim(nonce: string, session: string, run: string | undefined, batch: string[]): void {
    const c = this.current;
    if (!c || c.nonce !== nonce || c.session !== session || c.run !== run) throw new Error('Clio: stale or unsolicited capture');
    if (batch.length !== 1 || batch[0] !== 'clio_capture') throw new Error('Clio: capture requires a sole tool batch');
    this.invalidate();
  }
}
