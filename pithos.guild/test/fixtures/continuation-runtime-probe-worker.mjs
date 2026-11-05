import assert from "node:assert/strict";
import {terminalsAfterCleanup, noticeNotCollection} from "./continuation-runtime-probe-terminal-cases.mjs";
import {createHarness, deferred, bounded, tick, result, log} from "./continuation-runtime-probe-harness.mjs";
async function questionsOneBatch() {
  const questions = deferred(), cleanup = deferred();
  const launched = [], replies = [];
  const h = await createHarness("questions-one-batch", {runner: async options => {
    launched.push(options);
    await questions.promise;
    try { replies.push({runId: options.runId, reply: await options.onQuestion(`Question ${options.task}?`, options.signal)}); }
    finally { await cleanup.promise; }
    return result(options);
  }});
  const {session, control, state} = h;
  const publicTool = (_session, _control, name, args) => h.tool(name, args);
  try {
    for (let i = 0; i < 3; i++) {
      const admitted = await publicTool(session, control, "guild_start", {role: "reviewer", profile: "general", task: `child-${i}`});
      assert.equal(admitted.isError, false);
    }
    assert.equal(launched.length, 3);
    let preparations = 0;
    control.beforeAgent = async event => {
      if (event.messageType === "custom" && event.message.customType === "pi-parent-continuation") preparations++;
      else { questions.resolve(); await tick(); }
    };
    await bounded(h.prompt("release questions while native turn busy"), "release turn");
    await tick();
    await bounded(session.waitForIdle(), "owned settlement");
    const notices = session.sessionManager.getEntries().filter(e => e.type === "custom_message" && e.customType === "pi-parent-continuation");
    assert.equal(notices.length, 1, "three questions must produce one native historical notice");
    assert.equal(state.autoResponses, 1, "C01 requires one actual owned AUTO response after three child questions");
    assert.equal(control.accepted.length, 1, "one real accepted public capability batch");
    assert.equal(control.accepted[0].content, notices[0].content);
    assert.equal(preparations, 1);
    assert.equal(state.ownedStarts, 1);
    const batch = JSON.parse(notices[0].content);
    assert.equal(batch.items.length, 3);
    assert.deepEqual(batch.items.map(item => item.runId).sort(), launched.map(options => options.runId).sort());
    for (const item of batch.items) {
      assert.equal(item.kind, "question");
      assert.equal(typeof item.questionId, "string");
      const wrong = await publicTool(session, control, "guild_send", {runId: item.runId, questionId: "wrong", message: "wrong"});
      assert.equal(wrong.isError, true);
      const sent = await publicTool(session, control, "guild_send", {runId: item.runId, questionId: item.questionId, message: `reply:${item.questionId}`});
      assert.equal(sent.isError, false);
    }
    assert.equal(launched.length, 3, "replies resume original runners");
    assert.equal(replies.length, 3);
    assert.deepEqual(replies.sort((a,b) => a.runId.localeCompare(b.runId)), batch.items.map(item => ({runId: item.runId, reply: `reply:${item.questionId}`})).sort((a,b) => a.runId.localeCompare(b.runId)));
    assert.equal(session.sessionManager.getEntries().filter(e => e.type === "custom" && e.data?.kind === "collected").length, 0);
    assert.equal(session.getSessionStats().tokens.total, 0);
    assert.equal(session.getSessionStats().cost, 0);
    assert.equal(state.autoResponses, 1);
    log({phase: "observed", case: "questions-one-batch", launches: launched.length, replies: replies.length, notices: notices.length, preparations, ownedStarts: state.ownedStarts, autoResponses: state.autoResponses});
  } finally {
    questions.resolve(); cleanup.resolve();
    await h.dispose();
  }
}

const caseNames = ['questions-one-batch', 'terminals-after-cleanup', 'notice-not-collection', 'foreign-delivery', 'accepted-escape', 'preparing-escape', 'committed-message-start', 'committed-message-end', 'started-escape-capacity', 'required-plan-guild-first', 'required-plan-plan-first', 'tree-held-wake', 'reload-held-wake', 'shutdown-held-wake', 'fresh-input-only', 'nonjoining-close'];
const focused = process.argv.length === 5 && process.argv[3] === "--case";
const selected = focused ? [process.argv[4]] : caseNames;
assert.ok(process.argv.length === 3 || focused);
assert.ok(selected.every(name => caseNames.includes(name)));
let passed = 0;
for (const name of selected) {
  let failure;
  try {
    const cases = {"questions-one-batch": questionsOneBatch, "terminals-after-cleanup": terminalsAfterCleanup, "notice-not-collection": noticeNotCollection};
    if (cases[name]) await cases[name]();
    else if (["accepted-escape", "preparing-escape", "committed-message-start", "committed-message-end", "nonjoining-close"].includes(name)) {
      const {runInterruptCase} = await import("./continuation-runtime-probe-interrupt-cases.mjs");
      await runInterruptCase(name);
    } else if (["started-escape-capacity", "required-plan-guild-first", "required-plan-plan-first", "fresh-input-only"].includes(name)) {
      const {runPlanCapacityCase} = await import("./continuation-runtime-probe-plan-capacity-cases.mjs");
      await runPlanCapacityCase(name);
    } else {
      const {runNavigationInputCase} = await import("./continuation-runtime-probe-navigation-input-cases.mjs");
      await runNavigationInputCase(name);
    }
  } catch (error) { failure = String(error.message).slice(0, 512); }
  log({phase: "case", case: name, status: failure ? "failed" : "passed", ...(failure ? {failure} : {})});
  if (!failure) passed++;
}
log({phase: "summary", passed, total: selected.length, failed: selected.length - passed,
  qualified: !focused && passed === 16, manifestTotal: 16});
if (passed !== selected.length) process.exitCode = 1;
