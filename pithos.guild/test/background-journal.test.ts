import assert from "node:assert/strict";
import test from "node:test";
import { createBackgroundJournal } from "../src/background-journal.ts";
import { BackgroundLedger } from "../src/background-ledger.ts";

function host() {
 const history: any[] = [];
 let active = true;
 const manager = Object.freeze({
  getSessionId() { assert.equal(this, manager); return "s"; },
  getBranch() { assert.equal(this, manager); return history; },
  getEntries() { assert.equal(this, manager); return history; },
 });
 const ctx = Object.freeze({get sessionManager() { if (!active) throw new Error("SECRET stale"); return manager; }});
 const pi = Object.freeze({appendEntry(customType: string, data: unknown) {
  assert.equal(this, pi);
  history.push({type: "custom", id: `e${history.length}`, parentId: history.at(-1)?.id ?? null,
   timestamp: new Date().toISOString(), customType, data: structuredClone(data)});
 }});
 return {history, ctx, pi, retire() { active = false; }};
}
const identity = {sessionId: "s", runId: "r", taskId: "t", role: "coder" as const, profile: "typescript" as const};

test("frozen SDK receivers append real custom entry shape and ledger reads origin identity", () => {
 const h = host(); const epoch = {};
 const journal = createBackgroundJournal(h.pi, h.ctx, {getEpoch: () => epoch});
 const ledger = new BackgroundLedger(journal);
 const token = ledger.reserve(identity);
 ledger.observeTerminal(token, {runId: "r", taskId: "t", role: "coder", profile: "typescript", status: "failed", exitCode: 1,
  usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0}});
 assert.equal(h.history[1].data.originEntryId, "e0");
 assert.equal(h.history[0].customType, "pithos.guild.background.v1");
 assert.deepEqual(journal.scope(), {sessionId: "s", branchEntryIds: ["e0", "e1"], writable: true, epoch});
 assert.equal(journal.entries(), h.history);
});

test("stale contexts and historical read-only scopes cannot append or expose host errors", () => {
 for (const mode of ["stale", "historical", "identity"] as const) {
  const h = host(); let writable = true; let current = true;
  const journal = createBackgroundJournal(h.pi, h.ctx, {getEpoch: () => epoch,
   isWritable: () => writable, isCurrentSession: () => current});
  const epoch = {};
  if (mode === "stale") h.retire();
  if (mode === "historical") {
   writable = false;
   assert.equal(journal.scope().writable, false);
   assert.deepEqual(journal.entries(), []);
  }
  if (mode === "identity") current = false;
  assert.throws(() => journal.append({...identity, kind: "admitted", version: 1}), /^Error: Background journal unavailable$/);
  assert.equal(h.history.length, 0);
 }
});

test("getter transitions, invalid scope, and caught reentry fail closed before writing", () => {
 for (const mode of ["epoch", "reentry", "invalid"] as const) {
  const h = host(); let epoch: object = {}; let armed = false;
  let journal: ReturnType<typeof createBackgroundJournal>;
  journal = createBackgroundJournal(h.pi, h.ctx, {
   getEpoch() { return mode === "invalid" && armed ? null as unknown as object : epoch; },
   isWritable() {
    if (armed) {
     if (mode === "epoch") epoch = {};
     if (mode === "reentry") { try { journal.entries(); } catch {} }
    }
    return true;
   },
  });
  armed = true;
  assert.throws(() => journal.append({...identity, kind: "admitted", version: 1}), /Background journal unavailable/);
  assert.equal(h.history.length, 0);
 }
});

test("invalid captured identity is rejected before any SDK append", () => {
 const h = host();
 const ctx = {sessionManager: {...h.ctx.sessionManager, getSessionId: () => ""}};
 assert.throws(() => createBackgroundJournal(h.pi, ctx, {getEpoch: () => ({})}), /Background journal unavailable/);
 assert.equal(h.history.length, 0);
});

test("caught reentry at the final identity callout prevents the append", () => {
 const h = host(); const epoch = {}; let calls = 0;
 let journal: ReturnType<typeof createBackgroundJournal>;
 journal = createBackgroundJournal(h.pi, h.ctx, {getEpoch: () => epoch, isCurrentSession() {
  if (++calls === 3) { try { journal.entries(); } catch {} }
  return true;
 }});
 assert.throws(() => journal.append({...identity, kind: "admitted", version: 1}), /Background journal unavailable/);
 assert.equal(h.history.length, 0);
});

test("current-session predicate invalidation at the final callout cannot write into replacement", () => {
 const h = host(); const epoch = {}; let calls = 0;
 const journal = createBackgroundJournal(h.pi, h.ctx, {getEpoch: () => epoch, isCurrentSession() {
  if (++calls === 3) h.retire();
  return true;
 }});
 assert.throws(() => journal.append({...identity, kind: "admitted", version: 1}), /Background journal unavailable/);
 assert.equal(h.history.length, 0);
});

test("final current-session lifecycle changes prevent SDK append with stable identity", () => {
 for (const mode of ["epoch", "writable"] as const) {
  const h = host(); let epoch = {}; let writable = true;
  const events: string[] = [];
  const journal = createBackgroundJournal(h.pi, h.ctx, {
   getEpoch: () => epoch, isWritable: () => writable,
   isCurrentSession() {
    events.push("current");
    if (events.length === 3) {
     events.push(mode);
     if (mode === "epoch") epoch = {};
     else writable = false;
    }
    return true;
   },
  });
  assert.throws(() => journal.append({...identity, kind: "admitted", version: 1}), /Background journal unavailable/);
  assert.equal(h.history.length, 0, `${mode}: no SDK write after lifecycle change`);
  assert.deepEqual(events, ["current", "current", "current", mode]);
 }
});

test("append method resolution is fenced before invocation with its original receiver", () => {
 for (const mode of ["epoch", "writable", "context", "stable"] as const) {
  const h = host(); let epoch = {}; let writable = true; let writes = 0;
  const events: string[] = [];
  const target = Object.freeze({get appendEntry() {
   events.push("resolve");
   if (mode === "epoch") epoch = {};
   if (mode === "writable") writable = false;
   if (mode === "context") h.retire();
   return function(this: unknown) {
    events.push("write"); writes++;
    assert.equal(this, pi);
   };
  }});
  const pi = new Proxy(target, {});
  const journal = createBackgroundJournal(pi, h.ctx, {
   getEpoch: () => epoch, isWritable: () => writable,
   isCurrentSession() { events.push("current"); return true; },
  });
  if (mode === "stable") {
   journal.append({...identity, kind: "admitted", version: 1});
   assert.equal(writes, 1);
   assert.ok(events.indexOf("resolve") < events.lastIndexOf("current", events.indexOf("write")));
  } else {
   assert.throws(() => journal.append({...identity, kind: "admitted", version: 1}), /Background journal unavailable/);
   assert.equal(writes, 0, `${mode}: no SDK invocation after accessor transition`);
   assert.deepEqual(events, ["current", "current", "resolve", "current"]);
  }
 }
});

test("read results are rejected when the last host check changes local policy", () => {
 for (const operation of ["scope", "entries"] as const) {
  for (const mode of ["epoch", "writable"] as const) {
   const h = host(); let epoch = {}; let writable = true;
   const events: string[] = [];
   const journal = createBackgroundJournal(h.pi, h.ctx, {
    getEpoch: () => epoch, isWritable: () => writable,
    isCurrentSession() {
     events.push("current");
     if (events.length === 4) {
      events.push(mode);
      if (mode === "epoch") epoch = {};
      else writable = false;
     }
     return true;
    },
   });
   assert.throws(() => journal[operation](), /Background journal unavailable/);
   assert.deepEqual(events, ["current", "current", "current", "current", mode]);
   assert.equal(h.history.length, 0);
  }
 }
});

test("policy callbacks are captured once without late option getter callouts", () => {
 const h = host(); const epoch = {}; const resolved: string[] = [];
 const receivers: unknown[] = []; let armed = false;
 const options = Object.freeze({
  get getEpoch() {
   resolved.push("epoch"); if (armed) h.retire();
   return function(this: unknown) { receivers.push(this); return epoch; };
  },
  get isWritable() {
   resolved.push("writable"); if (armed) h.retire();
   return function(this: unknown) { receivers.push(this); return true; };
  },
  get isCurrentSession() {
   resolved.push("current"); if (armed) h.retire();
   return function(this: unknown) { receivers.push(this); return true; };
  },
 });
 const journal = createBackgroundJournal(h.pi, h.ctx, options);
 armed = true;
 journal.append({...identity, kind: "admitted", version: 1});
 assert.deepEqual(resolved.slice().sort(), ["current", "epoch", "writable"]);
 assert.ok(receivers.length > 0);
 assert.ok(receivers.every(receiver => receiver === options));
 assert.equal(h.history.length, 1);
});
