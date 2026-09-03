import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionAPI,
  type SourceInfo,
} from "@earendil-works/pi-coding-agent";

export type ConfigScope = "user" | "project" | "temporary";
export type TranslationMode = "manual" | "automatic";

export interface TranslateConfig {
  language: string;
  model: string;
  mode: TranslationMode;
  timeoutMs?: number;
}

export const DEFAULT_TRANSLATION_TIMEOUT_MS = 60_000;
export const MIN_TRANSLATION_TIMEOUT_MS = 1_000;
export const MAX_TRANSLATION_TIMEOUT_MS = 300_000;
const REQUIRED_CONFIG_KEYS = ["language", "mode", "model"];
const CONFIG_KEYS = [...REQUIRED_CONFIG_KEYS, "timeoutMs"];

export function parseLanguage(value: unknown): string | undefined {
  if (typeof value !== "string" || /[\r\n]/u.test(value)) return undefined;
  const language = value.trim();
  return language || undefined;
}

export function parseConfig(value: unknown): TranslateConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.some((key) => !CONFIG_KEYS.includes(key)) || REQUIRED_CONFIG_KEYS.some((key) => !keys.includes(key))) return undefined;
  const language = parseLanguage(record.language);
  if (!language) return undefined;
  if (typeof record.model !== "string" || !parseModelSpec(record.model)) return undefined;
  if (record.mode !== "manual" && record.mode !== "automatic") return undefined;
  if (record.timeoutMs !== undefined && (
    !Number.isInteger(record.timeoutMs) ||
    (record.timeoutMs as number) < MIN_TRANSLATION_TIMEOUT_MS ||
    (record.timeoutMs as number) > MAX_TRANSLATION_TIMEOUT_MS
  )) return undefined;
  return {
    language,
    model: record.model,
    mode: record.mode,
    ...(record.timeoutMs !== undefined ? { timeoutMs: record.timeoutMs as number } : {}),
  };
}

export const TRANSLATE_COMMAND_DESCRIPTION = "Translate latest assistant prose or manage automatic display-only translation";

export function resolveTranslateSource(pi: Pick<ExtensionAPI, "getCommands">): SourceInfo | undefined {
  const matches = pi.getCommands().filter(
    (candidate) =>
      candidate.source === "extension" &&
      (candidate.name === "translate" || /^translate:\d+$/.test(candidate.name)) &&
      candidate.description === TRANSLATE_COMMAND_DESCRIPTION,
  );
  // Pi exposes canonical sourceInfo on commands, but does not expose the currently
  // executing extension's identity. Name + private description is the strongest
  // available correlation; duplicates therefore must fail closed.
  return matches.length === 1 ? matches[0]!.sourceInfo : undefined;
}

export function resolveSourceScope(pi: Pick<ExtensionAPI, "getCommands">): ConfigScope | undefined {
  return resolveTranslateSource(pi)?.scope;
}

export function sourceIdentity(sourceInfo: SourceInfo): string {
  return JSON.stringify({
    path: sourceInfo.path,
    source: sourceInfo.source,
    origin: sourceInfo.origin,
    baseDir: sourceInfo.baseDir ?? null,
  });
}

const CONFIG_FILE = "translate.json";
const TEMPORARY_CONFIGS_KEY = Symbol.for("@pithos-kit/translate/temporary-configs");
const processState = globalThis as unknown as Record<PropertyKey, unknown>;
const existingTemporaryConfigs = processState[TEMPORARY_CONFIGS_KEY];
const temporaryConfigs = existingTemporaryConfigs instanceof Map
  ? existingTemporaryConfigs as Map<string, TranslateConfig>
  : new Map<string, TranslateConfig>();
processState[TEMPORARY_CONFIGS_KEY] = temporaryConfigs;

export class ScopedConfigStore {
  constructor(
    readonly scope: ConfigScope,
    private readonly cwd: string,
    private readonly agentDir = getAgentDir(),
    private readonly temporarySource = "default",
  ) {}

  async load(): Promise<TranslateConfig | undefined> {
    if (this.scope === "temporary") {
      const config = temporaryConfigs.get(this.temporaryKey());
      return config && { ...config };
    }
    try {
      return parseConfig(JSON.parse(await readFile(this.path(), "utf8")));
    } catch {
      return undefined;
    }
  }

  async save(config: TranslateConfig): Promise<void> {
    if (this.scope === "temporary") {
      temporaryConfigs.set(this.temporaryKey(), { ...config });
      return;
    }
    const path = this.path();
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, path);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private temporaryKey(): string {
    return `${resolve(this.cwd)}\0${this.temporarySource}`;
  }

  private path(): string {
    if (this.scope === "temporary") throw new Error("Temporary configuration has no file path");
    return this.scope === "user"
      ? join(this.agentDir, CONFIG_FILE)
      : join(this.cwd, CONFIG_DIR_NAME, CONFIG_FILE);
  }
}

export function parseModelSpec(spec: string): { provider: string; model: string } | undefined {
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) return undefined;
  const provider = spec.slice(0, slash).trim();
  const model = spec.slice(slash + 1).trim();
  if (!provider || !model || `${provider}/${model}` !== spec) return undefined;
  return { provider, model };
}
