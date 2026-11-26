import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';

export interface ClassifierConfig {
  /** Exact registered classifier, `provider/model-id`. */
  model: string;
  /** Minimum usefulness score (0–3) for a session window to reach the worker. */
  collectThreshold: number;
  /** Minimum usefulness score (0–3) for an edit to be committed without review. */
  gateThreshold: number;
  /** Most session windows handed to the worker. */
  maxWindows: number;
  timeoutMs: number;
}

export interface Config {
  model?: string;
  thinking?: ThinkingLevel;
  docsDirs: string[];
  autoCommit: boolean;
  timeoutMs: number;
  maxTurns: number;
  /** Worker context budget. Defaults to min(64k, half the model's context window). */
  maxContextTokens?: number;
  maxEdits: number;
  maxCommits: number;
  classifier?: ClassifierConfig;
}

type Range = readonly [fallback: number, min: number, max: number];
const LIMITS: Record<'timeoutMs' | 'maxTurns' | 'maxContextTokens' | 'maxEdits' | 'maxCommits', Range> = {
  timeoutMs: [300_000, 10_000, 1_800_000],
  maxTurns: [16, 2, 40],
  maxContextTokens: [64_000, 8_000, 400_000],
  maxEdits: [6, 1, 20],
  maxCommits: [20, 1, 200],
};
const CLASSIFIER_LIMITS: Record<'collectThreshold' | 'gateThreshold' | 'maxWindows' | 'timeoutMs', Range> = {
  collectThreshold: [1.0, 0, 3],
  gateThreshold: [1.0, 0, 3],
  maxWindows: [8, 1, 40],
  timeoutMs: [30_000, 1_000, 300_000],
};
const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const MODEL_SPEC = /^[^\s/]+\/\S+$/;
const DOCS_DIR = /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/;

function fail(detail: string): never {
  throw new Error(`Clio config: ${detail}`);
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function only(data: Record<string, unknown>, allowed: string[], name: string): void {
  const unknown = Object.keys(data).filter(key => !allowed.includes(key));
  if (unknown.length) fail(`unknown field ${name}${unknown[0]}`);
}

function number(data: Record<string, unknown>, key: string, [fallback, min, max]: Range, integer: boolean): number {
  const value = data[key] ?? fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    fail(`${key} must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}`);
  }
  return value;
}

function parseClassifier(value: unknown): ClassifierConfig {
  const data = object(value, 'classifier');
  only(data, ['model', ...Object.keys(CLASSIFIER_LIMITS)], 'classifier.');
  if (typeof data.model !== 'string' || !MODEL_SPEC.test(data.model)) fail('classifier.model must be provider/model-id');
  return {
    model: data.model,
    collectThreshold: number(data, 'collectThreshold', CLASSIFIER_LIMITS.collectThreshold, false),
    gateThreshold: number(data, 'gateThreshold', CLASSIFIER_LIMITS.gateThreshold, false),
    maxWindows: number(data, 'maxWindows', CLASSIFIER_LIMITS.maxWindows, true),
    timeoutMs: number(data, 'timeoutMs', CLASSIFIER_LIMITS.timeoutMs, true),
  };
}

export function parseConfig(value: unknown): Config {
  const data = object(value, 'configuration');
  only(data, ['model', 'thinking', 'docsDirs', 'autoCommit', 'classifier', ...Object.keys(LIMITS)], '');
  if (data.model !== undefined && (typeof data.model !== 'string' || !MODEL_SPEC.test(data.model))) fail('model must be provider/model-id');
  if (data.thinking !== undefined && !THINKING.includes(String(data.thinking))) fail(`thinking must be one of ${THINKING.join(', ')}`);
  const docsDirs = data.docsDirs ?? [];
  if (!Array.isArray(docsDirs) || docsDirs.length > 16 || docsDirs.some(d => typeof d !== 'string' || !DOCS_DIR.test(d))) {
    fail('docsDirs must be at most 16 relative directory names');
  }
  if (data.autoCommit !== undefined && typeof data.autoCommit !== 'boolean') fail('autoCommit must be true or false');
  return {
    model: data.model as string | undefined,
    thinking: data.thinking as ThinkingLevel | undefined,
    docsDirs: docsDirs as string[],
    autoCommit: data.autoCommit !== false,
    timeoutMs: number(data, 'timeoutMs', LIMITS.timeoutMs, true),
    maxTurns: number(data, 'maxTurns', LIMITS.maxTurns, true),
    maxContextTokens: data.maxContextTokens === undefined ? undefined : number(data, 'maxContextTokens', LIMITS.maxContextTokens, true),
    maxEdits: number(data, 'maxEdits', LIMITS.maxEdits, true),
    maxCommits: number(data, 'maxCommits', LIMITS.maxCommits, true),
    classifier: data.classifier === undefined ? undefined : parseClassifier(data.classifier),
  };
}

/** Reads project-local `.pi/clio.json`. Missing file means defaults; anything malformed throws. */
export async function loadConfig(cwd: string): Promise<Config> {
  const path = join(cwd, '.pi/clio.json');
  try {
    for (const candidate of [join(cwd, '.pi'), path]) {
      if ((await lstat(candidate)).isSymbolicLink()) fail('symlinked configuration refused');
    }
    const file = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(16_385);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 16_384) fail('file is larger than 16 KiB');
      let json: unknown;
      try { json = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')); } catch { fail('file is not valid JSON'); }
      return parseConfig(json);
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return parseConfig({});
    throw error;
  }
}
