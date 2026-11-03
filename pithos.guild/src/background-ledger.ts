import { createHash } from "node:crypto";
import { types, isDeepStrictEqual } from "node:util";
import type { Usage } from "@earendil-works/pi-ai";
import { projectBackgroundResult, type BackgroundTerminalResult } from "./background-result.ts";
import { buildTask } from "./protocol.ts";
import type { GuildRoleRunResult } from "./runner.ts";

export interface LedgerScope {
 sessionId: string;
 branchEntryIds: readonly string[];
 writable: boolean;
 /** Stable across leaf appends; replaced on every session/branch transition. */
 epoch: object;
}
export interface BackgroundJournal {
 scope(): LedgerScope;
 entries(): readonly unknown[];
 /**
  * Adapter synchronously calls appendEntry(customType, data) in the captured scope;
  * the resulting entry ID is read back. Throws/transition races cannot undo SDK
  * writes: the ledger instead faults and withholds usage. No asynchronous writes.
  */
 append(data: LedgerRecord): void;
}
export interface LedgerIdentity {
 sessionId: string; runId: string; taskId: string;
 role: BackgroundTerminalResult["role"]; profile: BackgroundTerminalResult["profile"];
}
interface BaseRecord extends LedgerIdentity { version: 1 }
export type LedgerRecord =
 | (BaseRecord & {kind: "admitted"})
 | (BaseRecord & {kind: "terminal"; originEntryId: string; report: BackgroundTerminalResult})
 | (BaseRecord & {kind: "collected"; originEntryId: string; collectionId: string; toolCallId: string; native: "claimed" | "unavailable"});
type Receipt = Extract<LedgerRecord, {kind: "collected"}>;
export type Reservation = Readonly<{ readonly reservation: unique symbol }>;
interface Observation { identity: LedgerIdentity; origin: string; report?: BackgroundTerminalResult; interrupted?: boolean; token?: Reservation; epoch?: object; receipt?: Receipt }
export interface LedgerObservation { identity: LedgerIdentity; report?: BackgroundTerminalResult; interrupted: boolean }
export interface CollectionRequest {sessionId: string; runId: string; taskId: string; collectionId: string; toolCallId: string; epoch: object}
export type CollectionResult = {kind: "rejected"} | {kind: "informational"; report?: BackgroundTerminalResult}
 | {kind: "first"; report: BackgroundTerminalResult; receipt: Receipt; nativeUsage?: Usage};
export type Reconciliation = "uncollected" | "unavailable" | "claimed-ambiguous" | "persisted-matching" | "persisted-conflict";
const CUSTOM = "pithos.guild.background.v1";

/**
 * Standalone observation store, never an execution owner. A recorded claim permits
 * at-most-once emission, NOT exactly-once delivery: appendEntry and a later native
 * tool result are not atomic. Ambiguous claims must never be retried.
 * Only the working cache is bounded; the injected SDK history array can grow.
 */
export class BackgroundLedger {
 private readonly cache = new Map<string, Observation>();
 private fault = false;
 private busy = false;
 private reentered = false;
 private scopeSnapshot?: LedgerScope;
 private sessionId?: string;

 private operation<T>(body: () => T): T {
  if (this.busy) { this.reentered = true; throw new Error("Reentrant ledger operation"); }
  this.busy = true; this.reentered = false;
  try { return body(); }
  catch (error) { if (!(error instanceof AdmissionRejection)) this.fault = true; throw error; }
  finally { this.busy = false; this.scopeSnapshot = undefined; }
 }
 private scope(): LedgerScope {
  const current = this.journal.scope();
  if (this.reentered) throw new Error("Reentrant journal callback");
  dataObject(current);
  plain(current.branchEntryIds);
  text(current.sessionId);
  if (!current.epoch || typeof current.epoch !== "object" || typeof current.writable !== "boolean"
   || !Array.isArray(current.branchEntryIds)) throw new Error("Invalid journal scope");
  for (const id of current.branchEntryIds) text(id);
  return {...current, branchEntryIds: [...current.branchEntryIds]};
 }
 private check(append = false): void {
  const current = this.scope();
  const prior = this.scopeSnapshot;
  if (prior && (current.sessionId !== prior.sessionId || current.epoch !== prior.epoch || current.writable !== prior.writable
   || (append ? current.branchEntryIds.length !== prior.branchEntryIds.length + 1
    || prior.branchEntryIds.some((id, i) => current.branchEntryIds[i] !== id)
    : !isDeepStrictEqual(current.branchEntryIds, prior.branchEntryIds)))) throw new Error("Journal scope changed");
  this.scopeSnapshot = current;
 }
 private entries(): TrustedHistory {
  this.check();
  const raw = this.journal.entries();
  const entries = historyView(raw);
  const before = historyDigest(entries);
  for (let index = 0; index < entries.length; index++) {
   const record = journalRecord(entries.at(index));
   if (!record) continue;
   for (let previous = 0; previous < index; previous++) {
    if (dataObject(entries.at(previous)).id === record.id) throw new Error("Duplicate ledger entry identity");
   }
  }
  // scope() can rewrite even nested claim evidence. Compare streaming digests
  // across that callback, retaining neither a history clone nor per-entry strings.
  this.check();
  const after = historyView(raw);
  if (after.length !== entries.length || historyDigest(after) !== before) throw new Error("Journal history changed");
  // No adapter callbacks occur between this validation and synchronous scans.
  return after;
 }
 private append(record: LedgerRecord): void {
  this.check();
  if (!this.scopeSnapshot!.writable) throw new Error("Journal is not writable");
  this.journal.append(structuredClone(record));
  this.check(true);
 }
 constructor(private readonly journal: BackgroundJournal) {}

 reserve(identity: LedgerIdentity): Reservation {
  return this.operation(() => {
   if (this.fault) throw new Error("Ledger fault");
   this.check();
   const scope = this.scopeSnapshot!;
   validateIdentity(identity);
   identity = identityOf(identity);
   if (identity.sessionId !== scope.sessionId || !scope.writable) throw new Error("Invalid scope");
   let history: TrustedHistory | undefined = this.entries();
   this.load(history, scope.sessionId);
   if (this.cache.size >= 16) throw new AdmissionRejection("UNCONSUMED observation capacity exceeded");
   if (this.lookup(history, identity.runId)) throw new Error("Duplicate run identity");
   history = undefined;
   // Admission is durable/read-back first, not memory-first. A failed append or
   // readback returns no token: never launch. A written receipt may reload as an
   // interrupted observation; the fault prevents further admissions here.
   this.append({...identity, version: 1, kind: "admitted"});
   const observed = this.lookup(this.entries(), identity.runId);
   if (!observed || !isDeepStrictEqual(observed.identity, identity) || observed.report || observed.receipt
    || this.scopeSnapshot!.branchEntryIds.at(-1) !== observed.origin) throw new Error("Admission readback mismatch");
   const token = Object.freeze({}) as Reservation;
   observed.token = token;
   observed.epoch = scope.epoch;
   this.cache.set(identity.runId, observed);
   return token;
  });
 }

 /** Admitted reservations cannot be abandoned: they require a terminal observation. */
 abandon(_token: Reservation): never { return this.operation(() => { throw new AdmissionRejection("Cannot abandon an admitted reservation"); }); }

 observeTerminal(token: Reservation, report: BackgroundTerminalResult): void {
  return this.operation(() => {
   const observed = [...this.cache.values()].find(value => value.token === token);
   if (!observed || observed.report) throw new Error("Invalid terminal reservation");
   const copy = copyReport(report, observed.identity);
   observed.report = copy;
   if (this.fault) throw new Error("Ledger fault");
   this.check();
   const scope = this.scopeSnapshot!;
   if (scope.sessionId !== observed.identity.sessionId || scope.epoch !== observed.epoch || !scope.branchEntryIds.includes(observed.origin)) throw new Error("Stale terminal scope");
   this.append({...observed.identity, version: 1, kind: "terminal", originEntryId: observed.origin, report: copy});
  });
 }

 /** Reports are visible only in the current admitted session/ancestor branch.
  * Reads remain available after a fault so retained terminal memory is recoverable.
  */
 inspect(runId: string): {report?: BackgroundTerminalResult; interrupted: boolean} | undefined {
  return this.operation(() => {
   this.check();
   const observed = this.cache.get(runId) ?? this.lookup(this.entries(), runId);
   this.check();
   const scope = this.scopeSnapshot!;
   if (!observed || scope.sessionId !== observed.identity.sessionId || !scope.branchEntryIds.includes(observed.origin)) return undefined;
   return observed ? { ...(observed.report ? {report: structuredClone(observed.report)} : {}), interrupted: !!observed.interrupted } : undefined;
  });
 }

 /** Bounded working observations only; collected history remains available via inspect.
  * Invisible branches still occupy cache capacity but never expose their reports.
  */
 list(): LedgerObservation[] {
  return this.operation(() => {
   this.check();
   const scope = this.scopeSnapshot!;
   const result: LedgerObservation[] = [];
   for (const observed of this.cache.values()) {
    if (scope.sessionId !== observed.identity.sessionId || !scope.branchEntryIds.includes(observed.origin)) continue;
    result.push({identity: structuredClone(observed.identity), interrupted: !!observed.interrupted,
     ...(observed.report ? {report: structuredClone(observed.report)} : {})});
   }
   this.check();
   return result;
  });
 }

 collect(request: CollectionRequest): CollectionResult {
  return this.operation(() => {
   if (this.fault) return {kind: "rejected"};
   this.check();
   const scope = this.scopeSnapshot!;
   dataObject(request);
   for (const key of ["runId", "taskId", "sessionId", "collectionId", "toolCallId"] as const) text(request[key]);
   let history: TrustedHistory | undefined = this.entries();
   const observed = this.lookup(history, request.runId);
   if (!observed || request.sessionId !== scope.sessionId || request.sessionId !== observed.identity.sessionId
    || request.taskId !== observed.identity.taskId || request.epoch !== scope.epoch || !scope.writable
    || !scope.branchEntryIds.includes(observed.origin)) return {kind: "rejected"};
   const retained = this.cache.get(request.runId);
   const interrupted = !observed.report && retained?.interrupted === true && !retained.token
    && retained.origin === observed.origin && isDeepStrictEqual(retained.identity, observed.identity);
   if (observed.receipt || !observed.report && !interrupted) return {kind: "informational", ...(observed.report ? {report: structuredClone(observed.report)} : {})};
   for (const raw of history) {
    const entry = journalRecord(raw);
    if (entry?.data.kind === "collected" && entry.data.sessionId === scope.sessionId
     && (entry.data.collectionId === request.collectionId || entry.data.toolCallId === request.toolCallId)) return {kind: "rejected"};
   }
   if (interrupted) {
    const {sessionId: _sessionId, ...identity} = observed.identity;
    const report = copyReport({status: "cancelled", ...identity, exitCode: 130,
     usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0},
     usageKnown: false, usageFields: [], diagnostic: "Interrupted run; execution is not resumed"}, observed.identity);
    // Explicit recovery only: retain before writing, as with live terminal delivery.
    // A failed append faults this ledger, so an uncertain write is never retried.
    retained!.report = report;
    observed.report = report;
    history = undefined;
    this.append({...observed.identity, version: 1, kind: "terminal", originEntryId: observed.origin, report});
    const confirmed = this.lookup(this.entries(), request.runId);
    if (!isDeepStrictEqual(confirmed?.report, report)) throw new Error("Interrupted terminal readback mismatch");
   }
   const report = observed.report!;
   const nativeUsage = report.providerUsage;
   const receipt: Receipt = {...observed.identity, version: 1, kind: "collected", originEntryId: observed.origin,
    collectionId: request.collectionId, toolCallId: request.toolCallId, native: nativeUsage ? "claimed" : "unavailable"};
   history = undefined;
   this.append(receipt);
   const confirmed = this.lookup(this.entries(), request.runId);
   if (!isDeepStrictEqual(confirmed?.receipt, receipt)) throw new Error("Claim readback mismatch");
   this.cache.delete(request.runId);
   return {kind: "first", report: structuredClone(report), receipt: structuredClone(receipt), ...(nativeUsage ? {nativeUsage: structuredClone(nativeUsage)} : {})};
  });
 }

 reconcile(runId: string): Reconciliation {
  return this.operation(() => {
   const history = this.entries();
   const observed = this.lookup(history, runId);
   if (!observed?.receipt) return "uncollected";
   const receipt = observed.receipt;
   let matches = 0, conflict = false;
   for (const raw of history) {
    const entry = dataObject(raw);
    if (entry.type !== "message") continue;
    const message = dataObject(entry.message);
    if (message.role !== "toolResult") continue;
    const correlation = message.details === undefined ? undefined : dataObject(message.details).guildBackground;
    if (correlation !== undefined) plain(correlation);
    if (message.usage !== undefined) plain(message.usage);
    if (message.toolCallId !== receipt.toolCallId && correlation?.collectionId !== receipt.collectionId
     && !(correlation?.sessionId === receipt.sessionId && correlation?.runId === receipt.runId)) continue;
    matches++;
    const expected = {version: 1, sessionId: receipt.sessionId, runId: receipt.runId, taskId: receipt.taskId, collectionId: receipt.collectionId};
    if (message.toolName !== "guild_wait" || message.toolCallId !== receipt.toolCallId
     || !isDeepStrictEqual(correlation, expected) || !isDeepStrictEqual(message.usage, receipt.native === "claimed" ? observed.report?.providerUsage : undefined)) conflict = true;
   }
   if (conflict || matches > 1) { this.fault = true; return "persisted-conflict"; }
   return receipt.native === "unavailable" ? "unavailable" : matches === 1 ? "persisted-matching" : "claimed-ambiguous";
  });
 }

 /** No child reconstruction and no journal writes. Interrupted admissions remain unknown. */
 restore(): void {
  return this.operation(() => {
   if (this.fault) throw new Error("Ledger fault");
   const history = this.entries();
   this.load(history, this.scopeSnapshot!.sessionId);
  });
 }

 private load(history: TrustedHistory, sessionId: string): void {
  // A different session needs a separate ledger; never evict this one's retained results.
  if (this.sessionId !== undefined && this.sessionId !== sessionId) throw new Error("Ledger session changed");
  this.sessionId = sessionId;
  const next = new Map<string, Observation>();
  for (const raw of history) {
   const entry = journalRecord(raw);
   if (!entry || entry.data.sessionId !== sessionId) continue;
   const observed = this.lookup(history, entry.data.runId)!;
   if (entry.data.kind !== "admitted") continue;
   if (observed.receipt) continue;
   if (next.size >= 16) throw new Error("UNCONSUMED history capacity exceeded");
   const owned = this.cache.get(observed.identity.runId);
   next.set(observed.identity.runId, owned ?? {...observed, interrupted: !observed.report});
  }
  this.cache.clear();
  for (const [id, observed] of next) this.cache.set(id, observed);
 }

 private lookup(history: TrustedHistory, runId: string): Observation | undefined {
  let observed: Observation | undefined;
  for (const raw of history) {
   const entry = journalRecord(raw);
   if (!entry || entry.data.runId !== runId) continue;
   const data = entry.data as LedgerRecord;
   if (data.kind === "admitted") {
    if (observed) throw new Error("Duplicate admission");
    observed = {identity: identityOf(data), origin: entry.id};
   } else {
    if (!observed || data.originEntryId !== observed.origin || !isDeepStrictEqual(identityOf(data), observed.identity)) throw new Error("Conflicting history identity");
    if (data.kind === "terminal") {
     if (observed.report) throw new Error("Duplicate terminal");
     observed.report = copyReport(data.report, observed.identity);
    } else {
     if (observed.receipt || !observed.report) throw new Error("Invalid claim");
     if ((data.native === "claimed") !== !!observed.report.providerUsage) throw new Error("Claim usage mismatch");
     for (const otherRaw of history) {
      const other = journalRecord(otherRaw);
      if (other && other.id !== entry.id && other.data.kind === "collected" && other.data.sessionId === data.sessionId
       && (other.data.collectionId === data.collectionId || other.data.toolCallId === data.toolCallId)) throw new Error("Duplicate collection correlation");
     }
     observed.receipt = structuredClone(data);
    }
   }
  }
  return observed;
 }
}
interface TrustedHistory extends Iterable<unknown> {
 readonly length: number;
 at(index: number): unknown;
}
// Read only own numeric data descriptors, never adapter-owned getters/iterators.
// Non-index string metadata is deliberately ignored; enumerating all own keys
// would itself allocate history-sized working state. Symbols are unsupported.
function historyView(value: readonly unknown[]): TrustedHistory {
 if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
  || Object.getOwnPropertySymbols(value).length) throw new Error("Invalid journal history");
 const length = Object.getOwnPropertyDescriptor(value, "length")!.value as number;
 const at = (index: number): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error("Invalid journal history index");
  return descriptor.value;
 };
 return {length, at, *[Symbol.iterator]() {
  for (let index = 0; index < length; index++) yield at(index);
 }};
}
function historyDigest(history: TrustedHistory): string {
 const hash = createHash("sha256");
 for (const raw of history) {
  // Validation bounds each ledger DTO before serialization. A delimiter frames
  // absent/non-ledger records too, so moving a claim changes the digest.
  hash.update(JSON.stringify(journalRecord(raw, true)) ?? "");
  hash.update("\n");
 }
 return hash.digest("hex");
}
function identityOf(value: LedgerIdentity): LedgerIdentity {
 return {sessionId: value.sessionId, runId: value.runId, taskId: value.taskId, role: value.role, profile: value.profile};
}
function text(value: unknown): asserts value is string {
 if (typeof value !== "string" || !value.trim() || value.includes("\0") || Buffer.byteLength(value) > 256) throw new Error("Invalid bounded identity");
}
function validateIdentity(value: LedgerIdentity): void {
 plain(value);
 for (const key of ["sessionId", "runId", "taskId", "role", "profile"] as const) text(value[key]);
 buildTask({role: value.role, profile: value.profile, runId: value.runId, taskId: value.taskId, task: "Observation identity"});
}
function plain(value: unknown, ancestors = new Set<object>()): void {
 if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return;
 if (!value || typeof value !== "object" || types.isProxy(value) || ancestors.has(value)) throw new Error("Expected plain acyclic data");
 const array = Array.isArray(value);
 if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype) && Object.getPrototypeOf(value) !== null) throw new Error("Expected plain data");
 ancestors.add(value);
 for (const key of Reflect.ownKeys(value)) {
  if (array && key === "length") continue;
  const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
  if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor)) throw new Error("Expected data properties");
  plain(descriptor.value, ancestors);
 }
 ancestors.delete(value);
}
function copyReport(value: BackgroundTerminalResult, identity: LedgerIdentity): BackgroundTerminalResult {
 plain(value);
 exact(value, ["status", "runId", "taskId", "role", "profile", "exitCode", "usage"],
  ["providerUsage", "report", "model", "diagnostic", "usageKnown", "usageFields"]);
 if (Buffer.byteLength(JSON.stringify(value)) > 65536) throw new Error("Terminal byte limit");
 // Revalidate stored report shape, not execution authority or truth of child claims.
 const task = buildTask({role: identity.role, profile: identity.profile, runId: identity.runId, taskId: identity.taskId,
  task: "Restored observation, not an execution request", practices: value.report?.compliance.map(item => ({id: item.id, policy: item.policy})) ?? []});
 const projected = projectBackgroundResult({...value, errorMessage: value.diagnostic} as GuildRoleRunResult, task);
 if (!isDeepStrictEqual(projected, value)) throw new Error("Noncanonical terminal DTO");
 return projected;
}
function dataObject(value: unknown): Record<string, any> {
 if (!value || typeof value !== "object" || types.isProxy(value)
  || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("Expected journal data object");
 for (const key of Reflect.ownKeys(value)) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
  if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor)) throw new Error("Expected journal data properties");
 }
 return value as Record<string, any>;
}
function exact(value: object, required: readonly string[], optional: readonly string[] = []): void {
 if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new Error("Invalid record fields");
}
function journalRecord(raw: unknown, validate = false): {id: string; data: LedgerRecord} | undefined {
 const entry = dataObject(raw);
 if (entry.type !== "custom" || typeof entry.customType !== "string" || !entry.customType.startsWith("pithos.guild.background.")) return;
 if (entry.customType !== CUSTOM) throw new Error("Unknown ledger journal version");
 // entries() validates once before synchronous scans; no journal callback occurs during a scan.
 if (!validate) return {id: entry.id, data: entry.data};
 text(entry.id);
 if (entry.parentId !== null) text(entry.parentId);
 const data = dataObject(entry.data);
 plain(data);
 if (data.version !== 1) throw new Error("Unknown ledger record version");
 const base = ["version", "kind", "sessionId", "runId", "taskId", "role", "profile"];
 validateIdentity(identityOf(data as LedgerIdentity));
 if (data.kind === "admitted") exact(data, base);
 else if (data.kind === "terminal") {
  exact(data, [...base, "originEntryId", "report"]);
  text(data.originEntryId);
  copyReport(data.report, identityOf(data as LedgerIdentity));
 } else if (data.kind === "collected") {
  exact(data, [...base, "originEntryId", "collectionId", "toolCallId", "native"]);
  text(data.originEntryId); text(data.collectionId); text(data.toolCallId);
  if (data.native !== "claimed" && data.native !== "unavailable") throw new Error("Invalid native claim");
 } else throw new Error("Unknown ledger record kind");
 return {id: entry.id, data: data as LedgerRecord};
}

class AdmissionRejection extends Error {}
