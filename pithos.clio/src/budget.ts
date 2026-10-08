import type { Config } from './config.ts';
import type { Snapshot } from './evidence.ts';

export type Limit = 'file-count' | 'evidence-bytes' | 'response-bytes' | 'request-context-bytes' | 'request-turns';
export class BudgetError extends Error {
  constructor(readonly limit: Limit, readonly current: number, readonly requested: number, readonly max: number) {
    super(`Clio: ${limit} budget exceeded; current=${current}; requested=${requested}; max=${max}`);
  }
}
export function evidenceBudget(files: Snapshot[], config: Config) {
  const evidenceBytes = Buffer.byteLength(JSON.stringify(files));
  return {files: files.length, evidenceBytes, maxFiles: config.maxFiles, maxEvidenceBytes: config.maxContextBytes,
    remainingFiles: Math.max(0, config.maxFiles - files.length), remainingEvidenceBytes: Math.max(0, config.maxContextBytes - evidenceBytes)};
}
export function capacity(error: BudgetError) {
  return {status: 'capacity', refusal: {limit: error.limit, current: error.current, requested: error.requested, max: error.max},
    guidance: 'Finalize from registered snapshots only. Refused content is not evidence; an empty proposal is valid.'};
}
