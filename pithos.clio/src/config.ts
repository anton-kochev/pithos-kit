import type { ThinkingLevel } from '@earendil-works/pi-agent-core';

export interface Config {
  model?: string;
  thinking?: ThinkingLevel;
  docsDirs: string[];
  timeoutMs: number;
  maxTurns: number;
  maxContextBytes: number;
  maxResultBytes: number;
  maxFiles: number;
  maxEdits: number;
}
const limits = {
  timeoutMs: [180_000, 1000, 600_000], maxTurns: [20, 1, 40],
  maxContextBytes: [120_000, 1000, 500_000], maxResultBytes: [32_000, 1000, 100_000],
  maxFiles: [24, 1, 64], maxEdits: [8, 1, 20],
} as const;
export function parseConfig(value: unknown): Config {
  const fail = (): never => { throw new Error('Clio config: invalid or unknown field'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(key => !['model', 'thinking', 'docsDirs', ...Object.keys(limits)].includes(key))) fail();
  if (data.model !== undefined && (typeof data.model !== 'string' || !/^[^\s/]+\/\S+$/.test(data.model))) fail();
  if (data.thinking !== undefined && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(data.thinking))) fail();
  const dirs = data.docsDirs === undefined ? [] : data.docsDirs;
  if (!Array.isArray(dirs) || dirs.length > 16 || dirs.some(d => typeof d !== 'string' || !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(d))) fail();
  const result = {model: data.model, thinking: data.thinking, docsDirs: dirs} as Config;
  for (const [key, [fallback, min, max]] of Object.entries(limits)) {
    const v = data[key] === undefined ? fallback : data[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) fail();
    (result as unknown as Record<string, unknown>)[key] = v;
  }
  return result;
}
