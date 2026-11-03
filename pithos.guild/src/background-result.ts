import { types } from "node:util";
import type { Usage } from "@earendil-works/pi-ai";
import { validateTask, validateResult, type GuildTask, type GuildReport } from "./protocol.ts";
import type { GuildRoleRunResult, RunUsage } from "./runner.ts";

export interface BackgroundTerminalResult {
 status: "completed" | "failed" | "cancelled";
 runId: string;
 taskId: string;
 role: GuildTask["role"];
 profile: GuildTask["profile"];
 exitCode: number;
 usage: RunUsage;
 providerUsage?: Usage | null;
 report?: GuildReport;
 model?: string;
 diagnostic?: string;
 usageKnown?: boolean;
 usageFields?: Array<keyof RunUsage>;
}

const RESULT_BYTES = 64 * 1024;
const usageKeys = ["input", "output", "cacheRead", "cacheWrite", "cost", "contextTokens", "turns"] as const;

/**
 * Internal terminal DTO, not runtime wiring. The host envelope binds report identity
 * and requested practices; neither task text nor rendered/raw output is retained.
 * Completed is transport completion (a blocked report is still completed).
 * Failed/cancelled DTOs stay non-success: BackgroundRunRegistry respects these
 * statuses on fulfillment. Projection errors must reject the operation, never be
 * caught and replaced by a fulfilled success-shaped fallback. Settle after cleanup.
 */
export function projectBackgroundResult(result: GuildRoleRunResult, task: GuildTask): BackgroundTerminalResult {
 assertJson(task);
 task = validateTask(task);
 if (!result || typeof result !== "object" || types.isProxy(result)
  || ![Object.prototype, null].includes(Object.getPrototypeOf(result))) throw new Error("Expected plain background result");
 for (const key of Reflect.ownKeys(result)) {
  const descriptor = Object.getOwnPropertyDescriptor(result, key)!;
  if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor)) throw new Error("Expected background result data properties");
 }
 if (result.runId !== task.runId || result.taskId !== task.taskId || result.role !== task.role || result.profile !== task.profile) throw new Error("Invalid background result identity");
 if (!["completed", "failed", "cancelled"].includes(result.status ?? "")) throw new Error("Missing terminal status");
 if (result.status === "completed" && (result.report === undefined || result.exitCode !== 0)) throw new Error("Completed result requires a report and zero exit code");
 const dto: BackgroundTerminalResult = {
  status: result.status!, runId: task.runId, taskId: task.taskId, role: result.role, profile: result.profile,
  exitCode: result.exitCode, usage: result.usage,
  ...(result.providerUsage === undefined ? {} : {providerUsage: result.providerUsage}),
  ...(result.report === undefined ? {} : {report: result.report}),
  ...(result.model === undefined ? {} : {model: result.model}),
  ...(result.errorMessage === undefined ? {} : {diagnostic: boundDiagnostic(result.errorMessage)}),
  ...(result.usageKnown === undefined ? {} : {usageKnown: result.usageKnown}),
  ...(result.usageFields === undefined ? {} : {usageFields: result.usageFields}),
 };
 assertJson(dto);
 if (dto.providerUsage !== undefined && dto.providerUsage !== null) validateBackgroundProviderUsage(dto.providerUsage);
 if (!Number.isInteger(dto.exitCode) || !dto.usage || Object.keys(dto.usage).length !== usageKeys.length
  || usageKeys.some(key => typeof dto.usage[key] !== "number" || !Number.isFinite(dto.usage[key]))) throw new Error("Invalid background numeric usage or exit code");
 if (dto.model !== undefined && typeof dto.model !== "string"
  || dto.usageKnown !== undefined && typeof dto.usageKnown !== "boolean"
  || dto.usageFields !== undefined && (!Array.isArray(dto.usageFields) || dto.usageFields.length > usageKeys.length || new Set(dto.usageFields).size !== dto.usageFields.length || dto.usageFields.some(key => !usageKeys.includes(key)))) throw new Error("Invalid background metadata");
 if (dto.report !== undefined) validateResult(dto.report, task);
 const json = JSON.stringify(dto);
 if (Buffer.byteLength(json) > RESULT_BYTES) throw new Error("Background result byte limit exceeded");
 return JSON.parse(json) as BackgroundTerminalResult;
}

export function validateBackgroundProviderUsage(value: unknown): asserts value is Usage {
 assertJson(value);
 const tokens = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"];
 const optional = ["cacheWrite1h", "reasoning"];
 const costs = ["input", "output", "cacheRead", "cacheWrite", "total"];
 const count = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
 const usage = value as Usage;
 if (!usage || typeof usage !== "object" || Array.isArray(usage)
  || tokens.some(key => !count((usage as any)[key]))
  || Object.keys(usage).some(key => ![...tokens, ...optional, "cost"].includes(key))
  || optional.some(key => Object.hasOwn(usage, key) && !count((usage as any)[key]))
  || !usage.cost || typeof usage.cost !== "object" || Array.isArray(usage.cost)
  || Object.keys(usage.cost).length !== costs.length || costs.some(key => !count((usage.cost as any)[key]))) throw new Error("Invalid background provider usage");
}

function boundDiagnostic(text: string): string {
 if (typeof text !== "string") throw new Error("Invalid background diagnostic");
 let bounded = "", bytes = 0;
 for (const char of text) {
  bytes += Buffer.byteLength(char);
  if (bytes > 2048) break;
  bounded += char;
 }
 return bounded;
}

/** Reject lossy JSON coercions before either schema validation or serialization. */
function assertJson(value: unknown, ancestors = new Set<object>()): void {
 if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return;
 if (!value || typeof value !== "object" || types.isProxy(value) || ancestors.has(value)) throw new Error("Expected acyclic plain JSON");
 const array = Array.isArray(value);
 const prototype = Object.getPrototypeOf(value);
 if ((array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) || "toJSON" in value) throw new Error("Expected plain JSON");
 const keys = Reflect.ownKeys(value);
 if (array && keys.length !== value.length + 1) throw new Error("Expected dense JSON array");
 ancestors.add(value);
 for (const key of keys) {
  if (array && key === "length") continue;
  const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
  if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor)
   || array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) throw new Error("Expected JSON data property");
  assertJson(descriptor.value, ancestors);
 }
 ancestors.delete(value);
}
