import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import { parseTranslateCommand, TRANSLATE_CONTROL_ARGUMENTS, TRANSLATE_HELP } from "./command-help.ts";
import {
  resolveTranslateSource,
  ScopedConfigStore,
  sourceIdentity,
  DEFAULT_TRANSLATION_TIMEOUT_MS,
  TRANSLATE_COMMAND_DESCRIPTION,
  type ConfigScope,
  type InputTranslateConfig,
  type OutputTranslateConfig,
  type TranslateConfig,
} from "./config.ts";
import {
  AUTOMATIC_ENTRY_TYPE,
  fingerprintMarkdown,
  TranslationDisplayCache,
  type AutomaticTranslationRecordV2,
  type AutomaticTranslationSuccess,
  type TranslationUsageRecord,
} from "./display-cache.ts";
import { containsMermaidFence } from "./markdown-protection.ts";
import {
  getEligibleTextBlocks,
  latestEligibleAssistant,
  translateInputMarkdown,
  translateMarkdown,
  type TranslationResult,
} from "./translation.ts";
import { runConfigWizard, runInputConfigWizard, runTranslationWithUi } from "./ui.ts";
import { createPithosLogger, errorMetadata, modelMetadata, usageMetadata, type PithosLogger } from "./logging.ts";

export const MANUAL_ENTRY_TYPE = "pithos.translate.manual";
const AUTOMATIC_STATUS_KEY = "pithos.translate";
const INPUT_STATUS_KEY = "pithos.translate.input";
const AUTOMATIC_STATUS_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface ManualTranslationRecord {
  version: 1;
  source: string;
  sourceFingerprint: string;
  translated: string;
  language: string;
  model: string;
  usage: Usage;
  timestamp: number;
}

interface PendingAutomaticRecord {
  message: object;
  key: string;
  record: AutomaticTranslationRecordV2;
}

export interface TranslateDependencies {
  configure?: (ctx: ExtensionContext, current?: OutputTranslateConfig) => Promise<OutputTranslateConfig | undefined>;
  configureInput?: (ctx: ExtensionContext, current?: InputTranslateConfig) => Promise<InputTranslateConfig | undefined>;
  translate?: (
    source: string,
    config: OutputTranslateConfig,
    modelRegistry: ExtensionContext["modelRegistry"],
    signal?: AbortSignal,
  ) => Promise<TranslationResult>;
  translateInput?: (
    source: string,
    config: InputTranslateConfig,
    modelRegistry: ExtensionContext["modelRegistry"],
    signal?: AbortSignal,
  ) => Promise<TranslationResult>;
  runWithUi?: typeof runTranslationWithUi;
  createStore?: (scope: ConfigScope, cwd: string, temporarySource: string) => ScopedConfigStore;
  logger?: Pick<PithosLogger, "info" | "error">;
}

export function registerTranslate(pi: ExtensionAPI, dependencies: TranslateDependencies = {}): void {
  const log = dependencies.logger ?? createPithosLogger();
  log.info("extension.register");
  const configureOutput = dependencies.configure ?? runConfigWizard;
  const configureInput = dependencies.configureInput ?? runInputConfigWizard;
  const translate = dependencies.translate ?? translateMarkdown;
  const translateInput = dependencies.translateInput ?? translateInputMarkdown;
  const runWithUi = dependencies.runWithUi ?? runTranslationWithUi;
  const displayCache = new TranslationDisplayCache();
  let store: ScopedConfigStore | undefined;
  let config: TranslateConfig | undefined;
  let pendingAutomaticRecords = new WeakMap<object, PendingAutomaticRecord>();
  let pendingAutomaticRecordsByKey = new Map<string, Set<PendingAutomaticRecord>>();
  let stopAutomaticIndicator: (() => void) | undefined;
  let stopInputIndicator: (() => void) | undefined;

  const clearAutomaticIndicator = (): void => {
    stopAutomaticIndicator?.();
  };

  const startAutomaticIndicator = (
    ctx: ExtensionContext,
    activeConfig: OutputTranslateConfig,
  ): (() => void) => {
    clearAutomaticIndicator();
    if (ctx.mode !== "tui" || !ctx.hasUI) return () => {};

    let frame = 0;
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const signal = ctx.signal;
    const render = (): void => {
      const theme = ctx.ui.theme;
      const spinner = theme.fg("accent", AUTOMATIC_STATUS_FRAMES[frame]!);
      const text = theme.fg("dim", ` Translating into ${activeConfig.language} with ${activeConfig.model}...`);
      ctx.ui.setStatus(AUTOMATIC_STATUS_KEY, spinner + text);
      frame = (frame + 1) % AUTOMATIC_STATUS_FRAMES.length;
    };
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      signal?.removeEventListener("abort", stopIfCurrent);
      ctx.ui.setStatus(AUTOMATIC_STATUS_KEY, undefined);
    };
    const stopIfCurrent = (): void => {
      if (stopAutomaticIndicator !== stopIfCurrent) return;
      stopAutomaticIndicator = undefined;
      stop();
    };

    stopAutomaticIndicator = stopIfCurrent;
    render();
    timer = setInterval(render, 120);
    timer.unref?.();
    signal?.addEventListener("abort", stopIfCurrent, { once: true });
    if (signal?.aborted) stopIfCurrent();
    return stopIfCurrent;
  };

  const clearInputIndicator = (): void => {
    stopInputIndicator?.();
  };

  const startInputIndicator = (
    ctx: ExtensionContext,
    activeConfig: InputTranslateConfig,
  ): (() => void) => {
    clearInputIndicator();
    if (ctx.mode !== "tui" || !ctx.hasUI) return () => {};

    let frame = 0;
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const render = (): void => {
      const theme = ctx.ui.theme;
      const spinner = theme.fg("accent", AUTOMATIC_STATUS_FRAMES[frame]!);
      const text = theme.fg("dim", ` Translating prompt into English with ${activeConfig.model}...`);
      ctx.ui.setStatus(INPUT_STATUS_KEY, spinner + text);
      frame = (frame + 1) % AUTOMATIC_STATUS_FRAMES.length;
    };
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      if (stopInputIndicator === stop) stopInputIndicator = undefined;
      ctx.ui.setStatus(INPUT_STATUS_KEY, undefined);
    };

    stopInputIndicator = stop;
    render();
    timer = setInterval(render, 120);
    timer.unref?.();
    return stop;
  };

  const clearPendingAutomaticRecords = (): void => {
    pendingAutomaticRecords = new WeakMap();
    pendingAutomaticRecordsByKey = new Map();
  };

  const queueAutomaticRecord = (message: object, record: AutomaticTranslationRecordV2): void => {
    const key = automaticMessageKey(message);
    if (!key) return;
    const pending = { message, key, record };
    pendingAutomaticRecords.set(message, pending);
    const byKey = pendingAutomaticRecordsByKey.get(key) ?? new Set();
    byKey.add(pending);
    pendingAutomaticRecordsByKey.set(key, byKey);
  };

  const initialize = async (ctx: ExtensionContext): Promise<boolean> => {
    displayCache.restore(ctx.sessionManager.getBranch());
    const source = resolveTranslateSource(pi);
    if (!source) {
      store = undefined;
      config = undefined;
      notify(ctx, "Translation is disabled because its command source could not be unambiguously resolved.", "error");
      return false;
    }
    const identity = sourceIdentity(source);
    store = dependencies.createStore?.(source.scope, ctx.cwd, identity) ??
      new ScopedConfigStore(source.scope, ctx.cwd, undefined, identity);
    config = await store.load();
    return true;
  };

  const ensureOutputConfig = async (
    ctx: ExtensionContext,
    initialMode?: OutputTranslateConfig["mode"],
  ): Promise<OutputTranslateConfig | undefined> => {
    if (!store && !(await initialize(ctx))) return undefined;
    if (config?.output) return config.output;
    const selected = await configureOutput(ctx);
    if (!selected) {
      notify(ctx, "Translation configuration was cancelled.", "warning");
      return undefined;
    }
    const completed = initialMode ? { ...selected, mode: initialMode } : selected;
    config = { ...config, output: completed };
    await store!.save(config);
    return completed;
  };

  const ensureInputConfig = async (
    ctx: ExtensionContext,
    initialMode?: InputTranslateConfig["mode"],
  ): Promise<InputTranslateConfig | undefined> => {
    if (!store && !(await initialize(ctx))) return undefined;
    if (config?.input) return config.input;
    const selected = await configureInput(ctx);
    if (!selected) {
      notify(ctx, "Input translation configuration was cancelled.", "warning");
      return undefined;
    }
    const completed = initialMode ? { ...selected, mode: initialMode } : selected;
    config = { ...config, input: completed };
    await store!.save(config);
    return completed;
  };

  pi.registerMarkdownTransformer((markdown, context) =>
    displayCache.transform(markdown, context, config?.output?.mode === "on"),
  );

  pi.registerEntryRenderer<ManualTranslationRecord>(MANUAL_ENTRY_TYPE, (entry, _options, theme) => {
    const data = entry.data;
    if (!data) return undefined;
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(theme.fg("customMessageLabel", `Translation · ${data.language} · ${data.model}`), 0, 0));
    box.addChild(new Markdown(data.translated, 0, 1, getMarkdownTheme()));
    return box;
  });

  pi.registerCommand("translate", {
    description: TRANSLATE_COMMAND_DESCRIPTION,
    getArgumentCompletions: (prefix) => {
      if (/\s/.test(prefix)) return null;
      const items = [...TRANSLATE_CONTROL_ARGUMENTS, "--help"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const command = parseTranslateCommand(args);
      log.info("command.translate", { sessionId: (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.(), type: command.type });
      if (command.type === "help") {
        emitHelp(ctx, TRANSLATE_HELP);
        return;
      }
      if (command.type === "error") {
        notify(ctx, `${command.message}\n\n${TRANSLATE_HELP}`, "warning");
        return;
      }
      if (command.type === "control") {
        if (command.direction === "input") {
          if (command.action === "status") {
            if (!store && !(await initialize(ctx))) return;
            notify(
              ctx,
              config?.input
                ? `Translation scope: ${store!.scope}\nLanguage: English\nModel: ${config.input.model}\nMode: ${config.input.mode}\nTimeout: ${formatTimeout(config.input.timeoutMs ?? DEFAULT_TRANSLATION_TIMEOUT_MS)}`
                : `Translation scope: ${store!.scope}\nNot configured. Run /translate input-config.`,
              "info",
            );
            return;
          }
          if (command.action === "config") {
            if (!store && !(await initialize(ctx))) return;
            const selected = await configureInput(ctx, config?.input);
            if (!selected) {
              notify(ctx, "Input translation configuration was cancelled.", "warning");
              return;
            }
            config = { ...config, input: selected };
            await store!.save(config);
            if (selected.mode !== "on") clearInputIndicator();
            notify(ctx, `Input translation configured for English with ${selected.model} (${store!.scope} scope).`, "info");
            return;
          }
          if (command.action === "off") {
            clearInputIndicator();
            if (!store && !(await initialize(ctx))) return;
            if (!config?.input) {
              notify(ctx, "Input translation is already off.", "info");
              return;
            }
            if (config.input.mode === "on") {
              config = { ...config, input: { ...config.input, mode: "off" } };
              await store!.save(config);
              notify(ctx, "Input translation is off.", "info");
            } else {
              notify(ctx, "Input translation is already off.", "info");
            }
            return;
          }
          if (command.action === "on") {
            const activeConfig = await ensureInputConfig(ctx, "on");
            if (!activeConfig) return;
            if (activeConfig.mode !== "on") {
              config = { ...config, input: { ...activeConfig, mode: "on" } };
              await store!.save(config);
            }
            notify(ctx, "Input translation is on.", "info");
            return;
          }
        }
        if (command.action === "status") {
          if (!store && !(await initialize(ctx))) return;
          notify(
            ctx,
            config?.output
              ? `Translation scope: ${store!.scope}\nLanguage: ${config.output.language}\nModel: ${config.output.model}\nMode: ${config.output.mode}\nTimeout: ${formatTimeout(config.output.timeoutMs ?? DEFAULT_TRANSLATION_TIMEOUT_MS)}`
              : `Translation scope: ${store!.scope}\nNot configured. Run /translate output-config.`,
            "info",
          );
          return;
        }
        if (command.action === "config") {
          if (!store && !(await initialize(ctx))) return;
          const selected = await configureOutput(ctx, config?.output);
          if (!selected) {
            notify(ctx, "Translation configuration was cancelled.", "warning");
            return;
          }
          config = { ...config, output: selected };
          await store!.save(config);
          if (selected.mode !== "on") clearAutomaticIndicator();
          notify(ctx, `Translation configured for ${selected.language} with ${selected.model} (${store!.scope} scope).`, "info");
          return;
        }
        if (command.action === "off") {
          clearAutomaticIndicator();
          if (!store && !(await initialize(ctx))) return;
          if (!config?.output) {
            notify(ctx, "Automatic translation is already off.", "info");
            return;
          }
          if (config.output.mode === "on") {
            config = { ...config, output: { ...config.output, mode: "off" } };
            await store!.save(config);
            notify(ctx, "Automatic translation is off.", "info");
          } else {
            notify(ctx, "Automatic translation is already off.", "info");
          }
          return;
        }
        if (command.action === "on") {
          const activeConfig = await ensureOutputConfig(ctx, "on");
          if (!activeConfig) return;
          if (activeConfig.mode !== "on") {
            config = { ...config, output: { ...activeConfig, mode: "on" } };
            await store!.save(config);
          }
          notify(ctx, "Automatic translation is on.", "info");
          return;
        }
      }

      if (ctx.mode !== "tui") {
        notify(ctx, "Translation display is available only in Pi's interactive TUI.", "error");
        return;
      }
      const activeConfig = await ensureOutputConfig(ctx);
      if (!activeConfig) return;
      const entry = latestEligibleAssistant(ctx.sessionManager.getBranch());
      const blocks = entry ? getEligibleTextBlocks(entry.message) : undefined;
      if (!blocks) {
        notify(ctx, "No completed assistant prose is available to translate.", "warning");
        return;
      }
      const source = blocks.join("\n\n");
      const started = Date.now();
      const result = await runWithUi(
        ctx,
        activeConfig.language,
        activeConfig.model,
        (signal) => translate(source, activeConfig, ctx.modelRegistry, signal),
      );
      log.info(result.ok ? "translation.manual.complete" : "translation.manual.failed", { sessionId: (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.(), durationMs: Date.now() - started, language: activeConfig.language, model: activeConfig.model, blockCount: blocks.length, sourceChars: source.length, usage: usageMetadata(result.usage), ...(!result.ok ? { kind: result.kind, error: result.error } : {}) });
      if (!result.ok) {
        notify(ctx, result.error, result.kind === "cancelled" ? "warning" : "error");
        return;
      }
      pi.appendEntry<ManualTranslationRecord>(MANUAL_ENTRY_TYPE, {
        version: 1,
        source,
        sourceFingerprint: fingerprintMarkdown(source),
        translated: result.markdown,
        language: activeConfig.language,
        model: activeConfig.model,
        usage: result.usage,
        timestamp: Date.now(),
      });
    },
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };
    if (!store && !(await initialize(ctx))) return { action: "continue" };

    const activeConfig = config?.input;
    if (activeConfig?.mode !== "on") return { action: "continue" };

    const idle = ctx.isIdle();
    const supported = ctx.mode === "tui" &&
      event.source === "interactive" &&
      event.streamingBehavior === undefined &&
      idle;
    if (!supported) {
      log.info("translation.input.blocked", {
        sessionId: (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.(),
        language: "English",
        model: activeConfig.model,
        sourceChars: event.text.length,
        mode: ctx.mode,
        inputSource: event.source,
        streamingBehavior: event.streamingBehavior,
        idle,
      });
      restoreInputDraft(event.text, event.source, ctx);
      notify(ctx, "Input translation supports only ordinary idle interactive prompts; this input was blocked.", "warning");
      return { action: "handled" };
    }

    const prepared = prepareInboundPrompt(event.text, pi.getCommands());
    if (!prepared) return { action: "continue" };

    const stopIndicator = startInputIndicator(ctx, activeConfig);
    const started = Date.now();
    let result: TranslationResult;
    try {
      result = await translateInput(prepared.source, activeConfig, ctx.modelRegistry, ctx.signal);
    } catch {
      log.error("translation.input.error", {
        sessionId: (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.(),
        durationMs: Date.now() - started,
        language: "English",
        model: activeConfig.model,
        sourceChars: prepared.source.length,
        kind: "unexpected-error",
      });
      restoreInputDraft(event.text, event.source, ctx);
      notify(ctx, "Input translation failed. Your draft was restored.", "error");
      return { action: "handled" };
    } finally {
      stopIndicator();
    }

    log.info(result.ok ? "translation.input.complete" : "translation.input.failed", {
      sessionId: (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.(),
      durationMs: Date.now() - started,
      language: "English",
      model: activeConfig.model,
      sourceChars: prepared.source.length,
      changed: result.ok ? result.markdown !== prepared.source : undefined,
      usage: usageMetadata(result.usage),
      ...(!result.ok ? { kind: result.kind } : {}),
    });
    if (!result.ok) {
      restoreInputDraft(event.text, event.source, ctx);
      notify(ctx, inputFailureMessage(result.kind), result.kind === "cancelled" ? "warning" : "error");
      return { action: "handled" };
    }

    return {
      action: "transform",
      text: prepared.prefix + result.markdown,
      ...(event.images !== undefined ? { images: event.images } : {}),
    };
  });

  pi.on("session_start", async (event, ctx) => {
    log.info("session.start", { reason: event.reason, sessionId: (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.() });
    clearAutomaticIndicator();
    clearInputIndicator();
    clearPendingAutomaticRecords();
    await initialize(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    clearAutomaticIndicator();
    clearInputIndicator();
    clearPendingAutomaticRecords();
    displayCache.restore(ctx.sessionManager.getBranch());
  });

  pi.on("session_shutdown", (event) => {
    log.info("session.shutdown", { reason: event.reason });
    clearAutomaticIndicator();
    clearInputIndicator();
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role === "assistant") {
      log.info("agent.response.complete", {
        sessionId: (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.(),
        ...modelMetadata(event.message),
        stopReason: event.message.stopReason,
        usage: usageMetadata(event.message.usage),
      });
    }

    const activeConfig = config?.output;
    const blocks = getEligibleTextBlocks(event.message);
    if (ctx.mode !== "tui" || activeConfig?.mode !== "on" || !blocks) {
      clearAutomaticIndicator();
      return;
    }

    let finishIndicator: (() => void) | undefined;
    const started = Date.now();
    try {
      // Remove stale substitutions immediately. The version 2 record repeats the
      // same decisions durably after Pi has persisted this source message.
      displayCache.showOriginal(blocks);
      const outcomes: AutomaticTranslationRecordV2["outcomes"] = [];
      const totalUsage = emptyUsageRecord();
      for (const source of blocks) {
        if (containsMermaidFence(source)) {
          outcomes.push(suppressionFor(source));
          continue;
        }
        finishIndicator ??= startAutomaticIndicator(ctx, activeConfig);
        const result = await translate(source, activeConfig, ctx.modelRegistry, ctx.signal);
        if (!result.ok) {
          if (result.usage) addUsage(totalUsage, result.usage);
          const record = automaticRecord(activeConfig, blocks, blocks.map(suppressionFor), totalUsage);
          displayCache.add(record);
          queueAutomaticRecord(event.message, record);
          log.info("translation.automatic.failed", { sessionId: (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.(), durationMs: Date.now() - started, language: activeConfig.language, model: activeConfig.model, blockCount: blocks.length, usage: usageMetadata(totalUsage), kind: result.kind, error: result.error });
          notify(ctx, `Automatic translation failed; showing the original response. ${result.error}`, result.kind === "cancelled" ? "warning" : "error");
          return;
        }
        const success: AutomaticTranslationSuccess = {
          kind: "translated",
          source,
          sourceFingerprint: fingerprintMarkdown(source),
          translated: result.markdown,
        };
        outcomes.push(success);
        addUsage(totalUsage, result.usage);
      }

      const record = automaticRecord(activeConfig, blocks, outcomes, totalUsage);
      log.info("translation.automatic.complete", { sessionId: (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.(), durationMs: Date.now() - started, language: activeConfig.language, model: activeConfig.model, blockCount: blocks.length, translatedCount: outcomes.filter((outcome) => outcome.kind === "translated").length, usage: usageMetadata(totalUsage) });
      displayCache.add(record);
      queueAutomaticRecord(event.message, record);
    } catch (error) {
      log.error("translation.automatic.error", { sessionId: (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.(), durationMs: Date.now() - started, language: activeConfig.language, model: activeConfig.model, error: errorMetadata(error) });
      throw error;
    } finally {
      finishIndicator?.();
    }
  });

  pi.on("turn_end", (event) => {
    if (!event.message || typeof event.message !== "object") return;
    // Pi 0.84 currently forwards the same AgentMessage object from message_end,
    // but the public API promises fields, not identity. Fall back to a unique
    // field correlation and fail closed if two pending messages are ambiguous.
    let pending = pendingAutomaticRecords.get(event.message);
    if (!pending) {
      const key = automaticMessageKey(event.message);
      const matches = key ? pendingAutomaticRecordsByKey.get(key) : undefined;
      if (matches?.size === 1) pending = matches.values().next().value;
    }
    if (!pending) return;
    pi.appendEntry(AUTOMATIC_ENTRY_TYPE, pending.record);
    pendingAutomaticRecords.delete(pending.message);
    const matches = pendingAutomaticRecordsByKey.get(pending.key);
    matches?.delete(pending);
    if (matches?.size === 0) pendingAutomaticRecordsByKey.delete(pending.key);
  });
}

interface PreparedInboundPrompt {
  prefix: string;
  source: string;
}

function prepareInboundPrompt(
  text: string,
  commands: readonly { name: string; source: string }[],
): PreparedInboundPrompt | undefined {
  if (!text.trim()) return undefined;

  const directive = /^(\S+)(\s+)([\s\S]*)$/u.exec(text);
  const token = directive?.[1] ?? (/^\S+$/u.test(text) ? text : undefined);
  if (token?.startsWith("/") && commands.some(
    (command) =>
      (command.source === "prompt" || command.source === "skill") &&
      command.name === token.slice(1),
  )) {
    if (!directive || !directive[3]?.trim()) return undefined;
    return { prefix: directive[1]! + directive[2]!, source: directive[3] };
  }

  return { prefix: "", source: text };
}

function restoreInputDraft(text: string, source: string, ctx: ExtensionContext): void {
  if (ctx.mode === "tui" && source === "interactive" && ctx.hasUI) ctx.ui.setEditorText(text);
}

function inputFailureMessage(kind: string): string {
  if (kind === "cancelled") return "Input translation was cancelled. Your draft was restored.";
  if (kind === "timeout") return "Input translation timed out. Your draft was restored.";
  if (kind === "model-unavailable" || kind === "unauthenticated") {
    return "The configured input translation model is unavailable. Your draft was restored.";
  }
  return "Input translation failed. Your draft was restored.";
}

function automaticMessageKey(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const blocks = getEligibleTextBlocks(message);
  if (!blocks) return undefined;
  const candidate = message as Record<string, unknown>;
  return JSON.stringify({
    timestamp: typeof candidate.timestamp === "number" ? candidate.timestamp : null,
    provider: typeof candidate.provider === "string" ? candidate.provider : null,
    model: typeof candidate.model === "string" ? candidate.model : null,
    sourceFingerprint: fingerprintMarkdown(blocks.join("\n\n")),
  });
}

function suppressionFor(
  source: string,
): Extract<AutomaticTranslationRecordV2["outcomes"][number], { kind: "suppressed" }> {
  return { kind: "suppressed", source, sourceFingerprint: fingerprintMarkdown(source) };
}

function automaticRecord(
  config: OutputTranslateConfig,
  sources: readonly string[],
  outcomes: AutomaticTranslationRecordV2["outcomes"],
  usage: TranslationUsageRecord,
): AutomaticTranslationRecordV2 {
  return {
    version: 2,
    language: config.language,
    model: config.model,
    sourceFingerprint: fingerprintMarkdown(sources.join("\n\n")),
    outcomes,
    usage,
    timestamp: Date.now(),
  };
}

function emptyUsageRecord(): TranslationUsageRecord {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
}

function addUsage(target: TranslationUsageRecord, usage: Usage): void {
  target.input += usage.input;
  target.output += usage.output;
  target.cacheRead += usage.cacheRead;
  target.cacheWrite += usage.cacheWrite;
  target.totalTokens += usage.totalTokens;
  target.cost += usage.cost.total;
}

function formatTimeout(timeoutMs: number): string {
  return timeoutMs % 1_000 === 0 ? `${timeoutMs / 1_000}s` : `${timeoutMs}ms`;
}

function emitHelp(ctx: ExtensionCommandContext, help: string): void {
  if (ctx.hasUI) ctx.ui.notify(help, "info");
  else console.log(help);
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}

export default function translateExtension(pi: ExtensionAPI): void {
  registerTranslate(pi);
}
