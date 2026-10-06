import type { CreateArgs } from './create.ts';

function exact(input: unknown, args: CreateArgs): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const keys = Object.keys(args);
  return Object.keys(input).length === keys.length && keys.every(key => Object.hasOwn(input, key) && (input as Record<string, unknown>)[key] === args[key as keyof CreateArgs]);
}
/** Host-only capability; the event establishes provenance, execute consumes it synchronously. */
export class CreateAuthorization {
  private pending?: {parent: string; args: CreateArgs; guard: () => void; call?: string};
  issue(parent: string, args: CreateArgs, guard: () => void): void {
    if (this.pending) throw new Error('Clio: create already authorized');
    guard();
    this.pending = {parent, args: {...args}, guard};
  }
  observe(parent: string | undefined, call: string, input: unknown): void {
    const pending = this.pending;
    if (!pending || pending.call || pending.parent !== parent || !exact(input, pending.args)) throw new Error('Clio: unsolicited or mutated create');
    pending.guard();
    pending.call = call;
  }
  claim(call: string, input: unknown): void {
    const pending = this.pending;
    if (!pending || pending.call !== call || !exact(input, pending.args)) throw new Error('Clio: stale, replayed or mutated create');
    this.revoke();
    pending.guard();
  }
  revoke(): void { this.pending = undefined; }
}
