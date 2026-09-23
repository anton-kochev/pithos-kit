import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { GUILD_ROLE_DEFINITIONS, isGuildProfile, isGuildRole, type GuildRole, type GuildProfile } from "./agents.ts";

export const SUBMIT_TOOL = "guild_submit_result";
export const PROTOCOL = "guild/2";
export const LIMITS = Object.freeze({ result: 48 * 1024, string: 2048, list: 32, id: 128, line: 1024 * 1024, stdout: 16 * 1024 * 1024, stderr: 64 * 1024 });
export interface GuildTask {
 protocol: typeof PROTOCOL;
 version: 1;
 runId: string;
 taskId: string;
 role: GuildRole;
 profile: GuildProfile;
 task: string;
}
export function buildTask(input: { role: GuildRole; profile: GuildProfile; task: string; runId: string; taskId: string }): GuildTask {
 if (!isGuildRole(input.role) || !isGuildProfile(input.profile) || (typeof input.task !== "string" || !input.task.trim())) throw new Error("Invalid Guild task");
 const {runId, taskId} = input;
 if ([runId, taskId].some(id => typeof id !== "string" || !id || Buffer.byteLength(id) > LIMITS.id)) throw new Error("Invalid Guild run/task identity");
 return { protocol: PROTOCOL, version: 1, runId, taskId, role: input.role, profile: input.profile, task: input.task };
}
const text = Type.String({ maxLength: LIMITS.string });
const list = <T extends ReturnType<typeof Type.String> | ReturnType<typeof Type.Object>>(item: T) => Type.Array(item, { maxItems: LIMITS.list });
const object = Type.Object;
const exact = { additionalProperties: false };
const payloads = {
 explorer: object({ observations: list(object({ reference: text, observation: text }, exact)), unknowns: list(text) }, exact),
 architect: object({ decisions: list(text), contracts: list(text), handoff: list(text) }, exact),
 coder: object({ changes: list(object({ path: text, change: text }, exact)), verification: list(object({ command: text, outcome: text }, exact)) }, exact),
 reviewer: object({ scope: list(text), findings: list(object({ severity: Type.String({ enum: ["Critical", "High", "Medium", "Low"] }), reference: text, finding: text }, exact)), verdict: Type.String({ enum: ["Request changes", "Comment", "Approve"] }) }, exact),
};
export function resultSchema(task: GuildTask) {
 return object({
  protocol: Type.String({ enum: [PROTOCOL] }), version: Type.Literal(1),
  runId: Type.String({ enum: [task.runId] }), taskId: Type.String({ enum: [task.taskId] }),
  role: Type.String({ enum: [task.role] }), profile: Type.String({ enum: [task.profile] }),
  summary: text, blockers: list(text), limitations: list(text), payload: payloads[task.role],
 }, exact);
}
export type GuildReport = Static<ReturnType<typeof resultSchema>>;
export function validateResult(value: unknown, task: GuildTask): GuildReport {
 if (!Check(resultSchema(task), value)) throw new Error("Invalid Guild result schema or identity");
 if (Buffer.byteLength(JSON.stringify(value)) > LIMITS.result) throw new Error("Guild result byte limit exceeded");
 const checkBytes = (part: unknown): void => {
  if (typeof part === "string" && Buffer.byteLength(part) > LIMITS.string) throw new Error("Guild string byte limit exceeded");
  if (part && typeof part === "object") for (const child of Object.values(part)) checkBytes(child);
 };
 checkBytes(value);
 return value as GuildReport;
}
export function childTools(role: GuildRole): string[] {
 return [...GUILD_ROLE_DEFINITIONS[role].tools, SUBMIT_TOOL];
}
export function renderReport(report: GuildReport): string {
 return ["Guild report — child-reported claims (not host-verified)", report.summary,
  ...Object.entries(report.payload).map(([key, value]) => `\n## ${key}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`),
  `\n## blockers\n${JSON.stringify(report.blockers)}`, `\n## limitations\n${JSON.stringify(report.limitations)}`].join("\n");
}
