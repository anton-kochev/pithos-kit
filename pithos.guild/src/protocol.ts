import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Check } from "typebox/value";
import { GUILD_MEMBER_ALIASES, isGuildMemberAlias, GUILD_ROLE_DEFINITIONS, isGuildProfile, isGuildRole, createGuildTarget, type GuildRole, type GuildProfile } from "./agents.ts";

export const BACKGROUND_CAPABILITY = "guild-background/1";
export const ASK_TOOL = "guild_ask_parent";
export type BackgroundCapability = typeof BACKGROUND_CAPABILITY;
export interface BackgroundOptions { capability: BackgroundCapability }
export function backgroundCapability(options?: BackgroundOptions): BackgroundCapability | undefined {
 if (options === undefined) return undefined;
 exactKeys(options, ["capability"]);
 if (options.capability !== BACKGROUND_CAPABILITY) throw new Error("Unsupported Guild capability");
 return BACKGROUND_CAPABILITY;
}
export const SUBMIT_TOOL = "guild_submit_result";
export const PROTOCOL = "guild/2";
export const LIMITS = Object.freeze({ task: 32 * 1024, input: 40 * 1024, envelope: 48 * 1024, result: 48 * 1024, string: 2048, list: 32, id: 128, line: 1024 * 1024, stdout: 16 * 1024 * 1024, stderr: 64 * 1024 });
export interface GuildPractice { id: "tdd"; policy: "required" }
export interface GuildInput { role: GuildRole; profile: GuildProfile; task: string; practices: GuildPractice[] }
function exactKeys(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
 if (!value || typeof value !== "object" || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new Error("Invalid Guild object keys");
}
export function validateInput(value: unknown): GuildInput {
 if (value && typeof value === "object" && Object.hasOwn(value, "member")) {
  exactKeys(value, ["member", "task"]);
  if (!isGuildMemberAlias(value.member)) throw new Error("Invalid Guild member");
  const [role, profile] = GUILD_MEMBER_ALIASES[value.member].split("/");
  value = {role, profile, task: value.task};
 }
 exactKeys(value, ["role", "profile", "task"], ["practices"]);
 if (!isGuildRole(value.role) || !isGuildProfile(value.profile) || typeof value.task !== "string") throw new Error("Invalid Guild input");
 createGuildTarget(value.role, value.profile);
 const practices = Object.hasOwn(value, "practices") ? value.practices : [];
 if (!Array.isArray(practices) || practices.length > 1 || (practices.length && value.role !== "coder")) throw new Error("Invalid Guild practices");
 for (const practice of practices) {
  exactKeys(practice, ["id", "policy"]);
  if (practice.id !== "tdd" || practice.policy !== "required") throw new Error("Invalid Guild practice");
 }
 if (!value.task.trim() || value.task.includes("\0") || Buffer.byteLength(value.task) > LIMITS.task) throw new Error("Invalid Guild task or task byte limit exceeded");
 const input: GuildInput = {role: value.role, profile: value.profile, task: value.task, practices: practices.map(() => ({id: "tdd", policy: "required"}))};
 if (Buffer.byteLength(JSON.stringify(input)) > LIMITS.input) throw new Error("Guild input byte limit exceeded");
 return input;
}
export interface GuildTask extends GuildInput {
 protocol: typeof PROTOCOL;
 version: 2;
 runId: string;
 taskId: string;
}
export function buildTask(input: Omit<GuildInput, "practices"> & { practices?: GuildPractice[]; runId: string; taskId: string }): GuildTask {
 exactKeys(input, ["role", "profile", "task", "runId", "taskId"], ["practices"]);
 const {runId, taskId, ...publicInput} = input;
 const canonical = validateInput(publicInput);
 if ([runId, taskId].some(id => typeof id !== "string" || !id.trim() || Buffer.byteLength(id) > LIMITS.id)) throw new Error("Invalid Guild run/task identity");
 const task: GuildTask = {protocol: PROTOCOL, version: 2, runId, taskId, ...canonical};
 if (Buffer.byteLength(JSON.stringify(task)) > LIMITS.envelope) throw new Error("Guild envelope byte limit exceeded");
 return task;
}
export function validateTask(value: unknown): GuildTask {
 exactKeys(value, ["protocol", "version", "runId", "taskId", "role", "profile", "task", "practices"]);
 if (value.protocol !== PROTOCOL || value.version !== 2) throw new Error("Invalid host Guild envelope version");
 const {protocol: _protocol, version: _version, ...input} = value;
 return buildTask(input as Parameters<typeof buildTask>[0]);
}
const text = Type.String({ maxLength: LIMITS.string });
const list = <T extends ReturnType<typeof Type.String> | ReturnType<typeof Type.Object>>(item: T) => Type.Array(item, { maxItems: LIMITS.list });
const object = Type.Object;
const exact = { additionalProperties: false };
const observation = object({command: text, outcome: StringEnum(["expected-failure", "passed"] as const), exitCode: Type.Integer({minimum: 0, maximum: 255}), observed: text, evidence: Type.Array(text, {minItems: 1, maxItems: 4})}, exact);
const tddCycle = object({behavior: text, test: text, red: observation, green: observation}, exact);
const tddCompliance = object({id: StringEnum(["tdd"] as const), policy: StringEnum(["required"] as const), status: StringEnum(["satisfied", "blocked"] as const), reason: text, cycles: Type.Array(tddCycle, {maxItems: 8}), limitations: list(text)}, exact);
export type TddObservation = Static<typeof observation>;
export type TddCycle = Static<typeof tddCycle>;
export type TddCompliance = Static<typeof tddCompliance>;
const payloads = {
 explorer: object({ observations: list(object({ reference: text, observation: text }, exact)), unknowns: list(text) }, exact),
 architect: object({ decisions: list(text), contracts: list(text), handoff: list(text) }, exact),
 coder: object({ changes: list(object({ path: text, change: text }, exact)), verification: list(object({ command: text, outcome: text }, exact)) }, exact),
 reviewer: object({ scope: list(text), findings: list(object({ severity: Type.String({ enum: ["Critical", "High", "Medium", "Low"] }), reference: text, finding: text }, exact)), verdict: Type.String({ enum: ["Request changes", "Comment", "Approve"] }) }, exact),
 writer: object({ artifacts: list(object({ path: text, description: text }, exact)), sources: list(object({ reference: text, usage: text }, exact)), checks: list(object({ check: text, outcome: text }, exact)) }, exact),
};
export function resultSchema(task: GuildTask) {
 return object({
  protocol: StringEnum([PROTOCOL] as const), version: Type.Integer({minimum: 2, maximum: 2}),
  runId: Type.String({ enum: [task.runId] }), taskId: Type.String({ enum: [task.taskId] }),
  role: Type.String({ enum: [task.role] }), profile: Type.String({ enum: [task.profile] }),
  taskOutcome: StringEnum(["succeeded", "blocked"] as const), compliance: Type.Array(tddCompliance, {minItems: task.practices.length, maxItems: task.practices.length}),
  summary: text, blockers: list(text), limitations: list(text), payload: payloads[task.role],
 }, exact);
}
export type GuildReport = Omit<Static<ReturnType<typeof resultSchema>>, "version"> & {version: GuildTask["version"]};
export function validateResult(value: unknown, task: GuildTask): GuildReport {
 if (!Check(resultSchema(task), value)) throw new Error("Invalid Guild result schema or identity");
 if (Buffer.byteLength(JSON.stringify(value)) > LIMITS.result) throw new Error("Guild result byte limit exceeded");
 const checkBytes = (part: unknown): void => {
  if (typeof part === "string" && Buffer.byteLength(part) > LIMITS.string) throw new Error("Guild string byte limit exceeded");
  if (part && typeof part === "object") for (const child of Object.values(part)) checkBytes(child);
 };
 checkBytes(value);
 const report = value as GuildReport;
 if (task.role === "writer") {
  const payload = report.payload as Static<typeof payloads.writer>;
  if ((report.taskOutcome === "succeeded" && !payload.artifacts.length)
   || [...payload.artifacts, ...payload.sources, ...payload.checks].some(record => Object.values(record).some(value => !value.trim() || value.includes("\0")))) {
   throw new Error("Invalid writer artifacts, sources or checks");
  }
 }
 if (report.blockers.some(blocker => !blocker.trim()) || (report.taskOutcome === "blocked" ? !report.blockers.length : report.blockers.length > 0 || report.compliance.some(claim => claim.status !== "satisfied"))) throw new Error("Inconsistent Guild task outcome and blockers/compliance");
 for (const claim of report.compliance) {
  if (claim.status === "blocked" && !claim.reason.trim()) throw new Error("Blocked TDD requires a reason");
  if (claim.status === "satisfied" && (claim.reason !== "" || !claim.cycles.length)) throw new Error("Satisfied TDD requires completed cycles and empty reason");
  for (const cycle of claim.cycles) {
   if (![cycle.behavior, cycle.test, cycle.red.command, cycle.red.observed, cycle.green.command, cycle.green.observed, ...cycle.red.evidence, ...cycle.green.evidence].every(value => value.trim())) throw new Error("TDD cycle strings must be nonblank");
   if (cycle.red.outcome !== "expected-failure" || cycle.red.exitCode === 0 || cycle.green.outcome !== "passed" || cycle.green.exitCode !== 0 || cycle.red.command !== cycle.green.command) throw new Error("TDD requires same-command expected red failure and passing green");
  }
 }
 return report;
}
export function hasIdentityMismatch(args: unknown, task: GuildTask): boolean {
 return args !== null && typeof args === "object" && ["protocol", "version", "runId", "taskId", "role", "profile"].some(key => Object.hasOwn(args, key) && (args as Record<string, unknown>)[key] !== task[key as keyof GuildTask]);
}
export function childTools(role: GuildRole, capability?: BackgroundCapability): string[] {
 if (capability !== undefined && capability !== BACKGROUND_CAPABILITY) throw new Error("Unsupported Guild capability");
 if (capability && role !== "coder" && role !== "reviewer") throw new Error("Unsupported background Guild role");
 if (!isGuildRole(role)) throw new Error("Unsupported Guild role");
 return [...GUILD_ROLE_DEFINITIONS[role].tools, SUBMIT_TOOL, ...(capability ? [ASK_TOOL] : [])];
}
export function renderReport(report: GuildReport): string {
 return ["Guild report — child-reported claims (not host-verified)", report.summary,
  `\n## taskOutcome\n${report.taskOutcome}`, `\n## compliance\n${JSON.stringify(report.compliance)}`,
  ...Object.entries(report.payload).map(([key, value]) => `\n## ${key}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`),
  `\n## blockers\n${JSON.stringify(report.blockers)}`, `\n## limitations\n${JSON.stringify(report.limitations)}`].join("\n");
}

export const QUESTION_LIMITS = Object.freeze({text: 8192, count: 8, timeout: 5 * 60 * 1000});
export const questionSchema = Type.Object({question: Type.String({maxLength: QUESTION_LIMITS.text})}, {additionalProperties: false});
export function validateQuestion(value: unknown): {question: string} {
 exactKeys(value, ["question"]);
 return {question: validateQuestionText(value.question)};
}
export function validateQuestionText(value: unknown): string {
 if (typeof value !== "string" || !value.trim() || value.includes("\0") || Buffer.byteLength(value) > QUESTION_LIMITS.text) throw new Error("Invalid Guild question or answer text");
 return value;
}
export type QuestionOutcome = {outcome: "answered"; answer: string} | {outcome: "unavailable"; reason: "cancelled-or-timed-out"};
export function validateQuestionOutcome(value: unknown): QuestionOutcome {
 exactKeys(value, ["outcome"], ["answer", "reason"]);
 if (value.outcome === "answered") {
  exactKeys(value, ["outcome", "answer"]);
  return {outcome: "answered", answer: validateQuestionText(value.answer)};
 }
 exactKeys(value, ["outcome", "reason"]);
 if (value.outcome !== "unavailable" || value.reason !== "cancelled-or-timed-out") throw new Error("Invalid Guild question outcome");
 return {outcome: "unavailable", reason: "cancelled-or-timed-out"};
}

/** Each side owns an independent instance; UI wire IDs belong to the future RPC host. */
export class QuestionExchange {
 private readonly ids = new Set<string>();
 private pending?: {id: string; question: string; started: boolean};
 batch(calls: Array<{name: string; id: string; arguments: unknown}>): void {
  if (this.pending) throw new Error("Guild question still pending");
  if (!calls.some(call => call.name === ASK_TOOL)) return;
  if (calls.length !== 1) throw new Error("Guild question must be sole batch call");
  const call = calls[0];
  if (typeof call.id !== "string" || !call.id.trim() || call.id.includes("\0") || Buffer.byteLength(call.id) > LIMITS.id || this.ids.has(call.id)) throw new Error("Invalid or duplicate Guild question identity");
  if (this.ids.size >= QUESTION_LIMITS.count) throw new Error("Guild question limit exceeded");
  const {question} = validateQuestion(call.arguments);
  this.ids.add(call.id);
  this.pending = {id: call.id, question, started: false};
 }
 start(id: string, args: unknown): void {
  if (!this.pending || this.pending.id !== id || this.pending.started || validateQuestion(args).question !== this.pending.question) throw new Error("Uncorrelated or duplicate Guild question start");
  this.pending.started = true;
 }
 assertStarted(id: string, args: unknown): void {
  if (!this.pending?.started || this.pending.id !== id || validateQuestion(args).question !== this.pending.question) throw new Error("Uncorrelated Guild question execution");
 }
 end(id: string, isError: unknown, details: unknown): void {
  if (!this.pending?.started || this.pending.id !== id || isError !== false) throw new Error("Uncorrelated or failed Guild question end");
  validateQuestionOutcome(details);
  this.pending = undefined;
 }
 guard(event: {type: string; toolName?: string; toolCallId?: string}): void {
  if (event.type === "tool_execution_update" && event.toolName === ASK_TOOL && (!this.pending?.started || event.toolCallId !== this.pending.id)) throw new Error("Uncorrelated Guild question update");
  if (!this.pending) return;
  if (event.type === "agent_settled" || (event.type.startsWith("tool_execution_") && (event.toolName !== ASK_TOOL || event.toolCallId !== this.pending.id))) throw new Error("Unexpected event while Guild question pending");
 }
 get isPending(): boolean { return this.pending !== undefined; }
}
