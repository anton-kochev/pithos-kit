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
export type TranslationMode = "on" | "off";

export interface InputTranslateConfig {
  mode: TranslationMode;
  model: string;
  timeoutMs?: number;
}

export interface OutputTranslateConfig extends InputTranslateConfig {
  language: string;
}

export interface TranslateConfig {
  input?: InputTranslateConfig;
  output?: OutputTranslateConfig;
}

export const DEFAULT_TRANSLATION_TIMEOUT_MS = 60_000;
export const MIN_TRANSLATION_TIMEOUT_MS = 1_000;
export const MAX_TRANSLATION_TIMEOUT_MS = 300_000;
const ROOT_CONFIG_KEYS = ["input", "output"];
const INPUT_CONFIG_KEYS = ["mode", "model", "timeoutMs"];
const OUTPUT_CONFIG_KEYS = ["language", ...INPUT_CONFIG_KEYS];

export function parseLanguage(value: unknown): string | undefined {
  if (typeof value !== "string" || /[\r\n]/u.test(value)) return undefined;
  const language = value.trim();
  return language || undefined;
}

export function parseConfig(value: unknown): TranslateConfig | undefined {
  if (!isRecord(value)) return undefined;
  if (Object.keys(value).some((key) => !ROOT_CONFIG_KEYS.includes(key))) return undefined;

  const input = value.input === undefined ? undefined : parseInputConfig(value.input);
  if (value.input !== undefined && !input) return undefined;
  const output = value.output === undefined ? undefined : parseOutputConfig(value.output);
  if (value.output !== undefined && !output) return undefined;

  return {
    ...(input ? { input } : {}),
    ...(output ? { output } : {}),
  };
}

function parseInputConfig(value: unknown): InputTranslateConfig | undefined {
  if (!isRecord(value) || !hasExactRequiredKeys(value, INPUT_CONFIG_KEYS, ["mode", "model"])) return undefined;
  const common = parseCommonConfig(value);
  return common;
}

function parseOutputConfig(value: unknown): OutputTranslateConfig | undefined {
  if (!isRecord(value) || !hasExactRequiredKeys(value, OUTPUT_CONFIG_KEYS, ["language", "mode", "model"])) return undefined;
  const common = parseCommonConfig(value);
  const language = parseLanguage(value.language);
  if (!common || !language) return undefined;
  return { ...common, language };
}

function parseCommonConfig(value: Record<string, unknown>): InputTranslateConfig | undefined {
  if (value.mode !== "on" && value.mode !== "off") return undefined;
  if (typeof value.model !== "string" || !parseModelSpec(value.model)) return undefined;
  if (value.timeoutMs !== undefined && (
    !Number.isInteger(value.timeoutMs) ||
    (value.timeoutMs as number) < MIN_TRANSLATION_TIMEOUT_MS ||
    (value.timeoutMs as number) > MAX_TRANSLATION_TIMEOUT_MS
  )) return undefined;
  return {
    mode: value.mode,
    model: value.model,
    ...(value.timeoutMs !== undefined ? { timeoutMs: value.timeoutMs as number } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasExactRequiredKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return !keys.some((key) => !allowed.includes(key)) && required.every((key) => keys.includes(key));
}

export const TRANSLATE_COMMAND_DESCRIPTION = "Translate assistant output or transform interactive input into English";

export function resolveTranslateSource(pi: Pick<ExtensionAPI, "getCommands">): SourceInfo | undefined {
  const matches = pi.getCommands().filter(
    (candidate) =>
      candidate.source === "extension" &&
      (candidate.name === "translate" || /^translate:\d+$/.test(candidate.name)) &&
      candidate.description === TRANSLATE_COMMAND_DESCRIPTION,
  );
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
const TEMPORARY_CONFIGS_KEY = Symbol.for("@pithos-kit/translate/temporary-configs-v2");
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
      return config && structuredClone(config);
    }
    try {
      return parseConfig(JSON.parse(await readFile(this.path(), "utf8")));
    } catch {
      return undefined;
    }
  }

  async save(config: TranslateConfig): Promise<void> {
    if (this.scope === "temporary") {
      temporaryConfigs.set(this.temporaryKey(), structuredClone(config));
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
