import assert from "node:assert/strict";
import { test } from "node:test";
import { createBackgroundNotifications } from "../src/background-notifications.ts";

const question = (runId: string, revision = 1, questionId = "q", textPreview = "Help?") => ({
 kind: "question", runId, taskId: `task-${runId}`, role: "coder", profile: "typescript",
 revision, questionId, textPreview,
});

test("three runs retain independent questions and selection does not consume", () => {
 const epoch = {};
 const buffer = createBackgroundNotifications(epoch);
 for (const id of ["a", "b", "c"]) buffer.observe(epoch, question(id));
 const batch = buffer.reserveBatch();
 assert.deepEqual(batch.items.map(item => item.runId), ["a", "b", "c"]);
 assert.deepEqual(buffer.reserveBatch(), batch);
 assert.notEqual(buffer.reserveBatch().items, batch.items);
 assert.equal(buffer.ack(batch.token), true);
 assert.equal(buffer.reserveBatch().items.length, 0);
});

test("revisions, answers, terminal identity and reservation ownership suppress only selected candidates", () => {
 const epoch = {};
 const buffer = createBackgroundNotifications(epoch);
 buffer.observe(epoch, question("a"));
 const old = buffer.reserveBatch();
 buffer.observe(epoch, question("a", 2, "replacement"));
 buffer.ack(old.token);
 assert.equal(buffer.reserveBatch().items[0]?.questionId, "replacement");
 buffer.ack(buffer.reserveBatch().token);
 buffer.observe(epoch, question("a", 3, "replacement"));
 assert.equal(buffer.reserveBatch().items.length, 0, "same question ID stays deduplicated");
 buffer.release(buffer.reserveBatch().token);
 buffer.observe(epoch, question("a", 4, "answered"));
 buffer.observe(epoch, { ...question("a", 5), kind: "clear-question" });
 assert.equal(buffer.reserveBatch().items.length, 0);
 buffer.release(buffer.reserveBatch().token);
 buffer.observe(epoch, question("a", 6, "last"));
 buffer.observe(epoch, { ...question("a", 7), kind: "terminal", eventId: "done", status: "succeeded" });
 buffer.observe(epoch, question("a", 6, "late"));
 const terminal = buffer.reserveBatch();
 assert.deepEqual(terminal.items.map(item => item.kind), ["terminal"]);
 buffer.release(terminal.token);
 assert.deepEqual(buffer.reserveBatch().items, terminal.items);
 buffer.ack(buffer.reserveBatch().token);
 buffer.observe(epoch, { ...question("a", 8), kind: "terminal", eventId: "done", status: "succeeded" });
 assert.equal(buffer.reserveBatch().items.length, 0);
 const staleToken = buffer.reserveBatch().token;
 const nextEpoch = {};
 buffer.reset(nextEpoch);
 assert.equal(buffer.ack(staleToken), false);
 assert.equal(buffer.observe(epoch, question("b")), "wrong-epoch");
 assert.equal(buffer.observe(nextEpoch, question("b")), "accepted");
 assert.equal(buffer.reserveBatch().items.length, 1);
});

test("bounded validated data, explicit overflow and removal keep only sixteen histories", () => {
 const epoch = {};
 const buffer = createBackgroundNotifications(epoch);
 for (const input of [null, {}, { ...question("x"), revision: 0 }, { ...question("x"), runId: "x".repeat(257) }]) {
  assert.equal(buffer.observe(epoch, input), "invalid-event");
 }
 for (let i = 0; i < 16; i++) {
  assert.equal(buffer.observe(epoch, { ...question(`${i}`, 1, "q", '\u0000\n"\\😀'.repeat(1000)), taskPreview: "😀".repeat(100), fullReport: "secret" }), "accepted");
 }
 assert.equal(buffer.observe(epoch, question("overflow")), "resync-needed");
 let count = 0;
 for (let pass = 0; pass < 16; pass++) {
  const batch = buffer.reserveBatch();
  assert.equal(batch.omitted, true);
  assert.ok(Buffer.byteLength(JSON.stringify(batch)) <= 8192);
  assert.ok(batch.items.length <= 8);
  assert.match(batch.instruction, /status.*wait/i);
  for (const item of batch.items) {
   assert.equal(item.trust, "raw-child-untrusted");
   assert.ok(Buffer.byteLength(item.textPreview!) <= 512);
   assert.ok(Buffer.byteLength(item.taskPreview!) <= 160);
   assert.match(item.textPreview!, /…/);
   assert.doesNotMatch(item.textPreview!, /[\x00-\x1f\x7f]/);
   assert.equal("fullReport" in item, false);
  }
  count += batch.items.length;
  buffer.ack(batch.token);
 }
 assert.equal(count, 16);
 assert.equal(buffer.observe(epoch, question("overflow")), "resync-needed", "acked history remains bounded, not evicted");
 assert.equal(buffer.remove("0"), true);
 assert.equal(buffer.observe(epoch, question("overflow")), "accepted");
 assert.equal(buffer.observe(epoch, question("another")), "resync-needed");
 const next = {};
 buffer.reset(next);
 assert.equal(buffer.reserveBatch().omitted, false);
});

test("mixed classes alternate and round robin survives continuously replenished early runs", () => {
 const epoch = {};
 const buffer = createBackgroundNotifications(epoch);
 for (let i = 0; i < 12; i++) buffer.observe(epoch, question(`q${i}`));
 for (let i = 0; i < 4; i++) buffer.observe(epoch, { ...question(`t${i}`), kind: "terminal", eventId: `t${i}`, status: "completed" });
 for (let revision = 2; revision < 20; revision++) {
  buffer.observe(epoch, { ...question("q0", revision), kind: "state" });
 }
 const first = buffer.reserveBatch();
 assert.deepEqual(first.items.map(item => item.kind), ["question", "terminal", "question", "terminal", "question", "terminal", "question", "terminal"]);
 const seen = new Set(first.items.map(item => item.runId));
 buffer.ack(first.token);
 for (const item of first.items.filter(item => item.kind === "question")) buffer.observe(epoch, question(item.runId, 20, "new"));
 const second = buffer.reserveBatch();
 for (const item of second.items) seen.add(item.runId);
 assert.equal(seen.size, 16, "new early questions must not starve older runs");
 assert.equal(new Set(second.items.map(item => item.runId)).size, second.items.length);
});

test("escaped metadata budget leaves oversized aggregate work retryable without starving short runs", () => {
 const epoch = {};
 const buffer = createBackgroundNotifications(epoch);
 for (let i = 0; i < 16; i++) {
  const runId = `${i}` + '"'.repeat(250);
  buffer.observe(epoch, { ...question(runId, 1, '\\'.repeat(256), '"'.repeat(512)), taskId: '"'.repeat(256), profile: '\\'.repeat(256), taskPreview: '"'.repeat(160) });
 }
 let delivered = 0;
 for (let pass = 0; pass < 16; pass++) {
  const batch = buffer.reserveBatch();
  assert.ok(Buffer.byteLength(JSON.stringify(batch)) <= 8192, "escaped whole batch exceeds byte budget");
  delivered += batch.items.length;
  buffer.ack(batch.token);
 }
 assert.equal(delivered, 16);
});

for (const mixed of [false, true]) {
 test(`byte-budget fairness survives replenished ${mixed ? "mixed classes" : "questions"}`, () => {
  const epoch = {};
  const buffer = createBackgroundNotifications(epoch);
  const largeId = "large" + '"'.repeat(250);
  const large = {
   ...question(largeId, 1, "\\".repeat(256), '"'.repeat(512)),
   taskId: '"'.repeat(256), profile: "\\".repeat(256), taskPreview: '"'.repeat(160),
  };
  const small = (index: number, revision: number) => ({
   ...question(`small-${index}`, revision, `q-${revision}`, "x".repeat(200)),
   taskId: "x".repeat(180), profile: "x".repeat(180), taskPreview: "x".repeat(160),
   ...(mixed && index % 2 === 1 ? { kind: "terminal", eventId: `done-${revision}`, status: "completed" } : {}),
  });
  for (let i = 0; i < 6; i++) assert.equal(buffer.observe(epoch, small(i, 1)), "accepted");
  assert.equal(buffer.observe(epoch, large), "accepted");
  assert.equal(buffer.observe(epoch, small(7, 1)), "accepted");
  let delivered = false;
  for (let pass = 0; pass < 3; pass++) {
   const batch = buffer.reserveBatch();
   assert.deepEqual(buffer.reserveBatch(), batch, "reservation must remain stable");
   assert.ok(Buffer.byteLength(JSON.stringify(batch)) <= 8192);
   assert.ok(batch.items.length <= 8);
   assert.equal(new Set(batch.items.map(item => item.runId)).size, batch.items.length);
   if (pass === 0) {
    assert.equal(batch.items.some(item => item.runId === largeId), false, "fixture must exercise a budget miss");
    if (mixed) assert.deepEqual(batch.items.slice(0, 6).map(item => item.kind), ["question", "terminal", "question", "terminal", "question", "terminal"]);
   }
   for (const item of batch.items) {
    if (item.runId === largeId) {
     delivered = true;
     assert.equal(item.taskId, large.taskId);
     assert.equal(item.profile, large.profile);
     assert.equal(item.questionId, large.questionId);
    }
   }
   assert.equal(buffer.ack(batch.token), true);
   for (const item of batch.items) {
    if (item.runId !== largeId) assert.equal(buffer.observe(epoch, small(Number(item.runId.split("-")[1]), pass + 2)), "accepted");
   }
  }
  assert.equal(delivered, true, "large pending question must be delivered within three batches despite replenishment");
 });
}

test("discard prunes only exact reserved stale candidates, preserving siblings and newer replacements", () => {
 const epoch = {}; const buffer = createBackgroundNotifications(epoch);
 buffer.observe(epoch, question("stale"));
 buffer.observe(epoch, question("replaced"));
 buffer.observe(epoch, { ...question("done"), kind: "terminal", eventId: "done:terminal", status: "completed" });
 const batch = buffer.reserveBatch();
 buffer.observe(epoch, question("replaced", 2, "new"));
 const stale = batch.items.filter(item => item.kind === "question");
 assert.equal(buffer.discard({}, stale), 0);
 assert.equal(buffer.discard(batch.token, stale), 1);
 assert.equal(buffer.discard(batch.token, stale), 0);
 buffer.release(batch.token);
 const next = buffer.reserveBatch();
 assert.deepEqual(next.items.map(item => item.runId).sort(), ["done", "replaced"]);
 assert.equal(next.items.find(item => item.runId === "replaced")?.questionId, "new");
 assert.equal(buffer.discard(batch.token, next.items), 0);
 buffer.release(next.token);
 buffer.observe(epoch, question("stale", 2));
 assert.equal(buffer.reserveBatch().items.some(item => item.runId === "stale"), false, "pruning retains dedup history");
});
