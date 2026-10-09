import type { Config } from './config.ts';
import type { ToolResultMessage } from '@earendil-works/pi-ai';
import type { Snapshot } from './evidence.ts';

export type Limit = 'file-count' | 'evidence-bytes' | 'response-bytes' | 'request-context-bytes' | 'request-turns';
export class BudgetError extends Error {
  constructor(readonly limit: Limit, readonly current: number, readonly requested: number, readonly max: number) {
    super(`Clio: ${limit} budget exceeded; current=${current}; requested=${requested}; max=${max}`);
  }
}
// Use the guard's JSON/UTF-8 representation, including nested escaping.
export function requestBytes(context: unknown): number { return Buffer.byteLength(JSON.stringify(context)); }
export function assertRequestBudget(context: unknown, config: Config): void {
  const bytes = requestBytes(context);
  if (bytes > config.maxContextBytes) throw new BudgetError('request-context-bytes', 0, bytes, config.maxContextBytes);
}
export function evidenceBudget(files: Snapshot[], config: Config) {
  const evidenceBytes = Buffer.byteLength(JSON.stringify(files));
  return {files: files.length, evidenceBytes, maxFiles: config.maxFiles, maxEvidenceBytes: config.maxContextBytes,
    remainingFiles: Math.max(0, config.maxFiles - files.length), remainingEvidenceBytes: Math.max(0, config.maxContextBytes - evidenceBytes)};
}
export const continuationHeadroom = 2048;
export function toolResultEnvelope(id: string, text: string, name = 'clio_evidence'): ToolResultMessage {
  // A conservative timestamp width; Pi adds this envelope only after execution.
  return {role: 'toolResult', toolCallId: id, toolName: name, content: [{type: 'text', text}], isError: false, timestamp: Number.MAX_SAFE_INTEGER};
}
export function capacityText(error: BudgetError, files: Snapshot[], config: Config): string {
  return JSON.stringify({...capacity(error), budget: evidenceBudget(files, config)});
}
export function reservedFeedback(config: Config): string {
  const budget = Object.fromEntries(Object.keys(evidenceBudget([], config)).map(key => [key, Number.MAX_SAFE_INTEGER]));
  return JSON.stringify({...capacity(new BudgetError('request-context-bytes', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, config.maxContextBytes)), budget});
}
export function capacity(error: BudgetError) {
  return {status: 'capacity', refusal: {limit: error.limit, current: error.current, requested: error.requested, max: error.max},
    guidance: 'Finalize from registered snapshots only. Refused content is not evidence; an empty proposal is valid.'};
}
