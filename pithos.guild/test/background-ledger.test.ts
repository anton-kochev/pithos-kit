import assert from "node:assert/strict";
import test from "node:test";
import { BackgroundLedger, type BackgroundJournal, type LedgerScope } from "../src/background-ledger.ts";
import type { BackgroundTerminalResult } from "../src/background-result.ts";

const usage = {input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10,
 cost: {input: .1, output: .2, cacheRead: .3, cacheWrite: .4, total: 1}};
function identity(runId = "r") { return {sessionId: "s", runId, taskId: `t-${runId}`, role: "coder" as const, profile: "typescript" as const}; }
function terminal(runId = "r", native: typeof usage | null | undefined = usage): BackgroundTerminalResult {
 const {sessionId: _session, ...ids} = identity(runId);
 return {status: "failed", ...ids, exitCode: 1,
  usage: {input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 1, contextTokens: 10, turns: 1},
  ...(native === undefined ? {} : {providerUsage: native})};
}
class Journal implements BackgroundJournal {
 history: any[] = [];
 current: LedgerScope = {sessionId: "s", branchEntryIds: [], writable: true, epoch: {}};
 hook?: (event: string) => void;
 scope() { this.hook?.("scope"); return this.current; }
 entries() { this.hook?.("entries"); return this.history; }
 append(data: unknown) {
  this.hook?.("before");
  const id = `e${this.history.length}`;
  this.history.push({type: "custom", id, parentId: this.current.branchEntryIds.at(-1) ?? null,
   customType: "pithos.guild.background.v1", data: structuredClone(data)});
  this.current = {...this.current, branchEntryIds: [...this.current.branchEntryIds, id]};
  this.hook?.("after");
 }
}
function setup() { const journal = new Journal(); return {journal, ledger: new BackgroundLedger(journal)}; }
function request(journal: Journal, runId = "r") { return {...identity(runId), collectionId: `c-${runId}`, toolCallId: `tc-${runId}`, epoch: journal.current.epoch}; }

test("retains sixteen independent observations, rejects overflow, and claims before emitting once", () => {
 const {journal, ledger} = setup();
 const tokens = Array.from({length: 16}, (_, i) => ledger.reserve(identity(String(i))));
 assert.throws(() => ledger.reserve(identity("overflow")), /UNCONSUMED/);
 for (let i = 15; i >= 0; i--) ledger.observeTerminal(tokens[i], terminal(String(i)));
 assert.equal(ledger.inspect("0")?.report?.status, "failed");
 const first = ledger.collect(request(journal, "0"));
 assert.equal(first.kind, "first");
 if (first.kind !== "first") assert.fail();
 assert.deepEqual(first.nativeUsage, usage);
 assert.equal(journal.history.at(-1).data.native, "claimed");
 assert.equal(ledger.collect(request(journal, "0")).kind, "informational");
 assert.equal(ledger.reconcile("0"), "claimed-ambiguous");
 assert.equal(ledger.inspect("1")?.report?.status, "failed");
 ledger.reserve(identity("replacement"));
 assert.throws(() => ledger.reserve(identity("overflow2")), /UNCONSUMED/);
});

test("fences journal faults and caught reentry without losing terminal memory or siblings", () => {
 for (const failure of ["before", "after", "reentry", "transition"] as const) {
  const {journal, ledger} = setup();
  const token = ledger.reserve(identity());
  const sibling = ledger.reserve(identity("sibling"));
  ledger.observeTerminal(sibling, terminal("sibling"));
  journal.hook = event => {
   if (event !== "before" && event !== "after") return;
   if (failure === event) throw new Error("injected write failure");
   if (failure === "reentry" && event === "before") {
    try { ledger.collect(request(journal, "sibling")); } catch { /* Deliberately caught by adapter. */ }
   }
   if (failure === "transition" && event === "before") journal.current = {...journal.current, epoch: {}};
  };
  assert.throws(() => ledger.observeTerminal(token, terminal()));
  journal.hook = undefined;
  assert.equal(ledger.inspect("r")?.report?.status, "failed");
  assert.equal(ledger.inspect("sibling")?.report?.status, "failed");
  assert.throws(() => ledger.reserve(identity("new")), /fault/i);
  assert.equal(ledger.collect(request(journal)).kind, "rejected");
 }
 for (const failure of ["before", "after", "reentry", "entries", "scope"] as const) {
  const {journal, ledger} = setup();
  ledger.observeTerminal(ledger.reserve(identity()), terminal());
  journal.hook = event => {
   if (failure === "reentry" && event === "before") {
    try { ledger.collect(request(journal)); } catch { /* Must veto the outer call too. */ }
   } else if (event === failure) throw new Error("claim failure");
  };
  assert.throws(() => ledger.collect(request(journal)));
  journal.hook = undefined;
  assert.equal(ledger.collect(request(journal)).kind, "rejected");
  assert.equal(ledger.inspect("r")?.report?.status, "failed");
  if (failure === "after") {
   const restored = new BackgroundLedger(journal); restored.restore();
   assert.equal(restored.collect(request(journal)).kind, "informational");
   assert.equal(restored.reconcile("r"), "claimed-ambiguous");
  }
 }
});

function nativeEntry(journal: Journal, changes: Record<string, unknown> = {}) {
 journal.history.push({type: "message", id: `m${journal.history.length}`, parentId: null, message: {
  role: "toolResult", toolName: "guild_wait", toolCallId: "tc-r", usage,
  details: {guildBackground: {version: 1, sessionId: "s", runId: "r", taskId: "t-r", collectionId: "c-r"}}, ...changes}});
}
test("reconciles only subsequently persisted native usage with exact correlation and no duplicates", () => {
 for (const variant of ["matching", "modified", "duplicate", "correlation", "tool", "missing"] as const) {
  const {journal, ledger} = setup();
  ledger.observeTerminal(ledger.reserve(identity()), terminal());
  assert.equal(ledger.collect(request(journal)).kind, "first");
  assert.equal(ledger.reconcile("r"), "claimed-ambiguous");
  if (variant !== "missing") nativeEntry(journal, variant === "modified" ? {usage: {...usage, input: 99}}
   : variant === "correlation" ? {details: {guildBackground: {...identity(), version: 1, collectionId: "wrong"}}}
   : variant === "tool" ? {toolName: "other"} : {});
  if (variant === "duplicate") nativeEntry(journal);
  assert.equal(ledger.reconcile("r"), variant === "matching" ? "persisted-matching" : variant === "missing" ? "claimed-ambiguous" : "persisted-conflict");
  assert.notEqual(ledger.collect(request(journal)).kind, "first");
 }
});

test("restores observations only, retains interrupted admissions and faults on unconsumed overflow", () => {
 const {journal, ledger} = setup();
 ledger.reserve(identity("interrupted"));
 ledger.observeTerminal(ledger.reserve(identity()), terminal());
 const restored = new BackgroundLedger(journal);
 const length = journal.history.length;
 restored.restore();
 assert.equal(journal.history.length, length);
 assert.deepEqual(restored.inspect("interrupted"), {interrupted: true});
 assert.equal(restored.inspect("r")?.report?.status, "failed");
 assert.equal(restored.collect(request(journal)).kind, "first");
 for (let i = 0; i < 40; i++) {
  const run = `old${i}`;
  restored.observeTerminal(restored.reserve(identity(run)), terminal(run));
  restored.collect(request(journal, run));
 }
 const again = new BackgroundLedger(journal); again.restore();
 for (let i = 0; i < 15; i++) again.reserve(identity(`new${i}`));
 assert.throws(() => again.reserve(identity("overflow")), /UNCONSUMED/);
 // Historical lookup must not refill the bounded working cache.
 assert.ok(again.inspect("old0")?.report);
 journal.append({...identity("external"), version: 1, kind: "admitted"});
 const excess = new BackgroundLedger(journal);
 assert.throws(() => excess.restore(), /UNCONSUMED/);
 assert.throws(() => excess.reserve(identity("cannot")), /fault/i);
});

test("rejects malformed or conflicting journal evidence rather than forgetting a possible claim", () => {
 const mutations: Array<(journal: Journal) => void> = [
  j => { j.history.at(-1).data.version = 2; },
  j => { j.history.at(-1).data.native = "unknown"; },
  j => { j.history.at(-1).data.toolCallId = ""; },
  j => { j.history.at(-1).data.extra = "raw logs"; },
  j => { j.history.at(-1).data.originEntryId = "wrong"; },
  j => { j.history.push(structuredClone(j.history.at(-1))); },
  j => { j.history.push(structuredClone(j.history[0])); },
  j => { j.history[1].id = j.history[0].id; },
  j => { j.history[1].data.report.providerUsage.input = -1; },
  j => { j.history[1].data.report.extra = "unbounded raw field"; },
  j => { j.history.at(-1).customType = "pithos.guild.background.v2"; },
  j => { j.history.at(-1).data = new Proxy(j.history.at(-1).data, {get() { throw new Error("trap executed"); }}); },
  j => { Object.defineProperty(j.history.at(-1).data, "native", {get() { throw new Error("getter executed"); }}); },
 ];
 for (const mutate of mutations) {
  const {journal, ledger} = setup();
  ledger.observeTerminal(ledger.reserve(identity()), terminal());
  ledger.collect(request(journal));
  mutate(journal);
  const restored = new BackgroundLedger(journal);
  assert.throws(() => restored.restore(), error => error instanceof Error && !/executed/.test(error.message));
  assert.equal(restored.collect(request(journal)).kind, "rejected");
 }
});

test("binds claims globally to unique collection and tool calls, including unavailable usage", async () => {
 const {journal, ledger} = setup();
 ledger.observeTerminal(ledger.reserve(identity()), terminal());
 ledger.observeTerminal(ledger.reserve(identity("other")), terminal("other", null));
 const original = journal.current;
 for (const patch of [{runId: "missing"}, {taskId: "wrong"}, {sessionId: "wrong"}, {epoch: {}}]) {
  const length = journal.history.length;
  assert.equal(ledger.collect({...request(journal), ...patch}).kind, "rejected");
  assert.equal(journal.history.length, length);
 }
 journal.current = {...original, branchEntryIds: [], epoch: {}};
 assert.equal(ledger.collect(request(journal)).kind, "rejected");
 journal.current = {...original, writable: false, epoch: {}};
 assert.equal(ledger.collect(request(journal)).kind, "rejected");
 journal.current = {...original, epoch: {}};
 const results = await Promise.all([Promise.resolve().then(() => ledger.collect(request(journal))), Promise.resolve().then(() => ledger.collect(request(journal)))]);
 assert.deepEqual(results.map(result => result.kind), ["first", "informational"]);
 const before = journal.history.length;
 assert.equal(ledger.collect({...request(journal, "other"), collectionId: "c-r"}).kind, "rejected");
 assert.equal(ledger.collect({...request(journal, "other"), toolCallId: "tc-r"}).kind, "rejected");
 assert.equal(journal.history.length, before);
 const unknown = ledger.collect(request(journal, "other"));
 assert.equal(unknown.kind, "first");
 assert.equal(Object.hasOwn(unknown, "nativeUsage"), false);
 assert.equal(ledger.reconcile("other"), "unavailable");
 journal.history.push({type: "message", id: "native-unknown", parentId: null, message: {role: "toolResult", toolName: "guild_wait", toolCallId: "tc-other",
  details: {guildBackground: {version: 1, sessionId: "s", runId: "other", taskId: "t-other", collectionId: "c-other"}}}});
 assert.equal(ledger.reconcile("other"), "unavailable");
 journal.current = {...journal.current, branchEntryIds: [], epoch: {}};
 const restored = new BackgroundLedger(journal); restored.restore();
 assert.equal(restored.collect(request(journal)).kind, "rejected");
 journal.current = {...journal.current, branchEntryIds: original.branchEntryIds, epoch: {}};
 assert.equal(restored.collect(request(journal)).kind, "informational");
 assert.equal(restored.reconcile("r"), "claimed-ambiguous");
 const missing = terminal("missing-usage"); delete missing.providerUsage;
 restored.observeTerminal(restored.reserve(identity("missing-usage")), missing);
 const noUsage = restored.collect(request(journal, "missing-usage"));
 assert.equal(noUsage.kind, "first");
 assert.equal(Object.hasOwn(noUsage, "nativeUsage"), false);
 assert.equal(restored.reconcile("missing-usage"), "unavailable");
});

test("scope transitions cannot discard retained observations or execute scope accessors", () => {
 const {journal, ledger} = setup();
 ledger.observeTerminal(ledger.reserve(identity()), terminal());
 const original = journal.current;
 journal.current = {...journal.current, sessionId: "next", epoch: {}, branchEntryIds: []};
 assert.throws(() => ledger.reserve({...identity("new"), sessionId: "next"}));
 assert.equal(ledger.inspect("r"), undefined);
 journal.current = {...original, epoch: {}};
 assert.equal(ledger.inspect("r")?.report?.status, "failed");
 const other = setup();
 let invoked = false;
 Object.defineProperty(other.journal.current, "writable", {get() { invoked = true; return true; }});
 assert.throws(() => other.ledger.reserve(identity()));
 assert.equal(invoked, false);
});

test("rejects unsafe history containers without invoking getters or iterators", () => {
 for (const variant of ["getter", "iterator", "prototype", "sparse", "proxy"] as const) {
  const {journal, ledger} = setup();
  ledger.observeTerminal(ledger.reserve(identity()), terminal());
  ledger.collect(request(journal));
  let effects = 0;
  const claim = journal.history.at(-1);
  if (variant === "getter") Object.defineProperty(journal.history, "2", {get() { effects++; return claim; }});
  if (variant === "iterator") Object.defineProperty(journal.history, Symbol.iterator, {value: function* () { effects++; yield* []; }});
  if (variant === "prototype") Object.setPrototypeOf(journal.history, Object.assign(Object.create(Array.prototype), {
   [Symbol.iterator]: function* () { effects++; yield* []; }
  }));
  if (variant === "sparse") delete journal.history[2];
  if (variant === "proxy") journal.history = new Proxy(journal.history, {get(target, key) { effects++; return Reflect.get(target, key); }});
  else Object.freeze(journal.history);
  const restored = new BackgroundLedger(journal);
  assert.throws(() => restored.collect(request(journal)), variant);
  assert.equal(effects, 0, variant);
  assert.equal(restored.collect(request(journal)).kind, "rejected");
 }
});

test("fences history mutations and caught reentry during follow-up scope callbacks", () => {
 for (const variant of ["remove", "replace", "nested", "reentry"] as const) {
  const {journal, ledger} = setup();
  ledger.observeTerminal(ledger.reserve(identity()), terminal());
  ledger.collect(request(journal));
  const restored = new BackgroundLedger(journal);
  let read = false;
  journal.hook = event => {
   if (event === "entries") read = true;
   if (event !== "scope" || !read) return;
   read = false;
   if (variant === "remove") journal.history.pop();
   if (variant === "replace") journal.history[2] = {type: "unrelated"};
   if (variant === "nested") journal.history[2].data.toolCallId = "changed";
   if (variant === "reentry") { try { restored.inspect("r"); } catch { /* Adapter catches it. */ } }
  };
  assert.throws(() => restored.collect(request(journal)), variant);
  journal.hook = undefined;
  assert.equal(restored.collect(request(journal)).kind, "rejected");
 }
});


test("inspect reveals cached and historical reports only in the admitted session and branch", () => {
 for (const collected of [false, true]) {
  const {journal, ledger} = setup();
  ledger.observeTerminal(ledger.reserve(identity()), terminal());
  if (collected) ledger.collect(request(journal));
  const original = journal.current;
  for (const current of [
   {...original, branchEntryIds: [], epoch: {}},
   {...original, sessionId: "other", epoch: {}}
  ]) {
   journal.current = current;
   assert.equal(ledger.inspect("r"), undefined);
   assert.equal(ledger.collect(request(journal)).kind, "rejected");
   journal.current = {...original, epoch: {}};
   assert.deepEqual(ledger.inspect("r")?.report, terminal());
  }
 }
});

test("inspect fences caught reentry and scope changes even for cached reports", () => {
 for (const collected of [false, true]) for (const variant of ["reentry", "transition"]) {
  const {journal, ledger} = setup();
  ledger.observeTerminal(ledger.reserve(identity()), terminal());
  if (collected) ledger.collect(request(journal));
  let calls = 0;
  journal.hook = event => {
   if (event !== "scope" || ++calls !== 2) return;
   if (variant === "transition") journal.current = {...journal.current, epoch: {}};
   else { try { ledger.inspect("r"); } catch { /* Must veto outer read. */ } }
  };
  assert.throws(() => ledger.inspect("r"));
  journal.hook = undefined;
  assert.deepEqual(ledger.inspect("r")?.report, terminal());
 }
});

test("scans consumed history without allocating a bulk descriptor map", () => {
 const {journal} = setup();
 for (let i = 0; i < 80; i++) {
  const runId = `consumed-${i}`;
  const originEntryId = `e${journal.history.length}`;
  journal.append({...identity(runId), version: 1, kind: "admitted"});
  journal.append({...identity(runId), version: 1, kind: "terminal", originEntryId, report: terminal(runId)});
  journal.append({...identity(runId), version: 1, kind: "collected", originEntryId,
   collectionId: `c-${runId}`, toolCallId: `tc-${runId}`, native: "claimed"});
 }
 const restored = new BackgroundLedger(journal);
 const descriptors = Object.getOwnPropertyDescriptors;
 // Instrument only the SDK history boundary, not per-record validation.
 Object.getOwnPropertyDescriptors = ((value: object) => {
  assert.notEqual(value, journal.history, "must not allocate a full-history descriptor map");
  return descriptors(value);
 }) as typeof descriptors;
 try {
  restored.restore();
  assert.equal(restored.collect(request(journal, "consumed-0")).kind, "informational");
  for (let i = 0; i < 16; i++) restored.reserve(identity(`live-${i}`));
  assert.throws(() => restored.reserve(identity("overflow")), /UNCONSUMED/);
 } finally { Object.getOwnPropertyDescriptors = descriptors; }
});

test("ignores non-index string metadata without evaluating it", () => {
 const {journal, ledger} = setup();
 ledger.observeTerminal(ledger.reserve(identity()), terminal());
 let effects = 0;
 Object.defineProperty(journal.history, "metadata", {get() { effects++; throw new Error("metadata executed"); }});
 assert.equal(ledger.collect(request(journal)).kind, "first");
 assert.equal(effects, 0);
});

test("list returns only bounded visible independent observations with identities", () => {
 const {journal, ledger} = setup();
 for (let i = 0; i < 16; i++) ledger.observeTerminal(ledger.reserve(identity(String(i))), terminal(String(i)));
 const listed = ledger.list();
 assert.equal(listed.length, 16);
 assert.deepEqual(listed[0].identity, identity("0"));
 assert.deepEqual(listed[0].report, terminal("0"));
 listed[0].identity.runId = "mutated";
 listed[0].report!.usage.input = 999;
 assert.deepEqual(ledger.list()[0].identity, identity("0"));
 assert.deepEqual(ledger.list()[0].report, terminal("0"));
 const original = journal.current;
 journal.current = {...original, branchEntryIds: [], epoch: {}};
 assert.deepEqual(ledger.list(), []);
 assert.throws(() => ledger.reserve(identity("hidden-capacity")), /UNCONSUMED/);
 journal.current = {...original, sessionId: "other", epoch: {}};
 assert.deepEqual(ledger.list(), []);
 journal.current = original;
 ledger.collect(request(journal, "0"));
 assert.equal(ledger.list().length, 15);
 const restored = new BackgroundLedger(journal); restored.restore();
 assert.equal(restored.list().length, 15);
});

test("explicit interrupted collection frees exactly one of sixteen restored slots with unknown usage", () => {
 const {journal, ledger} = setup();
 for (let i = 0; i < 16; i++) ledger.reserve(identity(String(i)));
 const restored = new BackgroundLedger(journal);
 restored.restore();
 assert.equal(journal.history.length, 16, "restore must not write");
 assert.equal(restored.list().every(item => item.interrupted && !item.report), true);
 assert.throws(() => restored.reserve(identity("overflow")), /UNCONSUMED/);
 const result = restored.collect(request(journal, "0"));
 assert.equal(result.kind, "first");
 if (result.kind !== "first") assert.fail();
 assert.equal(result.report.status, "cancelled");
 assert.equal(result.report.diagnostic, "Interrupted run; execution is not resumed");
 assert.equal(result.report.usageKnown, false);
 assert.deepEqual(result.report.usageFields, []);
 assert.equal(Object.hasOwn(result, "nativeUsage"), false);
 assert.equal(result.receipt.native, "unavailable");
 assert.equal(journal.history.length, 18);
 assert.equal(journal.history[16].data.kind, "terminal");
 assert.equal(journal.history[17].data.kind, "collected");
 assert.equal(restored.list().length, 15);
 assert.equal(restored.collect(request(journal, "0")).kind, "informational");
 restored.reserve(identity("replacement"));
 assert.throws(() => restored.reserve(identity("overflow-again")), /UNCONSUMED/);
 const again = new BackgroundLedger(journal); again.restore();
 assert.equal(again.collect(request(journal, "0")).kind, "informational");
 assert.equal(again.reconcile("0"), "unavailable");
});

test("interrupted recovery rejects hidden and read-only origins and never converts live admissions", () => {
 const {journal, ledger} = setup();
 const token = ledger.reserve(identity());
 ledger.restore();
 assert.equal(ledger.collect(request(journal)).kind, "informational");
 assert.equal(journal.history.length, 1);
 assert.equal(ledger.list()[0].interrupted, false);
 const restored = new BackgroundLedger(journal); restored.restore();
 const original = journal.current;
 for (const scope of [
  {...original, branchEntryIds: [], epoch: {}},
  {...original, sessionId: "other", epoch: {}},
  {...original, writable: false, epoch: {}}
 ]) {
  journal.current = scope;
  assert.equal(restored.collect(request(journal)).kind, "rejected");
  assert.equal(journal.history.length, 1);
 }
 journal.current = original;
 ledger.observeTerminal(token, terminal());
 assert.equal(ledger.collect(request(journal)).kind, "first");
});

test("interrupted recovery retains terminal memory on write failure and never retries ambiguous writes", () => {
 for (const failure of ["before", "after", "reentry", "transition"] as const) {
  const {journal, ledger} = setup();
  ledger.reserve(identity());
  const restored = new BackgroundLedger(journal); restored.restore();
  journal.hook = event => {
   if (event === failure) throw new Error("interrupted write failure");
   if (event !== "before") return;
   if (failure === "reentry") { try { restored.list(); } catch { /* Adapter swallows reentry. */ } }
   if (failure === "transition") journal.current = {...journal.current, epoch: {}};
  };
  assert.throws(() => restored.collect(request(journal)), failure);
  journal.hook = undefined;
  assert.equal(restored.inspect("r")?.report?.diagnostic, "Interrupted run; execution is not resumed");
  assert.equal(restored.list()[0].report?.usageKnown, false);
  const length = journal.history.length;
  assert.equal(restored.collect(request(journal)).kind, "rejected");
  assert.equal(journal.history.length, length);
 }
});

test("list fences scope transitions and caught reentry without dropping retained reports", () => {
 for (const variant of ["transition", "reentry"] as const) {
  const {journal, ledger} = setup();
  ledger.observeTerminal(ledger.reserve(identity()), terminal());
  let calls = 0;
  journal.hook = event => {
   if (event !== "scope" || ++calls !== 2) return;
   if (variant === "transition") journal.current = {...journal.current, epoch: {}};
   else { try { ledger.list(); } catch { /* Must veto outer observation. */ } }
  };
  assert.throws(() => ledger.list());
  journal.hook = undefined;
  assert.deepEqual(ledger.list()[0].report, terminal());
 }
});
