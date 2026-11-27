import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ClassifierUsage } from './classify.ts';
import type { RequestLog, ToolLog, WorkerUsage } from './worker.ts';

/**
 * What happened in one capture run, for explaining it afterwards. Holds counts, timings,
 * paths and reasons only: never file contents, session text or model output.
 */
export interface RunRecord {
  version: 1;
  startedAt: string;
  finishedAt: string;
  branch: string;
  range: string;
  status: string;
  summary: string;
  session?: { considered: number; kept: number; classified: boolean; classifierFailure?: { failed: number; total: number; error: string } };
  classifier?: { model: string } & ClassifierUsage;
  worker?: {
    model: string;
    thinking: string;
    stop?: string;
    problem?: string;
    repaired: boolean;
    repairReasons?: string[];
    finalRejection?: string[];
    nudges: string[];
    usage: WorkerUsage;
    requests: RequestLog[];
    tools: ToolLog[];
  };
  changes: { path: string; type: string; verdict: string; reason: string }[];
  committed?: string;
  inboxed: number;
}

const KEEP = 50;

/** Writes the record under `<clioDir>/runs/` and keeps the newest 50. Returns the file path. */
export async function writeRecord(clioDir: string, record: RunRecord): Promise<string> {
  const dir = join(clioDir, 'runs');
  await mkdir(dir, { recursive: true });
  const name = `${record.startedAt.replace(/[:.]/g, '-')}-${record.range.replace('..', '-')}.json`;
  const path = join(dir, name);
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
  const names = (await readdir(dir)).filter(n => n.endsWith('.json')).sort();
  for (const old of names.slice(0, Math.max(0, names.length - KEEP))) await rm(join(dir, old), { force: true });
  return path;
}
