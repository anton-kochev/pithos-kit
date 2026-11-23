const MAX_USAGE_RESPONSE_BYTES = 64 * 1024;
const CHATGPT_AUTH_CLAIM = "https://api.openai.com/auth";

export const CODEX_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";

export class CodexUsageError extends Error {
  override readonly name: string = "CodexUsageError";
}

export class CodexUsageAuthError extends CodexUsageError {
  override readonly name = "CodexUsageAuthError";
}

export interface CodexUsageWindow {
  usedPercent?: number;
  resetAt?: number;
}

interface ParsedCodexUsageWindow extends CodexUsageWindow {
  durationSeconds?: number;
}

export interface CodexUsage {
  plan?: string;
  fetchedAt: number;
  primary: CodexUsageWindow;
  secondary: CodexUsageWindow;
}

interface ProviderAuthLike {
  auth?: { apiKey?: string };
  source?: string;
}

export interface ResolvedCodexUsageAuth {
  readonly apiKey: string;
  readonly accountId: string;
}

interface CodexUsageBoundaryOptions {
  getProviderAuth(): Promise<ProviderAuthLike | undefined>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface FetchCodexUsageOptions extends CodexUsageBoundaryOptions {
  resolvedAuth?: ResolvedCodexUsageAuth;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseWindow(value: unknown, fetchedAt: number): ParsedCodexUsageWindow {
  const window = record(value);
  const usedPercent = finiteNumber(window?.used_percent);
  if (usedPercent === undefined || usedPercent < 0 || usedPercent > 100) {
    throw new CodexUsageError("Codex usage window has an invalid used percentage");
  }

  const resetAtSeconds = finiteNumber(window?.reset_at);
  const resetAfterSeconds = finiteNumber(window?.reset_after_seconds);
  const durationSeconds = finiteNumber(window?.limit_window_seconds);
  const resetAtCandidate = resetAtSeconds !== undefined && resetAtSeconds >= 0
    ? resetAtSeconds * 1000
    : resetAfterSeconds !== undefined && resetAfterSeconds >= 0
      ? fetchedAt + resetAfterSeconds * 1000
      : undefined;
  return {
    usedPercent,
    ...(resetAtCandidate !== undefined && Number.isFinite(resetAtCandidate)
      ? { resetAt: resetAtCandidate }
      : {}),
    ...(durationSeconds !== undefined && durationSeconds > 0
      ? { durationSeconds }
      : {}),
  };
}

function boundedJsonValue(value: unknown): unknown {
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_USAGE_RESPONSE_BYTES) {
      throw new CodexUsageError("Codex usage response is too large");
    }
    try {
      return JSON.parse(value);
    } catch {
      throw new CodexUsageError("Codex usage response is not valid JSON");
    }
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? "";
  } catch {
    throw new CodexUsageError("Codex usage response is not serializable");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_USAGE_RESPONSE_BYTES) {
    throw new CodexUsageError("Codex usage response is too large");
  }
  return value;
}

function hasWindow(limits: Record<string, unknown> | undefined): boolean {
  return record(limits?.primary_window) !== undefined
    || record(limits?.secondary_window) !== undefined;
}

function additionalLimitScore(limits: Record<string, unknown>): number {
  const windows = [record(limits.primary_window), record(limits.secondary_window)]
    .filter((window): window is Record<string, unknown> => window !== undefined);
  const positiveWindows = windows.filter((window) => {
    const used = finiteNumber(window.used_percent);
    return used !== undefined && used > 0 && used <= 100;
  }).length;
  return positiveWindows * 10 + windows.length;
}

function selectRateLimit(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const defaultLimit = record(payload.rate_limit);
  if (hasWindow(defaultLimit)) return defaultLimit;

  const additionalLimits = Array.isArray(payload.additional_rate_limits)
    ? payload.additional_rate_limits
      .map((entry) => record(record(entry)?.rate_limit))
      .filter((limits): limits is Record<string, unknown> => hasWindow(limits))
    : [];
  return additionalLimits.reduce<Record<string, unknown> | undefined>((selected, candidate) =>
    !selected || additionalLimitScore(candidate) > additionalLimitScore(selected)
      ? candidate
      : selected
  , undefined);
}

function publicWindow(window: ParsedCodexUsageWindow | undefined): CodexUsageWindow {
  if (!window) return {};
  return {
    usedPercent: window.usedPercent,
    ...(window.resetAt !== undefined ? { resetAt: window.resetAt } : {}),
  };
}

function classifyWindows(
  limits: Record<string, unknown>,
  fetchedAt: number,
): Pick<CodexUsage, "primary" | "secondary"> {
  const primary = record(limits.primary_window)
    ? parseWindow(limits.primary_window, fetchedAt)
    : undefined;
  const secondary = record(limits.secondary_window)
    ? parseWindow(limits.secondary_window, fetchedAt)
    : undefined;

  if (primary && secondary) {
    return { primary: publicWindow(primary), secondary: publicWindow(secondary) };
  }

  const onlyWindow = primary ?? secondary;
  if (!onlyWindow) throw new CodexUsageError("Codex usage response is missing usage windows");
  const isWeekly = onlyWindow.durationSeconds !== undefined
    ? onlyWindow.durationSeconds >= 24 * 60 * 60
    : secondary !== undefined;
  return isWeekly
    ? { primary: {}, secondary: publicWindow(onlyWindow) }
    : { primary: publicWindow(onlyWindow), secondary: {} };
}

export function parseCodexUsage(value: unknown, fetchedAt = Date.now()): CodexUsage {
  const payload = record(boundedJsonValue(value));
  const limits = payload ? selectRateLimit(payload) : undefined;
  if (!payload || !limits) {
    throw new CodexUsageError("Codex usage response is missing usage windows");
  }

  return {
    ...(typeof payload.plan_type === "string" && payload.plan_type.trim()
      ? { plan: payload.plan_type.trim().toLowerCase() }
      : {}),
    fetchedAt,
    ...classifyWindows(limits, fetchedAt),
  };
}

function roundedPercent(value: number | undefined): string {
  return value === undefined ? "n/a" : `${Math.round(value)}%`;
}

function formatWindowFooter(label: string, window: CodexUsageWindow, now: number): string {
  const summary = `${label} ${roundedPercent(window.usedPercent)}`;
  if (window.resetAt === undefined) return summary;
  if (window.resetAt <= now) return `${summary} (reset due)`;

  const hours = Math.floor((window.resetAt - now) / 3_600_000);
  const remaining = hours >= 24
    ? `${Math.floor(hours / 24)}d`
    : hours >= 1 ? `${hours}h` : "<1h";
  return `${summary} (resets in ${remaining})`;
}

export function formatCodexUsageFooter(usage: CodexUsage, stale = false, now = Date.now()): string {
  return [
    "Codex",
    ...(usage.primary.usedPercent !== undefined
      ? [formatWindowFooter("5h", usage.primary, now)]
      : []),
    ...(usage.secondary.usedPercent !== undefined
      ? [formatWindowFooter("week", usage.secondary, now)]
      : []),
    ...(stale ? ["stale"] : []),
  ].join(" · ");
}

function formatDuration(milliseconds: number): string {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor((minutes % (24 * 60)) / 60);
  const remainderMinutes = minutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return remainderMinutes > 0 ? `${hours}h ${remainderMinutes}m` : `${hours}h`;
  return `${minutes}m`;
}

function formatWindowDetails(label: string, window: CodexUsageWindow, now: number): string {
  const reset = window.resetAt === undefined ? "reset unavailable" : `resets in ${formatDuration(window.resetAt - now)}`;
  return `${label}: ${roundedPercent(window.usedPercent)} used · ${reset}`;
}

function displayPlan(plan: string | undefined): string {
  if (!plan) return "Unknown";
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

export function formatCodexUsageDetails(usage: CodexUsage, now = Date.now(), stale = false): string {
  return [
    `Codex usage · ${displayPlan(usage.plan)} plan${stale ? " · stale" : ""}`,
    ...(usage.primary.usedPercent !== undefined
      ? [formatWindowDetails("5h", usage.primary, now)]
      : []),
    ...(usage.secondary.usedPercent !== undefined
      ? [formatWindowDetails("week", usage.secondary, now)]
      : []),
    `Updated ${formatDuration(now - usage.fetchedAt)} ago`,
  ].join("\n");
}

function extractAccountId(token: string): string {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("invalid token");
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    const auth = record(payload[CHATGPT_AUTH_CLAIM]);
    const accountId = auth?.chatgpt_account_id;
    if (typeof accountId !== "string" || !accountId) throw new Error("missing account id");
    return accountId;
  } catch {
    throw new CodexUsageAuthError("Unable to extract the ChatGPT account id from Codex OAuth authentication");
  }
}

function parseCodexUsageAuth(auth: ProviderAuthLike | undefined): ResolvedCodexUsageAuth {
  const apiKey = auth?.auth?.apiKey;
  if (!apiKey || auth?.source?.toLowerCase() !== "oauth") {
    throw new CodexUsageAuthError("Sign in to openai-codex with ChatGPT (OAuth) to read the Codex account's usage.");
  }
  return { apiKey, accountId: extractAccountId(apiKey) };
}

export async function resolveCodexUsageAuth(
  options: CodexUsageBoundaryOptions,
): Promise<ResolvedCodexUsageAuth> {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abortFromParent, { once: true });
  if (options.signal?.aborted) abortFromParent();
  const timeoutMs = options.timeoutMs ?? 5_000;
  const timeout = setTimeout(
    () => controller.abort(new CodexUsageError(`Codex usage request timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  timeout.unref?.();
  let rejectForAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectForAbort = () => reject(
      controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new Error("Codex usage request was aborted"),
    );
    controller.signal.addEventListener("abort", rejectForAbort, { once: true });
    if (controller.signal.aborted) rejectForAbort();
  });

  try {
    return parseCodexUsageAuth(await Promise.race([options.getProviderAuth(), aborted]));
  } finally {
    clearTimeout(timeout);
    controller.signal.removeEventListener("abort", rejectForAbort);
    options.signal?.removeEventListener("abort", abortFromParent);
  }
}

async function readBoundedBody(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_USAGE_RESPONSE_BYTES) {
    try {
      await response.body?.cancel();
    } catch {
      // The bounded-size failure remains authoritative when cancellation fails.
    }
    throw new CodexUsageError("Codex usage response is too large");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_USAGE_RESPONSE_BYTES) {
        await reader.cancel();
        throw new CodexUsageError("Codex usage response is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export async function fetchCodexUsage(options: FetchCodexUsageOptions): Promise<CodexUsage> {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abortFromParent, { once: true });
  if (options.signal?.aborted) abortFromParent();
  const timeoutMs = options.timeoutMs ?? 5_000;
  const timeout = setTimeout(
    () => controller.abort(new CodexUsageError(`Codex usage request timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  timeout.unref?.();
  let rejectForAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectForAbort = () => reject(
      controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new Error("Codex usage request was aborted"),
    );
    controller.signal.addEventListener("abort", rejectForAbort, { once: true });
    if (controller.signal.aborted) rejectForAbort();
  });

  try {
    const { apiKey, accountId } = options.resolvedAuth
      ?? parseCodexUsageAuth(await Promise.race([options.getProviderAuth(), aborted]));
    const response = await Promise.race([
      (options.fetch ?? globalThis.fetch)(CODEX_USAGE_ENDPOINT, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${apiKey}`,
          "chatgpt-account-id": accountId,
        },
      }),
      aborted,
    ]);
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        // The sanitized HTTP failure remains authoritative when cancellation fails.
      }
      throw new CodexUsageError(`Codex usage request failed with HTTP ${response.status}`);
    }
    const body = await Promise.race([readBoundedBody(response), aborted]);
    return parseCodexUsage(body, (options.now ?? Date.now)());
  } finally {
    clearTimeout(timeout);
    controller.signal.removeEventListener("abort", rejectForAbort);
    options.signal?.removeEventListener("abort", abortFromParent);
  }
}
