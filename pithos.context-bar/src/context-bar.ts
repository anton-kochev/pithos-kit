import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CustomEditor,
  sessionEntryToContextMessages,
  type BuildSystemPromptOptions,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  buildContextSnapshot,
  type ContextMessageLike,
  type ContextSnapshot,
} from "./context-model.ts";
import {
  createContextBarComponent,
  formatContextStatus,
  withoutTopEditorBorder,
} from "./ui.ts";
import {
  CodexUsageAuthError,
  CodexUsageError,
  fetchCodexUsage,
  formatCodexUsageDetails,
  formatCodexUsageFooter,
  resolveCodexUsageAuth,
  type CodexUsage,
} from "./codex-usage.ts";
import { createPithosLogger, errorMetadata } from "./logging.ts";

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

const CONTEXT_BAR_PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WIDGET_KEY = "context-bar";
const CODEX_USAGE_STATUS_KEY = "context-bar-codex-usage";
const STATE_ENTRY_TYPE = "context-bar-enabled";
const CODEX_USAGE_REFRESH_INTERVAL_MS = 60_000;
const CODEX_USAGE_TIMEOUT_MS = 5_000;
const CODEX_USAGE_AUTH_POLL_MS = 15_000;

export interface ContextBarDependencies {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  isOffline?: () => boolean;
  codexUsageTimeoutMs?: number;
  codexUsageAuthPollMs?: number;
}
const CONTEXT_BAR_HELP = `Usage: /context-bar [on|off|status|refresh]

Toggle the context-window composition bar, set it explicitly on or off, show its current token breakdown and Codex usage, or refresh Codex usage immediately.

Options:
  on           Enable Context Bar
  off          Disable Context Bar
  status       Show context and Codex usage details
  refresh      Refresh Codex usage immediately
  --help, -h   Show this help`;

const CONTEXT_BAR_ARGUMENTS = [
  { value: "on", label: "on", description: "Enable Context Bar" },
  { value: "off", label: "off", description: "Disable Context Bar" },
  { value: "status", label: "status", description: "Show context and Codex usage details" },
  { value: "refresh", label: "refresh", description: "Refresh Codex usage immediately" },
  { value: "--help", label: "--help", description: "Show command help" },
];

function contextBarArgumentCompletions(prefix: string) {
  const items = CONTEXT_BAR_ARGUMENTS.filter(({ value }) => value.startsWith(prefix));
  return items.length > 0 ? items : null;
}

function emitHelp(ctx: ExtensionCommandContext): void {
  if (ctx.hasUI) ctx.ui.notify(CONTEXT_BAR_HELP, "info");
  else console.log(CONTEXT_BAR_HELP);
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function requestFingerprint(
  systemPrompt: string,
  tools: ReturnType<ExtensionAPI["getAllTools"]>,
): string {
  const hash = createHash("sha256");
  hash.update(systemPrompt);
  for (const tool of [...tools].sort((left, right) => left.name.localeCompare(right.name))) {
    hash.update("\0");
    hash.update(tool.name);
    hash.update("\0");
    hash.update(tool.description ?? "");
    hash.update("\0");
    hash.update(stableJson(tool.parameters));
    hash.update("\0");
    hash.update(stableJson(tool.promptGuidelines));
  }
  return hash.digest("hex");
}

function assistantHasProviderUsage(message: ContextMessageLike): boolean {
  if (message.role !== "assistant" || message.stopReason === "aborted" || message.stopReason === "error") {
    return false;
  }
  if (!message.usage || typeof message.usage !== "object") return false;
  const usage = message.usage as Record<string, unknown>;
  const fields = ["totalTokens", "input", "output", "cacheRead", "cacheWrite"];
  return fields.reduce(
    (total, field) => total + (typeof usage[field] === "number" ? usage[field] as number : 0),
    0,
  ) > 0;
}

function emptySnapshot(): ContextSnapshot {
  return buildContextSnapshot({
    systemPrompt: "",
    messages: [],
    tools: [],
    contextWindow: 0,
  });
}

function restoreEnabled(ctx: ExtensionContext): boolean {
  for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
    if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
    const data = entry.data as { enabled?: unknown } | undefined;
    if (typeof data?.enabled === "boolean") return data.enabled;
  }
  return true;
}

export default function contextBar(pi: ExtensionAPI, dependencies: ContextBarDependencies = {}): void {
  const now = dependencies.now ?? Date.now;
  const isOffline = dependencies.isOffline ?? (() => ["1", "true", "yes"].includes(process.env.PI_OFFLINE?.toLowerCase() ?? ""));
  const codexUsageTimeoutMs = dependencies.codexUsageTimeoutMs ?? CODEX_USAGE_TIMEOUT_MS;
  const codexUsageAuthPollMs = dependencies.codexUsageAuthPollMs ?? CODEX_USAGE_AUTH_POLL_MS;
  const log = createPithosLogger();
  log.info("extension.register");
  let enabled = true;
  let snapshot = emptySnapshot();
  let messages: ContextMessageLike[] = [];
  let systemPrompt = "";
  let systemPromptOptions: BuildSystemPromptOptions | undefined;
  let providerRequestFingerprint: string | undefined;
  let widgetInstalled = false;
  let requestWidgetRender: (() => void) | undefined;
  let previousEditorFactory: EditorFactory | undefined;
  let editorFactory: EditorFactory | undefined;
  let activeEditor: ReturnType<EditorFactory> | undefined;
  let codexUsage: CodexUsage | undefined;
  let codexUsageAccountId: string | undefined;
  let codexUsageStale = false;
  let codexUsageError: string | undefined;
  let codexUsageRefresh: Promise<void> | undefined;
  let codexUsageAbort: AbortController | undefined;
  let codexUsageForceRequested = false;
  let codexUsageNetworkStarted = false;
  let codexUsageAuthPoll: ReturnType<typeof setInterval> | undefined;
  let argumentAutocompleteInstalled = false;
  let lastCodexUsageAttemptAt = Number.NEGATIVE_INFINITY;

  function safeCodexUsageError(error: unknown): string {
    return error instanceof CodexUsageError ? error.message : "Codex usage refresh failed";
  }

  function clearCodexUsageStatus(ctx: ExtensionContext): void {
    if (ctx.hasUI) ctx.ui.setStatus(CODEX_USAGE_STATUS_KEY, undefined);
  }

  function resetCodexUsage(
    ctx: ExtensionContext,
    accountId?: string,
    resetAttempt = true,
  ): void {
    codexUsage = undefined;
    codexUsageAccountId = accountId;
    codexUsageStale = false;
    codexUsageError = undefined;
    if (resetAttempt) lastCodexUsageAttemptAt = Number.NEGATIVE_INFINITY;
    clearCodexUsageStatus(ctx);
  }

  function isActiveCodexOAuth(ctx: ExtensionContext): boolean {
    return ctx.model?.provider === "openai-codex" && ctx.modelRegistry.isUsingOAuth(ctx.model);
  }

  function isCodexUsageEligible(ctx: ExtensionContext): boolean {
    return ctx.mode === "tui" && enabled && !isOffline() && isActiveCodexOAuth(ctx);
  }

  function stopCodexUsageAuthPoll(): void {
    if (codexUsageAuthPoll) clearInterval(codexUsageAuthPoll);
    codexUsageAuthPoll = undefined;
  }

  function startCodexUsageAuthPoll(ctx: ExtensionContext): void {
    stopCodexUsageAuthPoll();
    if (ctx.mode !== "tui") return;
    codexUsageAuthPoll = setInterval(() => {
      void refreshCodexUsage(ctx).catch(() => {});
    }, codexUsageAuthPollMs);
    codexUsageAuthPoll.unref?.();
  }

  function invalidateCodexUsage(ctx: ExtensionContext): void {
    codexUsageAbort?.abort();
    codexUsageAbort = undefined;
    codexUsageRefresh = undefined;
    codexUsageForceRequested = false;
    codexUsageNetworkStarted = false;
    resetCodexUsage(ctx);
  }

  async function refreshCodexUsage(ctx: ExtensionContext, force = false): Promise<void> {
    const started = now();
    if (!isCodexUsageEligible(ctx)) {
      invalidateCodexUsage(ctx);
      return;
    }
    if (codexUsageRefresh) {
      if (!force || codexUsageNetworkStarted) return codexUsageRefresh;
      codexUsageForceRequested = true;
      const joinedRefresh = codexUsageRefresh;
      await joinedRefresh;
      if (codexUsageForceRequested) {
        codexUsageForceRequested = false;
        return refreshCodexUsage(ctx, true);
      }
      if (codexUsageRefresh && codexUsageRefresh !== joinedRefresh) return codexUsageRefresh;
      return;
    }

    const controller = new AbortController();
    codexUsageAbort?.abort();
    codexUsageAbort = controller;
    codexUsageNetworkStarted = false;
    let failureAccountRevalidated = false;
    const timeout = setTimeout(
      () => controller.abort(new CodexUsageError(`Codex usage request timed out after ${codexUsageTimeoutMs}ms`)),
      codexUsageTimeoutMs,
    );
    timeout.unref?.();
    const refresh = (async () => {
      try {
        const getProviderAuth = () => ctx.modelRegistry.getProviderAuth("openai-codex");
        let resolvedAuth = await resolveCodexUsageAuth({
          getProviderAuth,
          signal: controller.signal,
          timeoutMs: codexUsageTimeoutMs,
        });
        if (controller.signal.aborted) {
          if (controller.signal.reason instanceof CodexUsageError) throw controller.signal.reason;
          return;
        }
        if (!isCodexUsageEligible(ctx)) {
          invalidateCodexUsage(ctx);
          return;
        }
        if (codexUsageAccountId !== resolvedAuth.accountId) {
          resetCodexUsage(ctx, resolvedAuth.accountId);
        }
        const effectiveForce = force || codexUsageForceRequested;
        codexUsageForceRequested = false;
        if (!effectiveForce && now() - lastCodexUsageAttemptAt < CODEX_USAGE_REFRESH_INTERVAL_MS) {
          if (codexUsage) ctx.ui.setStatus(CODEX_USAGE_STATUS_KEY, formatCodexUsageFooter(codexUsage, codexUsageStale));
          return;
        }
        while (true) {
          lastCodexUsageAttemptAt = now();
          codexUsageNetworkStarted = true;
          let nextUsage: CodexUsage;
          try {
            nextUsage = await fetchCodexUsage({
              getProviderAuth,
              resolvedAuth,
              ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
              signal: controller.signal,
              timeoutMs: codexUsageTimeoutMs,
              now,
            });
          } catch (error) {
            if (controller.signal.aborted) throw error;
            const currentAuth = await resolveCodexUsageAuth({
              getProviderAuth,
              signal: controller.signal,
              timeoutMs: codexUsageTimeoutMs,
            });
            if (!isCodexUsageEligible(ctx)) {
              invalidateCodexUsage(ctx);
              return;
            }
            if (currentAuth.accountId !== resolvedAuth.accountId) {
              resolvedAuth = currentAuth;
              resetCodexUsage(ctx, currentAuth.accountId);
              continue;
            }
            failureAccountRevalidated = true;
            throw error;
          }
          if (controller.signal.aborted) {
            if (controller.signal.reason instanceof CodexUsageError) throw controller.signal.reason;
            return;
          }
          if (!isCodexUsageEligible(ctx)) {
            invalidateCodexUsage(ctx);
            return;
          }
          const currentAuth = await resolveCodexUsageAuth({
            getProviderAuth,
            signal: controller.signal,
            timeoutMs: codexUsageTimeoutMs,
          });
          if (controller.signal.aborted) {
            if (controller.signal.reason instanceof CodexUsageError) throw controller.signal.reason;
            return;
          }
          if (!isCodexUsageEligible(ctx)) {
            invalidateCodexUsage(ctx);
            return;
          }
          if (currentAuth.accountId !== resolvedAuth.accountId) {
            resolvedAuth = currentAuth;
            resetCodexUsage(ctx, currentAuth.accountId);
            continue;
          }
          codexUsage = nextUsage;
          log.info("codex_usage.refresh.complete", { sessionId: (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.(), durationMs: now() - started, force: effectiveForce, plan: nextUsage.plan, primary: nextUsage.primary, secondary: nextUsage.secondary });
          codexUsageStale = false;
          codexUsageError = undefined;
          ctx.ui.setStatus(CODEX_USAGE_STATUS_KEY, formatCodexUsageFooter(codexUsage));
          return;
        }
      } catch (error) {
        if (controller.signal.aborted && !(controller.signal.reason instanceof CodexUsageError)) return;
        const timedOut = controller.signal.reason instanceof CodexUsageError;
        const reportableError = timedOut ? controller.signal.reason : error;
        const message = safeCodexUsageError(reportableError);
        log.warn("codex_usage.refresh.error", { sessionId: (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.(), durationMs: now() - started, force, error: errorMetadata(reportableError) });
        codexUsageForceRequested = false;
        if (reportableError instanceof CodexUsageAuthError) {
          resetCodexUsage(ctx);
          codexUsageError = message;
          return;
        }
        if (timedOut || !failureAccountRevalidated) {
          resetCodexUsage(ctx, codexUsageAccountId, false);
          codexUsageError = message;
          ctx.ui.setStatus(CODEX_USAGE_STATUS_KEY, "Codex · usage unavailable");
          return;
        }
        codexUsageError = message;
        codexUsageStale = codexUsage !== undefined;
        if (codexUsage) {
          ctx.ui.setStatus(CODEX_USAGE_STATUS_KEY, formatCodexUsageFooter(codexUsage, true));
        } else {
          ctx.ui.setStatus(CODEX_USAGE_STATUS_KEY, "Codex · usage unavailable");
        }
      }
    })().finally(() => {
      clearTimeout(timeout);
      if (codexUsageRefresh === refresh) {
        codexUsageRefresh = undefined;
        codexUsageNetworkStarted = false;
      }
      if (codexUsageAbort === controller) codexUsageAbort = undefined;
    });
    codexUsageRefresh = refresh;
    return refresh;
  }

  function activeTools() {
    const activeNames = new Set(pi.getActiveTools());
    return pi.getAllTools().filter((tool) => activeNames.has(tool.name));
  }

  function loadSessionMessages(ctx: ExtensionContext): ContextMessageLike[] {
    return ctx.sessionManager.buildContextEntries()
      .flatMap(sessionEntryToContextMessages) as ContextMessageLike[];
  }

  function computeSnapshot(ctx: ExtensionContext): void {
    const usage = ctx.getContextUsage();
    const tools = activeTools();
    snapshot = buildContextSnapshot({
      systemPrompt,
      systemPromptOptions,
      messages,
      tools,
      contextWindow: ctx.model?.contextWindow ?? usage?.contextWindow ?? 0,
      cwd: ctx.cwd,
      aggregateTokens: usage?.tokens,
      aggregateMatchesRequest: providerRequestFingerprint === requestFingerprint(systemPrompt, tools),
      model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
    });
    log.info("context.snapshot", { sessionId: (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.(), totalTokens: snapshot.tokens, contextWindow: snapshot.contextWindow, percent: snapshot.percent, basis: snapshot.basis, messageCount: messages.length, toolCount: tools.length });
  }

  function installArgumentAutocomplete(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui" || argumentAutocompleteInstalled) return;
    const invocationPrefixes = pi.getCommands()
      .filter(({ name, sourceInfo }) => {
        if (!/^context-bar(?::\d+)?$/u.test(name)) return false;
        const sourcePath = resolve(ctx.cwd, sourceInfo.path);
        const packageRelativePath = relative(CONTEXT_BAR_PACKAGE_ROOT, sourcePath);
        return packageRelativePath !== ".."
          && !packageRelativePath.startsWith(`..${sep}`)
          && !isAbsolute(packageRelativePath);
      })
      .map(({ name }) => `/${name}`);
    if (invocationPrefixes.length === 0) return;
    argumentAutocompleteInstalled = true;

    function argumentTextBeforeCursor(beforeCursor: string): string | undefined {
      const invocation = invocationPrefixes.find((prefix) =>
        beforeCursor.startsWith(`${prefix} `) || beforeCursor.startsWith(`${prefix}\t`)
      );
      return invocation ? beforeCursor.slice(invocation.length + 1) : undefined;
    }

    ctx.ui.addAutocompleteProvider((current) => ({
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const line = lines[cursorLine] ?? "";
        const beforeCursor = line.slice(0, cursorCol);
        const argumentText = argumentTextBeforeCursor(beforeCursor);
        if (argumentText === undefined) {
          return current.getSuggestions(lines, cursorLine, cursorCol, options);
        }
        if (/\s/u.test(argumentText)) return null;
        const items = contextBarArgumentCompletions(argumentText);
        return items ? { prefix: argumentText, items } : null;
      },
      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      },
      shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
        const line = lines[cursorLine] ?? "";
        const beforeCursor = line.slice(0, cursorCol);
        if (argumentTextBeforeCursor(beforeCursor) !== undefined) return true;
        return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
      },
    }));
  }

  function installEditorIntegration(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui" || editorFactory) return;
    previousEditorFactory = ctx.ui.getEditorComponent();
    const previous = previousEditorFactory;
    editorFactory = (tui, theme, keybindings) => {
      activeEditor = withoutTopEditorBorder(
        previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings),
      );
      return activeEditor;
    };
    ctx.ui.setEditorComponent(editorFactory);
  }

  function restoreEditor(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui" || !editorFactory) return;
    if (ctx.ui.getEditorComponent() === editorFactory) {
      ctx.ui.setEditorComponent(previousEditorFactory);
    }
    editorFactory = undefined;
    previousEditorFactory = undefined;
    activeEditor = undefined;
  }

  function clearWidget(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    if (widgetInstalled) {
      widgetInstalled = false;
      requestWidgetRender = undefined;
      ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "aboveEditor" });
    }
    restoreEditor(ctx);
  }

  function refresh(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    if (!enabled) {
      clearWidget(ctx);
      return;
    }
    computeSnapshot(ctx);
    installEditorIntegration(ctx);
    if (widgetInstalled) {
      requestWidgetRender?.();
      return;
    }

    widgetInstalled = true;
    ctx.ui.setWidget(
      WIDGET_KEY,
      (tui, theme) => {
        const render = () => tui.requestRender();
        requestWidgetRender = render;
        const component = createContextBarComponent(
          () => snapshot,
          theme,
          () => activeEditor?.borderColor,
        );
        return {
          ...component,
          dispose: () => {
            if (requestWidgetRender === render) {
              requestWidgetRender = undefined;
              widgetInstalled = false;
            }
          },
        };
      },
      { placement: "aboveEditor" },
    );
  }

  pi.on("session_start", (event, ctx) => {
    log.info("session.start", { reason: event.reason, sessionId: (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.() });
    enabled = restoreEnabled(ctx);
    providerRequestFingerprint = undefined;
    if (enabled) {
      systemPrompt = ctx.getSystemPrompt();
      systemPromptOptions = undefined;
      messages = loadSessionMessages(ctx);
    } else {
      systemPrompt = "";
      systemPromptOptions = undefined;
      messages = [];
    }
    installArgumentAutocomplete(ctx);
    refresh(ctx);
    startCodexUsageAuthPoll(ctx);
    void refreshCodexUsage(ctx);
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (!enabled) return;
    systemPrompt = event.systemPrompt;
    systemPromptOptions = event.systemPromptOptions;
    refresh(ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!enabled) return;
    systemPrompt = ctx.getSystemPrompt();
    refresh(ctx);
  });

  pi.on("context", (event, ctx) => {
    if (!enabled) return;
    messages = event.messages as ContextMessageLike[];
    refresh(ctx);
  });

  pi.on("message_end", (event, ctx) => {
    if (!enabled) return;
    const message = event.message as ContextMessageLike;
    messages = [...messages, message];
    if (assistantHasProviderUsage(message)) {
      providerRequestFingerprint = requestFingerprint(systemPrompt, activeTools());
    }
    refresh(ctx);
  });

  pi.on("agent_settled", (_event, ctx) => {
    refresh(ctx);
    void refreshCodexUsage(ctx);
  });
  pi.on("model_select", (_event, ctx) => {
    refresh(ctx);
    void refreshCodexUsage(ctx);
  });

  pi.on("session_compact", (_event, ctx) => {
    providerRequestFingerprint = undefined;
    if (!enabled) return;
    messages = loadSessionMessages(ctx);
    refresh(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    if (!enabled) return;
    messages = loadSessionMessages(ctx);
    refresh(ctx);
  });

  pi.on("session_shutdown", (event, ctx) => {
    log.info("session.shutdown", { reason: event.reason, sessionId: (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.() });
    stopCodexUsageAuthPoll();
    messages = [];
    systemPrompt = "";
    systemPromptOptions = undefined;
    providerRequestFingerprint = undefined;
    snapshot = emptySnapshot();
    codexUsageAbort?.abort();
    codexUsageAbort = undefined;
    codexUsageRefresh = undefined;
    codexUsageForceRequested = false;
    codexUsageNetworkStarted = false;
    resetCodexUsage(ctx);
    clearWidget(ctx);
  });

  function clearAccountingInputs(): void {
    messages = [];
    systemPrompt = "";
    systemPromptOptions = undefined;
  }

  function loadCommandInputs(ctx: ExtensionCommandContext): void {
    systemPrompt = ctx.getSystemPrompt();
    systemPromptOptions = ctx.getSystemPromptOptions();
    messages = loadSessionMessages(ctx);
  }

  function setEnabled(nextEnabled: boolean, ctx: ExtensionContext): void {
    if (enabled === nextEnabled) {
      if (ctx.hasUI) ctx.ui.notify(`context-bar is already ${enabled ? "on" : "off"}`, "info");
      return;
    }
    enabled = nextEnabled;
    pi.appendEntry(STATE_ENTRY_TYPE, { enabled });
    refresh(ctx);
    if (!enabled) {
      codexUsageAbort?.abort();
      codexUsageAbort = undefined;
      codexUsageRefresh = undefined;
      codexUsageForceRequested = false;
      codexUsageNetworkStarted = false;
      resetCodexUsage(ctx);
      clearAccountingInputs();
    }
    if (ctx.hasUI) ctx.ui.notify(`context-bar ${enabled ? "enabled" : "disabled"}`, "info");
  }

  pi.registerCommand("context-bar", {
    description: "Toggle or inspect context-window composition and Codex usage",
    getArgumentCompletions: (prefix) => {
      if (/\s/u.test(prefix)) return null;
      return contextBarArgumentCompletions(prefix);
    },
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      log.info("command.context-bar", { sessionId: (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.(), action: action || "toggle" });
      if (action === "--help" || action === "-h") {
        emitHelp(ctx);
      } else if (!action) {
        const nextEnabled = !enabled;
        if (nextEnabled) loadCommandInputs(ctx);
        setEnabled(nextEnabled, ctx);
        if (nextEnabled) await refreshCodexUsage(ctx, true);
      } else if (action === "on") {
        const wasEnabled = enabled;
        if (!enabled) loadCommandInputs(ctx);
        setEnabled(true, ctx);
        if (!wasEnabled) await refreshCodexUsage(ctx, true);
      } else if (action === "off") setEnabled(false, ctx);
      else if (action === "refresh") {
        if (!enabled) {
          invalidateCodexUsage(ctx);
          if (ctx.hasUI) ctx.ui.notify("Enable Context Bar before refreshing Codex usage", "warning");
          return;
        }
        if (isOffline()) {
          invalidateCodexUsage(ctx);
          if (ctx.hasUI) ctx.ui.notify("Codex usage refresh is unavailable while PI_OFFLINE is enabled", "warning");
          return;
        }
        if (!isActiveCodexOAuth(ctx)) {
          invalidateCodexUsage(ctx);
          if (ctx.hasUI) ctx.ui.notify("Codex usage refresh requires an active OAuth-authenticated Codex model", "warning");
          return;
        }
        await refreshCodexUsage(ctx, true);
        if (ctx.hasUI) {
          ctx.ui.notify(
            codexUsageError ?? (codexUsage ? "Codex usage refreshed" : "Codex usage is unavailable"),
            codexUsageError ? "warning" : "info",
          );
        }
      } else if (action === "status") {
        loadCommandInputs(ctx);
        computeSnapshot(ctx);
        if (!isCodexUsageEligible(ctx)) invalidateCodexUsage(ctx);
        if (ctx.hasUI) {
          const contextStatus = formatContextStatus(snapshot, enabled, ctx.ui.theme, activeEditor?.borderColor);
          const codexStatus = codexUsage
            ? `${formatCodexUsageDetails(codexUsage, now(), codexUsageStale)}${codexUsageError ? `\nLast refresh failed: ${codexUsageError}` : ""}`
            : codexUsageError
              ? `Codex usage unavailable · ${codexUsageError}`
              : undefined;
          ctx.ui.notify(
            codexStatus ? `${contextStatus}\n\n${codexStatus}` : contextStatus,
            "info",
          );
        }
        if (!enabled) clearAccountingInputs();
      } else if (ctx.hasUI) {
        ctx.ui.notify("Usage: /context-bar [on|off|status|refresh]", "warning");
      }
    },
  });
}
