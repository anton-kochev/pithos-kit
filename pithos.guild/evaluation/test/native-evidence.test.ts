import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { calculateBaseCost } from "../src/pricing.ts";
import { auditBoundChildRequests, auditBoundProducerEnvelopes, auditBoundRequestContent, auditBoundRuntimeMeters, auditBoundRuntimeObservations, auditBoundSupervisorEvidence, auditNativeEvidence } from "../src/native-evidence.ts";
import { digest } from "../src/manifest.ts";
import { validateCandidateRequestBody } from "../src/native-request.ts";
import { NATIVE_RUNTIME_PATHS } from "../src/native-input-contracts.ts";

test("binds retained supervisor bytes to trusted spawn and committed launch expectations", () => {
  const trialIdentity = { version: 1 as const, id: randomUUID(), requestDigest: digest("request") };
  const trusted = { version: 1 as const, kind: "guild-eval-supervisor-spawn" as const, trialIdentity,
    invocationDigest: digest("invocation"), configurationSha256: digest("configuration"), supervisorPid: 6, parentPid: 24 };
  const launch = { version: 1 as const, historyDigest: digest("history"), configurationSha256: trusted.configurationSha256,
    runtimeRequirementSha256: digest("runtime"), invocationDigest: trusted.invocationDigest,
    scopedAuthIdentityDigest: digest("auth"), implementationDigest: digest("implementation"), supervisorPid: trusted.supervisorPid };
  const raw = JSON.stringify(trusted) + "\n";
  const audit = auditBoundSupervisorEvidence(raw, { trialIdentity, trusted, launch });
  assert.deepEqual(audit.observation, trusted);
  assert.equal(audit.rawSha256, createHash("sha256").update(raw).digest("hex"));
  assert.ok(Object.isFrozen(audit)); assert.ok(Object.isFrozen(audit.observation)); assert.ok(Object.isFrozen(audit.observation.trialIdentity));
  for (const mutate of [
    (x: any) => x.trusted.parentPid++,
    (x: any) => x.trusted.supervisorPid++,
    (x: any) => x.trusted.trialIdentity.id = randomUUID(),
    (x: any) => x.launch.invocationDigest = digest("other"),
    (x: any) => x.launch.configurationSha256 = digest("other"),
    (x: any) => x.launch.supervisorPid++,
    (x: any) => x.raw = JSON.stringify({ ...trusted, parentPid: 25 }) + "\n",
    (x: any) => x.raw = JSON.stringify({ ...trusted, extra: true }) + "\n",
    (x: any) => x.raw = "not-json\n",
  ]) {
    const input: any = { raw, trusted: structuredClone(trusted), trialIdentity: structuredClone(trialIdentity), launch: structuredClone(launch) };
    mutate(input);
    assert.throws(() => auditBoundSupervisorEvidence(input.raw, input), /Bound supervisor evidence mismatch/);
  }
});

test("binds every candidate v2 producer row to launch, runtime and trusted process identity", () => {
  const trialIdentity = { version: 1 as const, id: randomUUID(), requestDigest: digest("request") };
  const launch = { version: 1 as const, historyDigest: digest("history"), configurationSha256: digest("configuration"),
    runtimeRequirementSha256: digest("requirement"), invocationDigest: digest("invocation"), scopedAuthIdentityDigest: digest("auth"),
    implementationDigest: digest("implementation"), supervisorPid: 6 };
  const supervisor = { version: 1 as const, kind: "guild-eval-supervisor-spawn" as const, trialIdentity,
    invocationDigest: launch.invocationDigest, configurationSha256: launch.configurationSha256, supervisorPid: 6, parentPid: 24 };
  const trialBindingDigest = digest("trial");
  const runtime = { version: 1 as const, nodePath: "/usr/bin/node", nodeVersion: "v24.20.0", platform: "linux", arch: "arm64",
    piVersion: "0.85.1", aiVersion: "0.85.1", hashes: NATIVE_RUNTIME_PATHS.map(path => ({ path, sha256: digest(path) })) };
  const requirement = { version: 1 as const, kind: "native-runtime-input-requirement" as const, trialId: trialIdentity.id,
    trialBindingDigest, runtimeDigest: digest(runtime), runtime };
  const binding = { version: 1 as const, kind: "native-campaign-input-binding" as const, trialId: trialIdentity.id,
    campaignDigest: digest("campaign"), historyDigest: launch.historyDigest, admissionDigest: digest("admission"),
    trialBindingDigest, invocationDigest: launch.invocationDigest, runtimeRequirementDigest: digest(requirement),
    runtimeRequirementSha256: launch.runtimeRequirementSha256 };
  const envelope = (pid: number, ppid: number, actor: "parent" | "child", sequence: number, event: any) => ({ version: 2, trialId: trialIdentity.id,
    configurationSha256: launch.configurationSha256, runtimeRequirementSha256: launch.runtimeRequirementSha256,
    invocationDigest: launch.invocationDigest, supervisorPid: launch.supervisorPid, pid, ppid, actor, sequence, event });
  const raw = (rows: any[]) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
  const processes = {
    "24.jsonl": raw([envelope(24, 6, "parent", 0, { type: "process_start", node: "v24.20.0", piVersion: "0.85.1",
      runtimeDigest: requirement.runtimeDigest, trialBindingDigest: binding.trialBindingDigest }), envelope(24, 6, "parent", 1, { type: "process_end", exitCode: 0 })]),
    "36.jsonl": raw([envelope(36, 24, "child", 0, { type: "process_start", node: "v24.20.0", piVersion: "0.85.1",
      runtimeDigest: requirement.runtimeDigest, trialBindingDigest: binding.trialBindingDigest }), envelope(36, 24, "child", 1, { type: "process_end", exitCode: 0 })]),
  };
  const expected = { trialIdentity, launch, supervisor, binding, requirement };
  const audit = auditBoundProducerEnvelopes(processes, expected);
  assert.deepEqual(audit.pids, [24, 36]); assert.equal(audit.files.length, 2);
  assert.deepEqual(audit.files.map(file => file.name), ["24.jsonl", "36.jsonl"]);
  for (const mutate of [
    (x: any) => x["24.jsonl"] = x["24.jsonl"].replace(launch.configurationSha256, digest("other")),
    (x: any) => x["24.jsonl"] = x["24.jsonl"].replace('"ppid":6', '"ppid":7'),
    (x: any) => x["36.jsonl"] = x["36.jsonl"].replace('"sequence":1', '"sequence":2'),
    (x: any) => x["36.jsonl"] = x["36.jsonl"].replace('"actor":"child"', '"actor":"parent"'),
    (x: any) => x["36.jsonl"] = x["36.jsonl"].replace('"exitCode":0', '"exitCode":1'),
    (x: any) => x["025.jsonl"] = x["24.jsonl"],
  ]) {
    const changed: any = structuredClone(processes); mutate(changed);
    assert.throws(() => auditBoundProducerEnvelopes(changed, expected), /Bound producer evidence mismatch/);
  }
});

const pricing = { version: 1 as const, model: "openai-codex/gpt-6-astra", api: "openai-codex-responses", serviceTier: "base" as const, cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 } };
const tools = ["bash", "edit", "find", "grep", "ls", "read", "write"];
const jsonl = (rows: any[]) => rows.map(r => JSON.stringify(r)).join("\n") + "\n";
function message(id: string, content: any[] = [{ type: "text", text: "Evidence and verification, not a fixed synthetic answer." }]) {
  const counts = { input: 7, output: 3, cacheRead: 2, cacheWrite: 1, totalTokens: 13 };
  return { role: "assistant", provider: "openai-codex", model: "gpt-6-astra", api: pricing.api, responseId: id,
    stopReason: content.some(r => r.type === "toolCall") ? "toolUse" : "stop", content, usage: { ...counts, cost: calculateBaseCost(pricing, counts) } };
}
function native(pid: number, ppid: number, target: string | null, allowed: string[], messages: any[], spawns: any[] = []) {
  const context = { type: "context", model: pricing.model, thinking: "high", target, tools: allowed, systemPromptDigest: "a".repeat(64) };
  const rows: any[] = [{ type: "process_start", node: "v24.20.0", piVersion: "0.85.1" }, context];
  messages.forEach((m, i) => {
    if (i === 1) rows.push(...spawns);
    const requestId = randomUUID(), attemptId = randomUUID();
    rows.push({ type: "request_start", requestId }, context, context,
      { type: "payload", requestId, final: { model: "gpt-6-astra", thinking: "high", serviceTier: "omitted" } },
      ...[{ type: "start" }, { type: "response", meter: { responseId: m.responseId, status: "completed", serviceTier: "default", input: 10, output: 3, total: 13, cacheRead: 2, cacheWrite: 1 } }, { type: "end", reason: "terminal" }].map(record => ({ type: "transport", requestId, record: { ...record, transport: "websocket", attemptId } })),
      { type: "request_end", requestId, complete: true });
  });
  rows.push({ type: "process_end", exitCode: 0 });
  return rows.map((r, sequence) => ({ version: 1, pid, ppid, actor: target ? "child" : "parent", sequence, ...r }));
}
function fixture(arm: "main-only" | "guild-available" = "main-only") {
  const m = message("response-parent");
  return { arm, pricing, supervisorPid: 7, parentPid: 25,
    parent: jsonl([{ type: "message_end", message: m }, { type: "agent_end" }, { type: "agent_settled" }]),
    children: jsonl([{ version: 1, type: "observer_ready" }, { version: 1, type: "observer_end" }]),
    processes: { "25.jsonl": jsonl(native(25, 7, null, [...tools, ...(arm === "guild-available" ? ["guild_handover"] : [])].sort(), [m])) } as Record<string, string> };
}

test("candidate v2 composes bound content with native context, transport and meter reconciliation", () => {
  const legacy = fixture("main-only"), prompt = "Inspect the fixture.", trialIdentity = { version: 1 as const, id: randomUUID(), requestDigest: digest("request") };
  const launch = { version: 1 as const, historyDigest: digest("history"), configurationSha256: digest("configuration"),
    runtimeRequirementSha256: digest("requirement"), invocationDigest: digest("invocation"), scopedAuthIdentityDigest: digest("auth"),
    implementationDigest: digest("implementation"), supervisorPid: legacy.supervisorPid };
  const supervisor = { version: 1 as const, kind: "guild-eval-supervisor-spawn" as const, trialIdentity,
    invocationDigest: launch.invocationDigest, configurationSha256: launch.configurationSha256,
    supervisorPid: legacy.supervisorPid, parentPid: legacy.parentPid };
  const trialBindingDigest = digest("trial"), runtime = { version: 1 as const, nodePath: "/usr/bin/node", nodeVersion: "v24.20.0",
    platform: "linux", arch: "arm64", piVersion: "0.85.1", aiVersion: "0.85.1", hashes: NATIVE_RUNTIME_PATHS.map(path => ({ path, sha256: digest(path) })) };
  const requirement = { version: 1 as const, kind: "native-runtime-input-requirement" as const, trialId: trialIdentity.id,
    trialBindingDigest, runtimeDigest: digest(runtime), runtime };
  const binding = { version: 1 as const, kind: "native-campaign-input-binding" as const, trialId: trialIdentity.id,
    campaignDigest: digest("campaign"), historyDigest: launch.historyDigest, admissionDigest: digest("admission"), trialBindingDigest,
    invocationDigest: launch.invocationDigest, runtimeRequirementDigest: digest(requirement), runtimeRequirementSha256: launch.runtimeRequirementSha256 };
  const logical = { instructions: "Approved system instructions", tools: tools.map(name => ({ type: "function", name })), input: [{ role: "user", content: prompt }] };
  const outbound = { model: "gpt-6-astra", reasoning: { effort: "high" }, ...logical };
  const selected = runtime.hashes.map((entry, i) => ({ id: i === 0 ? "runtime/node" : `runtime/file-${i}`, ...entry }));
  const observedFiles = selected.map((entry, i) => ({ id: entry.id, sha256: entry.sha256, bytes: i + 1,
    dev: String(100 + i), ino: String(200 + i), uid: 0, mode: 0o444 }));
  const runtimeObservation = { version: 1 as const, kind: "native-runtime-file-observation" as const, trialId: trialIdentity.id,
    requirementDigest: digest(requirement), process: { pid: legacy.parentPid, ppid: legacy.supervisorPid, nodeVersion: runtime.nodeVersion,
      nodePath: runtime.nodePath, platform: runtime.platform, arch: runtime.arch,
      executable: { dev: observedFiles[0].dev, ino: observedFiles[0].ino } },
    files: { version: 1 as const, kind: "native-selected-file-observation" as const, inventoryDigest: digest(selected), files: observedFiles },
    packages: [{ id: observedFiles[1].id, name: "@earendil-works/pi-coding-agent", version: runtime.piVersion },
      { id: observedFiles[10].id, name: "@earendil-works/pi-ai", version: runtime.aiVersion }] };
  const old = rows(legacy.processes[`${legacy.parentPid}.jsonl`]), events: any[] = [];
  for (const row of old) {
    const { version: _version, pid: _pid, ppid: _ppid, actor: _actor, sequence: _sequence, ...event } = row;
    if (event.type === "process_start") Object.assign(event, { runtimeDigest: requirement.runtimeDigest, trialBindingDigest });
    if (event.type === "transport" && event.record.type === "response") event.record.meter.model = "gpt-6-astra";
    events.push(event);
    if (event.type === "process_start") events.push({ type: "runtime_observation", observation: runtimeObservation });
    if (event.type === "payload") events.push({ type: "request_content", requestId: event.requestId, logical, outbound });
  }
  const processes = { [`${legacy.parentPid}.jsonl`]: jsonl(events.map((event, sequence) => ({ version: 2, trialId: trialIdentity.id,
    configurationSha256: launch.configurationSha256, runtimeRequirementSha256: launch.runtimeRequirementSha256,
    invocationDigest: launch.invocationDigest, supervisorPid: legacy.supervisorPid, pid: legacy.parentPid,
    ppid: legacy.supervisorPid, actor: "parent", sequence, event }))) };
  const request: any = { task: { id: "task-01", prompt, rubric: "PRIVATE_RUBRIC", grader: { secret: "PRIVATE_GRADER" }, delegation: { secret: "PRIVATE_DELEGATION" } },
    arm: "main-only", repetition: 1, cohort: { model: pricing.model, thinking: "high" }, timeoutMs: 300000 };
  const expected = { trialIdentity, launch, supervisor, binding, requirement, request, parent: legacy.parent, children: legacy.children, pricing };
  const audit = auditBoundRuntimeMeters(processes, expected);
  assert.equal(audit.requests, 1); assert.deepEqual(audit.usage, auditNativeEvidence(legacy).usage);
  const runtimeAudit = auditBoundRuntimeObservations(processes, expected);
  assert.equal(runtimeAudit.processes, 1); assert.equal(runtimeAudit.runtimeDigest, digest([runtimeObservation]));
  for (const mutate of [
    (x: any) => x.process.pid++,
    (x: any) => x.requirementDigest = digest("other requirement"),
    (x: any) => x.files.files[0].sha256 = digest("other file"),
    (x: any) => x.process.executable.ino = "999",
    (x: any) => x.packages[1].version = "0.85.2",
  ]) {
    const changed = rows(processes[`${legacy.parentPid}.jsonl`]), observation = changed.find(row => row.event?.type === "runtime_observation").event.observation;
    mutate(observation);
    assert.throws(() => auditBoundRuntimeObservations({ [`${legacy.parentPid}.jsonl`]: jsonl(changed) }, expected), /Bound runtime observation mismatch/);
  }
  for (const mode of ["missing", "duplicate"]) {
    const changed = rows(processes[`${legacy.parentPid}.jsonl`]), index = changed.findIndex(row => row.event?.type === "runtime_observation");
    if (mode === "missing") changed.splice(index, 1); else changed.splice(index, 0, structuredClone(changed[index]));
    changed.forEach((row, sequence) => row.sequence = sequence);
    assert.throws(() => auditBoundRuntimeObservations({ [`${legacy.parentPid}.jsonl`]: jsonl(changed) }, expected), /Bound runtime observation mismatch/);
  }
  for (const mutate of [
    (x: any[]) => x.find(row => row.event?.record?.type === "response").event.record.meter.model = null,
    (x: any[]) => x.find(row => row.event?.record?.type === "response").event.record.meter.total++,
    (x: any[]) => x.splice(x.findIndex(row => row.event?.type === "context"), 1),
  ]) {
    const changed = rows(processes[`${legacy.parentPid}.jsonl`]); mutate(changed);
    changed.forEach((row, sequence) => row.sequence = sequence);
    assert.throws(() => auditBoundRuntimeMeters({ [`${legacy.parentPid}.jsonl`]: jsonl(changed) }, expected), /Bound runtime and meter evidence mismatch/);
  }
});

test("candidate v2 request content binds logical projection, parent task and tool policy", () => {
  const prompt = "Inspect the fixture and report evidence.", trialIdentity = { version: 1 as const, id: randomUUID(), requestDigest: digest("request") };
  const launch = { version: 1 as const, historyDigest: digest("history"), configurationSha256: digest("configuration"),
    runtimeRequirementSha256: digest("requirement"), invocationDigest: digest("invocation"), scopedAuthIdentityDigest: digest("auth"),
    implementationDigest: digest("implementation"), supervisorPid: 6 };
  const supervisor = { version: 1 as const, kind: "guild-eval-supervisor-spawn" as const, trialIdentity,
    invocationDigest: launch.invocationDigest, configurationSha256: launch.configurationSha256, supervisorPid: 6, parentPid: 24 };
  const trialBindingDigest = digest("trial"), runtime = { version: 1 as const, nodePath: "/usr/bin/node", nodeVersion: "v24.20.0",
    platform: "linux", arch: "arm64", piVersion: "0.85.1", aiVersion: "0.85.1", hashes: NATIVE_RUNTIME_PATHS.map(path => ({ path, sha256: digest(path) })) };
  const requirement = { version: 1 as const, kind: "native-runtime-input-requirement" as const, trialId: trialIdentity.id,
    trialBindingDigest, runtimeDigest: digest(runtime), runtime };
  const binding = { version: 1 as const, kind: "native-campaign-input-binding" as const, trialId: trialIdentity.id,
    campaignDigest: digest("campaign"), historyDigest: launch.historyDigest, admissionDigest: digest("admission"), trialBindingDigest,
    invocationDigest: launch.invocationDigest, runtimeRequirementDigest: digest(requirement), runtimeRequirementSha256: launch.runtimeRequirementSha256 };
  const requestId = randomUUID(), continuationId = randomUUID(), handoverId = "handover-1", toolNames = [...tools, "guild_handover"];
  const logical = { instructions: "Approved system instructions", tools: toolNames.map(name => ({ type: "function", name })),
    input: [{ role: "user", content: prompt }] }, outbound = { model: "gpt-6-astra", reasoning: { effort: "high" }, ...logical };
  const continuedLogical = { ...logical, input: [...logical.input, { type: "function_call_output", call_id: handoverId, output: "Child evidence" }] };
  const continuedOutbound = { model: "gpt-6-astra", reasoning: { effort: "high" }, ...continuedLogical };
  const observed = (id: string, content: any, final: any) => [{ type: "request_start", requestId: id },
    { type: "payload", requestId: id, final: { model: "gpt-6-astra", thinking: "high", serviceTier: "omitted" } },
    { type: "request_content", requestId: id, logical: content, outbound: final }, { type: "request_end", requestId: id, complete: true }];
  const events = [{ type: "process_start", node: "v24.20.0", piVersion: "0.85.1", runtimeDigest: requirement.runtimeDigest, trialBindingDigest },
    ...observed(requestId, logical, outbound), ...observed(continuationId, continuedLogical, continuedOutbound), { type: "process_end", exitCode: 0 }];
  const envelope = (event: any, sequence: number) => ({ version: 2, trialId: trialIdentity.id, configurationSha256: launch.configurationSha256,
    runtimeRequirementSha256: launch.runtimeRequirementSha256, invocationDigest: launch.invocationDigest, supervisorPid: 6,
    pid: 24, ppid: 6, actor: "parent", sequence, event });
  const processes = { "24.jsonl": jsonl(events.map(envelope)) };
  const handover = { type: "toolCall", name: "guild_handover", id: handoverId, arguments: { role: "explorer", profile: "general", task: "Inspect." } };
  const parent = jsonl([{ type: "message_end", message: message("response-handover", [handover]) },
    { type: "tool_execution_start", toolName: "guild_handover", toolCallId: handoverId, args: handover.arguments },
    { type: "tool_execution_end", toolName: "guild_handover", toolCallId: handoverId, isError: false,
      result: { content: [{ type: "text", text: "Child evidence" }], details: { usage: { input: 1 } } } },
    { type: "message_end", message: message("response-parent") }, { type: "agent_end" }, { type: "agent_settled" }]);
  const request: any = { task: { id: "task-01", prompt, rubric: "PRIVATE_RUBRIC", grader: { secret: "PRIVATE_GRADER" }, delegation: { secret: "PRIVATE_DELEGATION" } },
    arm: "guild-available", repetition: 1, cohort: { model: pricing.model, thinking: "high" }, timeoutMs: 300000 };
  const expected = { trialIdentity, launch, supervisor, binding, requirement, request, parent };
  const audit = auditBoundRequestContent(processes, expected);
  assert.equal(audit.requests, 2); assert.equal(audit.contentDigest, digest([{ requestId, logical, outbound },
    { requestId: continuationId, logical: continuedLogical, outbound: continuedOutbound }]));
  for (const extra of [{ headers: { Authorization: "synthetic-credential" } }, { arbitrary: "synthetic-credential" }]) {
    const changed = rows(processes["24.jsonl"]);
    for (const row of changed) if (row.event.type === "request_content") Object.assign(row.event.outbound, extra);
    assert.throws(() => auditBoundRequestContent({ "24.jsonl": jsonl(changed) }, expected), { message: "Bound request content evidence mismatch" });
  }
  // Permitted schema property keys are visible content, but private object keys are not leaves.
  for (const key of ["safe_property", "prefix PRIVATE_RUBRIC suffix"]) {
    const changed = rows(processes["24.jsonl"]);
    for (const row of changed) if (row.event.type === "request_content") {
      for (const content of [row.event.logical, row.event.outbound])
        content.tools[0].parameters = { type: "object", properties: { [key]: { type: "string" } } };
      assert.doesNotThrow(() => validateCandidateRequestBody(row.event.outbound));
    }
    const privateExpected = structuredClone(expected);
    privateExpected.request.task.grader = { type: "PRIVATE_GRADER" };
    const auditKeys = () => auditBoundRequestContent({ "24.jsonl": jsonl(changed) }, privateExpected);
    if (key === "safe_property") assert.equal(auditKeys().requests, 2);
    else assert.throws(auditKeys, { message: "Bound request content evidence mismatch" });
  }
  // Short/common private leaves are deliberately not exempted. Ambiguity blocks acceptance.
  for (const leaf of ["a", "system", " "]) {
    const privateExpected = structuredClone(expected); privateExpected.request.task.rubric = leaf;
    assert.throws(() => auditBoundRequestContent(processes, privateExpected), /Bound request content evidence mismatch/);
  }
  const childId = randomUUID(), childPid = 33, childTask = "Inspect.";
  const spawn = { type: "child_spawn", childId, childPid, runId: handoverId, role: "explorer", profile: "general",
    target: "explorer/general", taskDigest: digest(childTask) };
  const parentRows = rows(processes["24.jsonl"]); parentRows.splice(-1, 0, { ...parentRows[0], sequence: parentRows.length - 1, event: spawn });
  parentRows.forEach((row, sequence) => row.sequence = sequence);
  const childLogical = { instructions: "Child instructions", tools: ["find", "grep", "ls", "read"].map(name => ({ type: "function", name })),
    input: [{ role: "user", content: `Task: ${childTask}` }] };
  const childEvents = [{ type: "process_start", node: "v24.20.0", piVersion: "0.85.1", runtimeDigest: requirement.runtimeDigest, trialBindingDigest },
    { type: "child_binding", childId, runId: handoverId, role: "explorer", profile: "general", target: "explorer/general", taskDigest: digest(childTask) },
    ...observed(randomUUID(), childLogical, { model: "gpt-6-astra", reasoning: { effort: "high" }, ...childLogical }), { type: "process_end", exitCode: 0 }];
  const childEnvelope = (event: any, sequence: number) => ({ ...envelope(event, sequence), pid: childPid, ppid: 24, actor: "child" });
  const childProcesses = { "24.jsonl": jsonl(parentRows), "33.jsonl": jsonl(childEvents.map(childEnvelope)) };
  const observedIdentity = { version: 1, childId, runId: handoverId, role: "explorer", profile: "general", taskDigest: digest(childTask) };
  const childTrace = jsonl([{ version: 1, type: "observer_ready" },
    { ...observedIdentity, type: "start", sequence: 0 },
    { ...observedIdentity, type: "stdout", sequence: 1, base64: "" },
    { ...observedIdentity, type: "end", sequence: 2, exitCode: 0, aborted: false },
    { version: 1, type: "observer_end" }]);
  const childAudit = auditBoundChildRequests(childProcesses, { ...expected, children: childTrace });
  assert.equal(childAudit.children, 1);
  for (const mutate of [
    (x: any) => x["33.jsonl"] = x["33.jsonl"].replace('"runId":"handover-1"', '"runId":"other-run"'),
    (x: any) => x["33.jsonl"] = x["33.jsonl"].replace('"name":"read"', '"name":"bash"'),
    (x: any) => x["33.jsonl"] = x["33.jsonl"].replace(digest(childTask), digest("other task")),
  ]) { const changed = structuredClone(childProcesses); mutate(changed);
    assert.throws(() => auditBoundChildRequests(changed, { ...expected, children: childTrace }), /Bound child request evidence mismatch/); }
  for (const mutate of [
    (x: any) => x["24.jsonl"] = x["24.jsonl"].replace(prompt, "different task"),
    (x: any) => x["24.jsonl"] = x["24.jsonl"].replace('"name":"read"', '"name":"unknown_tool"'),
    (x: any) => x["24.jsonl"] = x["24.jsonl"].replaceAll("Approved system instructions", "prefix PRIVATE_RUBRIC suffix"),
    (x: any) => x["24.jsonl"] = x["24.jsonl"].replaceAll("Approved system instructions", "PRIVATE_RUBRIC"),
    (x: any) => x["24.jsonl"] = x["24.jsonl"].replaceAll("Approved system instructions", "PRIVATE_GRADER"),
    (x: any) => x["24.jsonl"] = x["24.jsonl"].replaceAll("Approved system instructions", "PRIVATE_DELEGATION"),
    (x: any) => x["24.jsonl"] = x["24.jsonl"].replaceAll("Child evidence", "substituted child result"),
    (x: any) => x["24.jsonl"] = x["24.jsonl"].replace('"type":"request_content"', '"type":"missing_content"'),
  ]) {
    const changed = structuredClone(processes); mutate(changed);
    assert.throws(() => auditBoundRequestContent(changed, expected), /Bound request content evidence mismatch/);
  }
});

function delegated(role: string, profile: string, childPid = 33) {
  const e = fixture("guild-available"), childId = randomUUID();
  const call = { type: "toolCall", name: "guild_handover", id: `delegated-${childPid}`, arguments: { role, profile, task: "Inspect the isolated fixture and report evidence." } };
  const action = { type: "toolCall", name: role === "coder" ? "write" : "read", id: "child-action", arguments: { path: "example.txt", ...(role === "coder" ? { content: "Fixture update\n" } : {}) } };
  const parentMessages = [message("parent-delegates", [call]), message("parent-synthesis")];
  const childMessages = [message(`child-${childPid}-investigates`, [action]), message(`child-${childPid}-report`)];
  const execution = (c: typeof call | typeof action, result: any = { content: [{ type: "text", text: "Task evidence" }] }) => [
    { type: "tool_execution_start", toolName: c.name, toolCallId: c.id, args: c.arguments },
    { type: "tool_execution_end", toolName: c.name, toolCallId: c.id, isError: false, result }];
  const ends = [{ type: "agent_end" }, { type: "agent_settled" }];
  const child = [{ type: "message_end", message: childMessages[0] }, ...execution(action), { type: "message_end", message: childMessages[1] }, ...ends];
  const usage = { input: 14, output: 6, cacheRead: 4, cacheWrite: 2, cost: childMessages[0].usage.cost.total * 2 };
  e.parent = jsonl([{ type: "message_end", message: parentMessages[0] }, ...execution(call, { content: [{ type: "text", text: "Task evidence" }], details: { usage } }), { type: "message_end", message: parentMessages[1] }, ...ends]);
  const identity = { version: 1, childId, runId: call.id, role, profile };
  e.children = jsonl([{ version: 1, type: "observer_ready" }, { ...identity, type: "start", sequence: 0 },
    { ...identity, type: "stdout", sequence: 1, base64: Buffer.from(jsonl(child)).toString("base64") },
    { ...identity, type: "end", sequence: 2, exitCode: 0, aborted: false }, { version: 1, type: "observer_end" }]);
  e.processes["25.jsonl"] = jsonl(native(25, 7, null, [...tools, "guild_handover"].sort(), parentMessages, [{ type: "child_spawn", childId, childPid }]));
  e.processes[`${childPid}.jsonl`] = jsonl(native(childPid, 25, `${role}/${profile}`, role === "coder" ? tools : ["find", "grep", "ls", "read"], childMessages));
  return e;
}

const rows = (raw: string) => raw.trim().split("\n").map(line => JSON.parse(line));
function changeChild(e: ReturnType<typeof fixture>, change: (events: any[]) => any[]) {
  const observed = rows(e.children), r = observed.find(r => r.type === "stdout");
  r.base64 = Buffer.from(jsonl(change(rows(Buffer.from(r.base64, "base64").toString("utf8"))))).toString("base64"); e.children = jsonl(observed);
}

test("native audit requires declared, allowed and completed tool calls, but permits recovered tool errors", () => {
  const recovered = delegated("coder", "typescript");
  changeChild(recovered, events => { events.find(r => r.type === "tool_execution_end").isError = true; return events; });
  assert.equal(auditNativeEvidence(recovered).requests, 4);
  for (const change of [
    (events: any[]) => events.filter(r => !r.type.startsWith("tool_execution")),
    (events: any[]) => { events[0].message.content[0].id = "not-executed"; return events; },
    (events: any[]) => { for (const r of events) { if (r.toolName) r.toolName = "guild_handover"; if (r.message?.content?.[0].type === "toolCall") r.message.content[0].name = "guild_handover"; } return events; },
    (events: any[]) => { events.find(r => r.type === "tool_execution_start").args = { path: "different-task.txt" }; return events; },
    (events: any[]) => { events.splice(2, 0, events[1]); return events; },
    (events: any[]) => { events.push(events.find(r => r.type === "tool_execution_end")); return events; },
    (events: any[]) => { events.unshift(events.pop()); return events; },
  ]) { const e = delegated("reviewer", "rust"); changeChild(e, change); assert.throws(() => auditNativeEvidence(e), /Native evidence mismatch/); }
  const e = delegated("architect", "dotnet"), parent = rows(e.parent);
  parent[0].message.content[0].id = "unexecuted-parent-call"; e.parent = jsonl(parent);
  assert.throws(() => auditNativeEvidence(e), /Native evidence mismatch/);
});

test("native audit rejects reused or missing request, attempt and response identities across producers", () => {
  for (const kind of ["request", "attempt", "response", "missing-request"]) {
    const e = delegated("explorer", "general"), parent = rows(e.processes["25.jsonl"]), child = rows(e.processes["33.jsonl"]);
    if (kind === "request" || kind === "missing-request") {
      const old = child.find(r => r.type === "request_start").requestId, replacement = kind === "request" ? parent.find(r => r.type === "request_start").requestId : undefined;
      for (const r of child) if (r.requestId === old) r.requestId = replacement;
    } else if (kind === "attempt") {
      const old = child.find(r => r.type === "transport").record.attemptId, replacement = parent.find(r => r.type === "transport").record.attemptId;
      for (const r of child) if (r.record?.attemptId === old) r.record.attemptId = replacement;
    } else {
      const meter = child.find(r => r.record?.type === "response").record.meter;
      meter.responseId = parent.find(r => r.record?.type === "response").record.meter.responseId;
      changeChild(e, events => { events[0].message.responseId = meter.responseId; return events; });
    }
    e.processes["33.jsonl"] = jsonl(child);
    assert.throws(() => auditNativeEvidence(e), /Native evidence mismatch/, kind);
  }
});

function paired() {
  const a = delegated("explorer", "typescript"), b = delegated("coder", "dotnet", 34), parent = rows(a.parent), second = rows(b.parent);
  parent[0].message.content.push(second[0].message.content[0]); parent.splice(3, 0, second[1], second[2]); a.parent = jsonl(parent);
  a.children = jsonl([...rows(a.children).slice(0, -1), ...rows(b.children).slice(1)]);
  const spawns = [a, b].flatMap(e => rows(e.processes["25.jsonl"]).filter(r => r.type === "child_spawn").map(r => ({ type: r.type, childId: r.childId, childPid: r.childPid })));
  a.processes["25.jsonl"] = jsonl(native(25, 7, null, [...tools, "guild_handover"].sort(), parent.filter(r => r.type === "message_end").map(r => r.message), spawns));
  a.processes["34.jsonl"] = b.processes["34.jsonl"];
  return a;
}

test("native audit reconciles each serialized handover, not merely its grand total", () => {
  assert.equal(auditNativeEvidence(paired()).requests, 6);
  for (const kind of ["shifted-usage", "overlap", "early-spawn", "reordered-spawns"]) {
    const e = paired();
    if (kind === "shifted-usage") {
      const p = rows(e.parent), ends = p.filter(r => r.type === "tool_execution_end");
      ends[1].result.details.usage.cost += ends[0].result.details.usage.cost; ends[0].result.details.usage.cost = 0; e.parent = jsonl(p);
    } else if (kind === "overlap") {
      const o = rows(e.children), i = o.findIndex(r => r.type === "start" && r.role === "coder");
      o.splice(2, 0, o.splice(i, 1)[0]); e.children = jsonl(o);
    } else {
      const p = rows(e.processes["25.jsonl"]), i = p.findIndex(r => r.type === "child_spawn");
      if (kind === "early-spawn") p.splice(2, 0, p.splice(i, 1)[0]); else [p[i], p[i + 1]] = [p[i + 1], p[i]];
      e.processes["25.jsonl"] = jsonl(p.map((r, sequence) => ({ ...r, sequence })));
    }
    assert.throws(() => auditNativeEvidence(e), /Native evidence mismatch/, kind);
  }
});

test("native audit bounds raw bytes, line counts and producer inventory before reconciliation", () => {
  for (const change of [
    (e: ReturnType<typeof fixture>) => e.parent += "\n".repeat(65537),
    (e: ReturnType<typeof fixture>) => e.parent += " ".repeat(16 * 1024 * 1024),
    (e: ReturnType<typeof fixture>) => e.processes["25.jsonl"] += " ".repeat(16 * 1024 * 1024),
    (e: ReturnType<typeof fixture>) => { for (let i = 100; i < 165; i++) e.processes[`${i}.jsonl`] = ""; },
  ]) { const e = fixture(); change(e); assert.throws(() => auditNativeEvidence(e), /Native evidence mismatch/); }
});

// Existing-state rejection pins: each mutation is applied only to an inert fixture.
test("native audit rejects producer, lifecycle, context, payload and meter drift", () => {
  for (const [name, change] of Object.entries({
    ancestry: (p: any[]) => { p.forEach(r => r.ppid = 7); return p; },
    sequence: (p: any[]) => { p[1].sequence++; return p; },
    node: (p: any[]) => { p[0].node = "v24.19.0"; return p; },
    sdk: (p: any[]) => { p[0].piVersion = "0.83.0"; return p; },
    target: (p: any[]) => { p[1].target = "coder/general"; return p; },
    tools: (p: any[]) => { p[1].tools.push("bash"); return p; },
    model: (p: any[]) => { p[1].model = "openai-codex/other"; return p; },
    thinking: (p: any[]) => { p[1].thinking = "medium"; return p; },
    prompt: (p: any[]) => { p[3].systemPromptDigest = "b".repeat(64); return p; },
    payload: (p: any[]) => { p.find(r => r.type === "payload").final.serviceTier = "priority"; return p; },
    orphan: (p: any[]) => { p.find(r => r.type === "transport").requestId = null; return p; },
    failed: (p: any[]) => { p.find(r => r.type === "request_end").complete = false; return p; },
    missingMeter: (p: any[]) => { p.find(r => r.record?.type === "response").record.meter.cacheWrite = null; return p; },
    responseTier: (p: any[]) => { p.find(r => r.record?.type === "response").record.meter.serviceTier = "flex"; return p; },
    missingFooter: (p: any[]) => p.slice(0, -1),
    failedExit: (p: any[]) => { p.at(-1).exitCode = 1; return p; },
    extraRequest: (p: any[]) => { p.splice(-1, 0, { ...p[2], requestId: randomUUID() }); return p.map((r, sequence) => ({ ...r, sequence })); },
  })) {
    const e = delegated("reviewer", "general"); e.processes["33.jsonl"] = jsonl(change(rows(e.processes["33.jsonl"])));
    assert.throws(() => auditNativeEvidence(e), /Native evidence mismatch/, name);
  }
  for (const kind of ["missing", "extra", "unsafe-name"]) {
    const e = delegated("reviewer", "general");
    if (kind === "missing") delete e.processes["33.jsonl"]; else e.processes[kind === "extra" ? "99.jsonl" : "../33.jsonl"] = e.processes["33.jsonl"];
    assert.throws(() => auditNativeEvidence(e), /Native evidence mismatch/, kind);
  }
});

test("native audit accepts completed SSE terminal cleanup and binds exact retained bytes", () => {
  const e = fixture(), before = auditNativeEvidence(e).evidenceDigest, p = rows(e.processes["25.jsonl"]);
  for (const r of p) if (r.type === "transport") { r.record.transport = "sse"; if (r.record.type === "end") r.record.reason = "cancelled"; }
  e.processes["25.jsonl"] = jsonl(p);
  const result = auditNativeEvidence(e); assert.equal(result.requests, 1); assert.notEqual(result.evidenceDigest, before);
  e.processes["25.jsonl"] += "\n";
  assert.notEqual(auditNativeEvidence(e).evidenceDigest, result.evidenceDigest);
});

test("native audit has a closed input contract and does not substitute missing observation", () => {
  assert.throws(() => auditNativeEvidence({ ...fixture(), unbound: "metadata outside the audit contract" } as any), /Native evidence mismatch/);
  for (const children of [undefined, "", "\n"]) assert.throws(() => auditNativeEvidence({ ...fixture(), children } as any), /Native evidence mismatch/);
});

test("native audit requires tool completion before the next assistant attempt", () => {
  const e = delegated("coder", "typescript");
  changeChild(e, events => [events[0], events[3], events[1], events[2], ...events.slice(4)]);
  assert.throws(() => auditNativeEvidence(e), /Native evidence mismatch/);
});

test("native audit supports all canonical roles/profiles and multi-turn child tool workflows", () => {
  for (const role of ["explorer", "architect", "coder", "reviewer"]) for (const profile of ["general", "frontend", "angular", "typescript", "dotnet", "rust"]) {
    const result = auditNativeEvidence(delegated(role, profile));
    assert.equal(result.processes, 2); assert.equal(result.requests, 4); assert.deepEqual(result.targets, [`${role}/${profile}`]);
  }
});

test("native audit accepts multi-turn parent verification without forced delegation", () => {
  for (const arm of ["main-only", "guild-available"] as const) {
    const e = fixture(arm), call = { type: "toolCall", name: "bash", id: "verify", arguments: { command: "npm test" } };
    const messages = [message("response-check", [call]), message("response-synthesis")];
    e.parent = jsonl([{ type: "message_end", message: messages[0] },
      { type: "tool_execution_start", toolName: "bash", toolCallId: call.id, args: call.arguments },
      { type: "tool_execution_end", toolName: "bash", toolCallId: call.id, isError: true, result: { content: [{ type: "text", text: "Inert expected failing test output" }] } },
      { type: "message_end", message: messages[1] }, { type: "agent_end" }, { type: "agent_settled" }]);
    const p = native(25, 7, null, [...tools, ...(arm === "guild-available" ? ["guild_handover"] : [])].sort(), messages);
    e.processes["25.jsonl"] = jsonl(p);
    assert.equal(auditNativeEvidence(e).requests, 2); assert.equal(auditNativeEvidence(e).processes, 1);
    p.find(r => r.type === "request_end").complete = false; e.processes["25.jsonl"] = jsonl(p);
    assert.throws(() => auditNativeEvidence(e), /Native evidence mismatch/);
  }
});

test("native audit accepts main-only and natural Guild abstention without fixed response text", () => {
  for (const arm of ["main-only", "guild-available"] as const) {
    const result = auditNativeEvidence(fixture(arm));
    assert.equal(result.processes, 1); assert.equal(result.requests, 1); assert.deepEqual(result.targets, []);
    assert.equal(result.usage.cost, 0.00023450000000000004); assert.match(result.evidenceDigest, /^[a-f0-9]{64}$/);
  }
});
