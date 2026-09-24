// Provider-free reconciliation of cooperative native records, not execution or
// authentication attestation. Receipt/launch binding is a separate boundary.
import { createHash } from "node:crypto";
import { isDeepStrictEqual as same } from "node:util";
import { digest } from "./manifest.ts";
import { validateCandidateRequestBody } from "./native-request.ts";
import { analyzeTrace } from "./trace.ts";
import { validateBasePricing, type BasePricing } from "./pricing.ts";
import { verifyResponseMeters } from "./response-observer.ts";
import type { PreparedLaunch } from "./campaign.ts";
import { freezeRequirement, validateNativeLaunchBinding, type NativeLaunchBinding, type NativeRuntimeRequirement } from "./native-input-contracts.ts";
import type { Arm, SupervisorSpawnObservation, TrialIdentity, TrialRequest } from "./runner.ts";

interface BoundSupervisorExpected {
  trialIdentity: TrialIdentity;
  trusted: SupervisorSpawnObservation;
  launch: PreparedLaunch;
}
export function auditBoundSupervisorEvidence(raw: string, expected: BoundSupervisorExpected) {
  try {
    check(typeof raw === "string" && Buffer.byteLength(raw) <= 64 * 1024
      && Buffer.from(raw, "utf8").toString("utf8") === raw);
    check(expected && same(Object.keys(expected).sort(), ["launch", "trialIdentity", "trusted"]));
    const observation = JSON.parse(raw);
    check(observation && same(Object.keys(observation).sort(), ["configurationSha256", "invocationDigest", "kind", "parentPid", "supervisorPid", "trialIdentity", "version"]));
    check(observation.version === 1 && observation.kind === "guild-eval-supervisor-spawn"
      && same(observation, expected.trusted) && same(observation.trialIdentity, expected.trialIdentity)
      && observation.invocationDigest === expected.launch.invocationDigest
      && observation.configurationSha256 === expected.launch.configurationSha256
      && observation.supervisorPid === expected.launch.supervisorPid
      && pid(observation.supervisorPid) && pid(observation.parentPid) && observation.parentPid !== observation.supervisorPid);
    const freeze = (value: any): void => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } };
    const result = { version: 1 as const, observation, rawSha256: createHash("sha256").update(raw).digest("hex") };
    freeze(result);
    return result;
  } catch { throw new Error("Bound supervisor evidence mismatch"); }
}

interface BoundProducerExpected {
  trialIdentity: TrialIdentity;
  launch: PreparedLaunch;
  supervisor: SupervisorSpawnObservation;
  binding: NativeLaunchBinding;
  requirement: NativeRuntimeRequirement;
}
export function auditBoundProducerEnvelopes(processes: Record<string, string>, expected: BoundProducerExpected) {
  try {
    check(expected && same(Object.keys(expected).sort(), ["binding", "launch", "requirement", "supervisor", "trialIdentity"]));
    const binding = validateNativeLaunchBinding(expected.binding), requirement = freezeRequirement(expected.requirement);
    const { launch, supervisor, trialIdentity } = expected;
    check(same(supervisor.trialIdentity, trialIdentity) && supervisor.parentPid !== supervisor.supervisorPid
      && binding.trialId === trialIdentity.id && requirement.trialId === trialIdentity.id
      && binding.historyDigest === launch.historyDigest && binding.invocationDigest === launch.invocationDigest
      && binding.runtimeRequirementDigest === digest(requirement) && binding.runtimeRequirementSha256 === launch.runtimeRequirementSha256
      && requirement.trialBindingDigest === binding.trialBindingDigest
      && supervisor.invocationDigest === launch.invocationDigest && supervisor.configurationSha256 === launch.configurationSha256
      && supervisor.supervisorPid === launch.supervisorPid);
    check(processes && typeof processes === "object" && !Array.isArray(processes)
      && (Object.getPrototypeOf(processes) === Object.prototype || Object.getPrototypeOf(processes) === null));
    const entries = Object.entries(processes); check(entries.length >= 1 && entries.length <= 64);
    const pids = new Set<number>(), files: { name: string; rawSha256: string }[] = [];
    let total = 0;
    for (const [name, raw] of entries) {
      check(/^[1-9][0-9]{0,9}\.jsonl$/.test(name) && typeof raw === "string"
        && Buffer.from(raw, "utf8").toString("utf8") === raw);
      const producerPid = Number(name.slice(0, -6));
      check(pid(producerPid) && !pids.has(producerPid)); pids.add(producerPid);
      const bytes = Buffer.byteLength(raw); total += bytes; check(bytes <= MAX_BYTES && total <= MAX_BYTES);
      const source = raw.split("\n"); check(source.at(-1) === ""); source.pop();
      check(source.length >= 2 && source.length <= 65536 && source.every(line => line.length > 0));
      const rows = source.map(line => JSON.parse(line));
      for (const [sequence, row] of rows.entries()) {
        check(row && same(Object.keys(row).sort(), ["actor", "configurationSha256", "event", "invocationDigest", "pid", "ppid", "runtimeRequirementSha256", "sequence", "supervisorPid", "trialId", "version"]));
        const parent = producerPid === supervisor.parentPid;
        check(row.version === 2 && row.trialId === trialIdentity.id
          && row.configurationSha256 === launch.configurationSha256 && row.runtimeRequirementSha256 === launch.runtimeRequirementSha256
          && row.invocationDigest === launch.invocationDigest && row.supervisorPid === launch.supervisorPid
          && row.pid === producerPid && row.ppid === (parent ? supervisor.supervisorPid : supervisor.parentPid)
          && row.actor === (parent ? "parent" : "child") && row.sequence === sequence
          && row.event && typeof row.event === "object" && !Array.isArray(row.event) && typeof row.event.type === "string");
      }
      const start = rows[0].event, end = rows.at(-1).event;
      check(same(Object.keys(start).sort(), ["node", "piVersion", "runtimeDigest", "trialBindingDigest", "type"])
        && start.type === "process_start" && start.node === "v24.20.0" && start.piVersion === requirement.runtime.piVersion
        && start.runtimeDigest === requirement.runtimeDigest && start.trialBindingDigest === binding.trialBindingDigest
        && same(Object.keys(end).sort(), ["exitCode", "type"]) && end.type === "process_end" && end.exitCode === 0);
      files.push({ name, rawSha256: createHash("sha256").update(raw).digest("hex") });
    }
    check(pids.has(supervisor.parentPid));
    files.sort((a, b) => a.name.localeCompare(b.name));
    const result = { version: 2 as const, pids: [...pids].sort((a, b) => a - b), files, inventoryDigest: digest(files) };
    const freeze = (value: any): void => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } };
    freeze(result); return result;
  } catch { throw new Error("Bound producer evidence mismatch"); }
}

interface BoundRequestExpected extends BoundProducerExpected { request: TrialRequest; parent: string }
export function auditBoundRequestContent(processes: Record<string, string>, expected: BoundRequestExpected) {
  try {
    check(expected && same(Object.keys(expected).sort(), ["binding", "launch", "parent", "request", "requirement", "supervisor", "trialIdentity"]));
    const producer = auditBoundProducerEnvelopes(processes, { trialIdentity: expected.trialIdentity, launch: expected.launch,
      supervisor: expected.supervisor, binding: expected.binding, requirement: expected.requirement });
    bounded(expected.parent);
    const parentEvents = lines(expected.parent), parentMessages = assistants(parentEvents);
    const expectedParentTools = [...tools, ...(expected.request.arm === "guild-available" ? ["guild_handover"] : [])].sort();
    const ids = new Set<string>(), retained: { requestId: string; logical: any; outbound: any }[] = [];
    const parentContent: { requestId: string; logical: any; outbound: any }[] = [];
    let parentRequests = 0;
    const strings = (value: any, found: string[] = [], includeKeys = false): string[] => {
      if (typeof value === "string") found.push(value);
      else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) {
        if (includeKeys && !Array.isArray(value)) found.push(key);
        strings(child, found, includeKeys);
      }
      return found;
    };
    const privateStrings = [expected.request.task.rubric, expected.request.task.grader, expected.request.task.delegation]
      .flatMap(value => strings(value)).filter(value => value.length > 0);
    const contains = (value: any, needle: any): boolean => {
      if (needle === undefined || needle === null) return false;
      if (same(value, needle)) return true;
      return Boolean(value && typeof value === "object" && Object.values(value).some(child => contains(child, needle)));
    };
    for (const file of producer.files) {
      const rows = lines(processes[file.name]), processPid = Number(file.name.slice(0, -6));
      let active: { requestId: string; payload?: any; content?: any } | undefined;
      for (const row of rows) {
        const event = row.event;
        if (event.type === "request_start") {
          check(!active && same(Object.keys(event).sort(), ["requestId", "type"])
            && typeof event.requestId === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(event.requestId)
            && !ids.has(event.requestId));
          ids.add(event.requestId); active = { requestId: event.requestId };
        } else if (event.type === "payload") {
          check(active && !active.payload && event.requestId === active.requestId
            && same(Object.keys(event).sort(), ["final", "requestId", "type"]));
          active.payload = event;
        } else if (event.type === "request_content") {
          check(active && active.payload && !active.content && event.requestId === active.requestId
            && same(Object.keys(event).sort(), ["logical", "outbound", "requestId", "type"]));
          const logical = event.logical, outbound = event.outbound;
          validateCandidateRequestBody(outbound);
          check(logical && same(Object.keys(logical).sort(), ["input", "instructions", "tools"])
            && outbound && typeof outbound === "object" && !Array.isArray(outbound)
            && same(logical, { instructions: outbound.instructions, tools: outbound.tools, input: outbound.input })
            && outbound.model === "gpt-6-astra" && outbound.reasoning?.effort === "high"
            && (outbound.service_tier === undefined || outbound.service_tier === "default")
            && active.payload.final?.model === "gpt-6-astra" && active.payload.final?.thinking === "high"
            && active.payload.final?.serviceTier === (outbound.service_tier === undefined ? "omitted" : "default"));
          const names = Array.isArray(logical.tools) ? logical.tools.map((tool: any) => tool?.name ?? tool?.function?.name) : [];
          check(names.every((name: unknown) => typeof name === "string") && new Set(names).size === names.length);
          if (processPid === expected.supervisor.parentPid) check(same([...names].sort(), expectedParentTools));
          for (const privateValue of [expected.request.task.rubric, expected.request.task.grader, expected.request.task.delegation])
            check(!contains(logical, privateValue) && !contains(outbound, privateValue));
          // Visible JSON property names can disclose leaves too; expected private
          // leaf extraction above remains value-only.
          const visibleStrings = [...strings(logical, [], true), ...strings(outbound, [], true)];
          // No short/common-leaf exemption: ambiguous matches block candidate
          // acceptance rather than silently permitting private input disclosure.
          check(privateStrings.every(value => visibleStrings.every(text => !text.includes(value))));
          active.content = event;
        } else if (event.type === "request_end") {
          check(active && active.payload && active.content && event.requestId === active.requestId && event.complete === true
            && same(Object.keys(event).sort(), ["complete", "requestId", "type"]));
          const { requestId, logical, outbound } = active.content;
          const record = { requestId, logical, outbound };
          retained.push(record);
          if (processPid === expected.supervisor.parentPid) { parentRequests++; parentContent.push(record); }
          active = undefined;
        }
      }
      check(!active);
    }
    check(parentRequests === parentMessages.length && parentRequests >= 1);
    check(strings(parentContent[0].logical.input).filter(value => value === expected.request.task.prompt).length === 1);
    const handovers = new Map<string, { turn: number; result?: any }>();
    let turn = -1;
    for (const event of parentEvents) {
      if (event.type === "message_end" && event.message?.role === "assistant") {
        turn++;
        for (const item of event.message.content ?? []) if (item.type === "toolCall" && item.name === "guild_handover") {
          check(typeof item.id === "string" && !handovers.has(item.id)); handovers.set(item.id, { turn });
        }
      }
      if (event.type === "tool_execution_end" && event.toolName === "guild_handover") {
        const handover = handovers.get(event.toolCallId);
        check(handover && handover.result === undefined && event.isError === false); handover.result = event.result;
      }
    }
    for (const [callId, handover] of handovers) {
      check(handover.result && handover.turn + 1 < parentContent.length && Array.isArray(handover.result.content));
      const visible = handover.result.content.filter((item: any) => item?.type === "text").map((item: any) => item.text);
      check(visible.length === 1 && typeof visible[0] === "string");
      const outputs: any[] = [];
      const findOutputs = (value: any): void => {
        if (value && typeof value === "object") {
          if (value.type === "function_call_output" && value.call_id === callId) outputs.push(value);
          for (const child of Object.values(value)) findOutputs(child);
        }
      };
      findOutputs(parentContent[handover.turn + 1].logical.input);
      check(outputs.length === 1 && outputs[0].output === visible[0]);
    }
    const result = { version: 2 as const, requests: retained.length, contentDigest: digest(retained) };
    const freeze = (value: any): void => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } };
    freeze(result); return result;
  } catch { throw new Error("Bound request content evidence mismatch"); }
}

interface BoundChildExpected extends BoundRequestExpected { children: string }
export function auditBoundChildRequests(processes: Record<string, string>, expected: BoundChildExpected) {
  try {
    auditBoundRequestContent(processes, { trialIdentity: expected.trialIdentity, launch: expected.launch, supervisor: expected.supervisor,
      binding: expected.binding, requirement: expected.requirement, request: expected.request, parent: expected.parent });
    const observed = lines(expected.children), runs = new Map<string, any>(); let active: string | undefined;
    check(observed.length >= 2 && same(observed[0], { version: 1, type: "observer_ready" })
      && same(observed.at(-1), { version: 1, type: "observer_end" }));
    for (const event of observed.slice(1, -1)) {
      check(event && event.version === 1 && typeof event.childId === "string"
        && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(event.childId)
        && typeof event.runId === "string" && event.runId.length >= 1 && event.runId.length <= 1024
        && /^(explorer|architect|coder|reviewer)$/.test(event.role) && /^(general|frontend|angular|typescript|dotnet|rust)$/.test(event.profile)
        && typeof event.taskDigest === "string" && /^[a-f0-9]{64}$/.test(event.taskDigest) && Number.isSafeInteger(event.sequence));
      if (event.type === "start") {
        check(!active && !runs.has(event.childId) && event.sequence === 0
          && same(Object.keys(event).sort(), ["childId", "profile", "role", "runId", "sequence", "taskDigest", "type", "version"]));
        active = event.childId; runs.set(event.childId, { childId: event.childId, runId: event.runId, role: event.role,
          profile: event.profile, taskDigest: event.taskDigest, events: [event] });
      } else {
        const run = runs.get(event.childId); check(active === event.childId && run && event.runId === run.runId
          && event.role === run.role && event.profile === run.profile && event.taskDigest === run.taskDigest && event.sequence === run.events.length);
        run.events.push(event);
        if (event.type === "end") {
          check(same(Object.keys(event).sort(), ["aborted", "childId", "exitCode", "profile", "role", "runId", "sequence", "taskDigest", "type", "version"])
            && event.exitCode === 0 && event.aborted === false); active = undefined;
        } else check(["stdout", "stderr"].includes(event.type)
          && same(Object.keys(event).sort(), ["base64", "childId", "profile", "role", "runId", "sequence", "taskDigest", "type", "version"])
          && typeof event.base64 === "string" && Buffer.from(event.base64, "base64").toString("base64") === event.base64);
      }
    }
    check(active === undefined && (expected.request.arm === "guild-available" || runs.size === 0));
    const calls = new Map<string, any>();
    for (const event of lines(expected.parent)) if (event.type === "message_end" && event.message?.role === "assistant")
      for (const item of event.message.content ?? []) if (item.type === "toolCall" && item.name === "guild_handover") {
        check(typeof item.id === "string" && !calls.has(item.id)); calls.set(item.id, item.arguments);
      }
    const parentRows = lines(processes[`${expected.supervisor.parentPid}.jsonl`]);
    const spawns = parentRows.filter(row => row.event.type === "child_spawn").map(row => row.event);
    check(spawns.length === runs.size && new Set(spawns.map(spawn => spawn.childId)).size === spawns.length);
    const bindings: any[] = [];
    for (const spawn of spawns) {
      check(same(Object.keys(spawn).sort(), ["childId", "childPid", "profile", "role", "runId", "target", "taskDigest", "type"])
        && spawn.type === "child_spawn" && pid(spawn.childPid));
      const run = runs.get(spawn.childId), call = calls.get(spawn.runId), target = `${spawn.role}/${spawn.profile}`;
      check(run && call && run.runId === spawn.runId && run.role === spawn.role && run.profile === spawn.profile
        && call.role === spawn.role && call.profile === spawn.profile && typeof call.task === "string" && call.task.trim()
        && spawn.target === target && spawn.taskDigest === digest(call.task) && run.taskDigest === spawn.taskDigest);
      const rows = lines(processes[`${spawn.childPid}.jsonl`]); check(rows[0]?.actor === "child");
      const found = rows.filter(row => row.event.type === "child_binding");
      check(found.length === 1 && rows[rows[1]?.event.type === "runtime_observation" ? 2 : 1] === found[0]);
      const binding = found[0].event;
      check(same(Object.keys(binding).sort(), ["childId", "profile", "role", "runId", "target", "taskDigest", "type"])
        && same(binding, { type: "child_binding", childId: spawn.childId, runId: spawn.runId, role: spawn.role,
          profile: spawn.profile, target, taskDigest: digest(call.task) }));
      const allowed = spawn.role === "coder" ? tools : ["find", "grep", "ls", "read"];
      const content = rows.filter(row => row.event.type === "request_content").map(row => row.event.logical);
      check(content.length >= 1);
      for (const logical of content) {
        const names = logical.tools.map((tool: any) => tool?.name ?? tool?.function?.name);
        check(same([...names].sort(), [...allowed].sort()));
      }
      const strings = (value: any, out: string[] = []): string[] => { if (typeof value === "string") out.push(value);
        else if (value && typeof value === "object") Object.values(value).forEach(child => strings(child, out)); return out; };
      check(strings(content[0].input).filter(value => value === `Task: ${call.task}`).length === 1);
      bindings.push(binding);
    }
    const childFiles = Object.entries(processes).filter(([, raw]) => lines(raw)[0]?.actor === "child");
    check(childFiles.length === runs.size);
    const result = { version: 2 as const, children: runs.size, bindingDigest: digest(bindings) };
    const freeze = (value: any): void => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } };
    freeze(result); return result;
  } catch { throw new Error("Bound child request evidence mismatch"); }
}

interface BoundRuntimeExpected extends BoundRequestExpected { children: string; pricing: BasePricing }
export function auditBoundRuntimeMeters(processes: Record<string, string>, expected: BoundRuntimeExpected) {
  try {
    check(expected && same(Object.keys(expected).sort(), ["binding", "children", "launch", "parent", "pricing", "request", "requirement", "supervisor", "trialIdentity"]));
    const content = auditBoundRequestContent(processes, { trialIdentity: expected.trialIdentity, launch: expected.launch,
      supervisor: expected.supervisor, binding: expected.binding, requirement: expected.requirement,
      request: expected.request, parent: expected.parent });
    const children = auditBoundChildRequests(processes, { ...expected });
    const legacy: Record<string, string> = Object.create(null);
    for (const [name, raw] of Object.entries(processes)) {
      const events = lines(raw).map(row => row.event).filter(event => !["request_content", "runtime_observation", "child_binding"].includes(event.type))
        .map(event => event.type === "child_spawn" ? { type: "child_spawn", childId: event.childId, childPid: event.childPid } : event);
      for (const event of events) if (event.type === "transport" && event.record?.type === "response")
        check(event.record.meter?.model === "gpt-6-astra");
      const producerPid = Number(name.slice(0, -6)), first = lines(raw)[0];
      legacy[name] = events.map((event, sequence) => JSON.stringify({ version: 1, pid: producerPid, ppid: first.ppid,
        actor: first.actor, sequence, ...event })).join("\n") + "\n";
    }
    const reconciliation = auditNativeEvidenceForRuntime({ arm: expected.request.arm, pricing: expected.pricing,
      supervisorPid: expected.supervisor.supervisorPid, parentPid: expected.supervisor.parentPid,
      parent: expected.parent, children: expected.children, processes: legacy }, expected.requirement.runtime.piVersion);
    check(reconciliation.requests === content.requests);
    const result = { version: 2 as const, requests: content.requests, usage: reconciliation.usage,
      reconciliationDigest: digest({ contentDigest: content.contentDigest, childBindingDigest: children.bindingDigest, evidenceDigest: reconciliation.evidenceDigest }) };
    const freeze = (value: any): void => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } };
    freeze(result); return result;
  } catch { throw new Error("Bound runtime and meter evidence mismatch"); }
}

export function auditBoundRuntimeObservations(processes: Record<string, string>, expected: BoundRuntimeExpected) {
  try {
    const meters = auditBoundRuntimeMeters(processes, expected);
    const requirement = freezeRequirement(expected.requirement), runtime = requirement.runtime;
    const selected = runtime.hashes.map((entry, i) => ({ id: i === 0 ? "runtime/node" : `runtime/file-${i}`, ...entry }));
    const observations: any[] = []; let sharedFiles: any, sharedPackages: any;
    for (const name of Object.keys(processes).sort()) {
      const rows = lines(processes[name]), found = rows.filter(row => row.event.type === "runtime_observation");
      check(found.length === 1 && rows[1] === found[0]);
      const observation = found[0].event;
      check(same(Object.keys(observation).sort(), ["observation", "type"]) && observation.type === "runtime_observation");
      const value = observation.observation, producerPid = Number(name.slice(0, -6)), first = rows[0];
      check(value && same(Object.keys(value).sort(), ["files", "kind", "packages", "process", "requirementDigest", "trialId", "version"])
        && value.version === 1 && value.kind === "native-runtime-file-observation" && value.trialId === expected.trialIdentity.id
        && value.requirementDigest === digest(requirement));
      const processRecord = value.process;
      check(processRecord && same(Object.keys(processRecord).sort(), ["arch", "executable", "nodePath", "nodeVersion", "pid", "platform", "ppid"])
        && processRecord.pid === producerPid && processRecord.ppid === first.ppid
        && processRecord.nodeVersion === runtime.nodeVersion && processRecord.nodePath === runtime.nodePath
        && processRecord.platform === runtime.platform && processRecord.arch === runtime.arch
        && processRecord.executable && same(Object.keys(processRecord.executable).sort(), ["dev", "ino"]));
      const files = value.files;
      check(files && same(Object.keys(files).sort(), ["files", "inventoryDigest", "kind", "version"])
        && files.version === 1 && files.kind === "native-selected-file-observation"
        && files.inventoryDigest === digest(selected) && Array.isArray(files.files) && files.files.length === selected.length);
      for (const [index, file] of files.files.entries()) {
        check(file && same(Object.keys(file).sort(), ["bytes", "dev", "id", "ino", "mode", "sha256", "uid"])
          && file.id === selected[index].id && file.sha256 === selected[index].sha256
          && Number.isSafeInteger(file.bytes) && file.bytes >= 0 && file.bytes <= 268435456
          && typeof file.dev === "string" && /^[0-9]+$/.test(file.dev) && typeof file.ino === "string" && /^[0-9]+$/.test(file.ino)
          && Number.isSafeInteger(file.uid) && file.uid >= 0 && Number.isSafeInteger(file.mode) && file.mode >= 0 && file.mode <= 0o7777
          && (file.mode & 0o022) === 0);
      }
      check(same(processRecord.executable, { dev: files.files[0].dev, ino: files.files[0].ino }));
      check(Array.isArray(value.packages) && value.packages.length === 2
        && same(value.packages, [{ id: files.files[1].id, name: "@earendil-works/pi-coding-agent", version: runtime.piVersion },
          { id: files.files[10].id, name: "@earendil-works/pi-ai", version: runtime.aiVersion }]));
      if (sharedFiles) check(same(files, sharedFiles) && same(value.packages, sharedPackages));
      else { sharedFiles = files; sharedPackages = value.packages; }
      observations.push(value);
    }
    check(observations.length >= 1 && observations.length <= meters.requests);
    const result = { version: 2 as const, processes: observations.length, runtimeDigest: digest(observations), usage: meters.usage };
    const freeze = (value: any): void => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } };
    freeze(result); return result;
  } catch { throw new Error("Bound runtime observation mismatch"); }
}

export interface NativeEvidence {
  arm: Arm; pricing: BasePricing; supervisorPid: number; parentPid: number;
  parent: string; children: string; processes: Record<string, string>;
}
const tools = ["bash", "edit", "find", "grep", "ls", "read", "write"];
const MAX_BYTES = 16 * 1024 * 1024;
function bounded(raw: string) {
  check(typeof raw === "string" && Buffer.byteLength(raw) <= MAX_BYTES);
  let count = 1;
  for (let offset = raw.indexOf("\n"); offset !== -1; offset = raw.indexOf("\n", offset + 1)) check(++count <= 65536);
}
const lines = (raw: string): any[] => { bounded(raw); return raw.split("\n").filter(line => line.trim()).map(line => JSON.parse(line)); };
const assistants = (events: any[]) => events.filter(r => r.type === "message_end" && r.message?.role === "assistant").map(r => r.message);
function check(value: unknown): asserts value { if (!value) throw Error(); }
const pid = (n: number) => Number.isSafeInteger(n) && n > 1 && n <= 2147483647;

function toolWorkflow(events: any[], allowed: string[]) {
  const calls = new Map<string, { call: any; turn: number; started: boolean; ended: boolean; result?: any }>();
  let turn = 0, pending = 0, ended = false, settled = false;
  for (const event of events) {
    check(!settled);
    if (event.type === "agent_settled") { check(ended); settled = true; continue; }
    check(!ended);
    if (event.type === "agent_end") { ended = true; continue; }
    if (event.type === "message_update" || (["message_start", "message_end"].includes(event.type) && event.message?.role === "assistant")) check(pending === 0);
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const m = event.message; check(Array.isArray(m.content));
      const declared = m.content.filter((c: any) => c.type === "toolCall");
      check((declared.length > 0) === (m.stopReason === "toolUse"));
      for (const call of declared) {
        check(typeof call.id === "string" && call.id.length > 0 && call.id.length <= 1024 && !calls.has(call.id) && allowed.includes(call.name));
        calls.set(call.id, { call, turn, started: false, ended: false }); pending++;
      }
      turn++;
    }
    if (event.type.startsWith("tool_execution_")) {
      const c = calls.get(event.toolCallId); check(c && c.call.name === event.toolName && !c.ended);
      if (event.type === "tool_execution_start") { check(!c.started && same(c.call.arguments, event.args)); c.started = true; }
      else {
        check(c.started);
        if (event.type === "tool_execution_end") { check(typeof event.isError === "boolean"); c.ended = true; c.result = event.result; pending--; }
        else check(event.type === "tool_execution_update");
      }
    }
  }
  check(settled && [...calls.values()].every(c => c.ended));
  return calls;
}

export function auditNativeEvidence(e: NativeEvidence) {
  return auditNativeEvidenceForRuntime(e, "0.85.1");
}
// Only the bound candidate composition can select a nonhistorical runtime.
function auditNativeEvidenceForRuntime(e: NativeEvidence, piVersion: string) {
  try {
    check(e && same(Object.keys(e).sort(), ["arm", "children", "parent", "parentPid", "pricing", "processes", "supervisorPid"]));
    bounded(e.parent); bounded(e.children);
    check(e.processes && typeof e.processes === "object" && !Array.isArray(e.processes));
    const files = Object.entries(e.processes); check(files.length >= 1 && files.length <= 64);
    let bytes = 0;
    for (const [name, raw] of files) {
      check(/^[1-9][0-9]{0,9}\.jsonl$/.test(name)); bounded(raw); bytes += Buffer.byteLength(raw); check(bytes <= MAX_BYTES);
    }
    // Bound decoded child streams before the trace analyzer splits/parses them.
    const observations = lines(e.children), chunks = new Map<string, Buffer[]>(), childText = new Map<string, string>();
    for (const r of observations) if (r.type === "stdout") {
      check(typeof r.childId === "string" && typeof r.base64 === "string");
      const data = Buffer.from(r.base64, "base64"); check(data.toString("base64") === r.base64);
      if (!chunks.has(r.childId)) chunks.set(r.childId, []);
      check(chunks.size <= 63); chunks.get(r.childId)!.push(data);
    }
    for (const [id, parts] of chunks) {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)); bounded(text); childText.set(id, text);
    }
    const pricing = validateBasePricing(e.pricing), trace = analyzeTrace(e.parent, e.children, pricing);
    check(["main-only", "guild-available"].includes(e.arm) && pricing.model === "openai-codex/gpt-6-astra" && pricing.api === "openai-codex-responses");
    check(trace.complete && same(trace.models, [pricing.model]) && (e.arm === "guild-available" || trace.childRuns.length === 0));
    check(pid(e.parentPid) && pid(e.supervisorPid) && e.parentPid !== e.supervisorPid);
    const spawns: any[] = [], usedPids = new Set<number>();
    let active: string | undefined;
    for (const r of observations) {
      if (r.type === "start") { check(active === undefined); active = r.childId; }
      if (r.type === "end") { check(active === r.childId); active = undefined; }
    }
    check(active === undefined && same(trace.childReported, trace.childObserved));
    const identities = new Set<string>();
    const unique = (kind: string, id: unknown) => {
      check(typeof id === "string" && (kind === "response" ? /^[a-zA-Z0-9_-]{1,256}$/ : /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/).test(id));
      check(!identities.has(`${kind}:${id}`)); identities.add(`${kind}:${id}`);
    };
    let requests = 0;
    function producer(id: number, target: string | null, events: any[]) {
      check(pid(id) && id !== e.supervisorPid && !usedPids.has(id)); usedPids.add(id);
      const rows = lines(e.processes[`${id}.jsonl`]), messages = assistants(events), actor = target ? "child" : "parent";
      const allowed = target ? (target.startsWith("coder/") ? tools : ["find", "grep", "ls", "read"]) : [...tools, ...(e.arm === "guild-available" ? ["guild_handover"] : [])].sort();
      const calls = toolWorkflow(events, allowed);
      rows.forEach((r, sequence) => check(r.version === 1 && r.sequence === sequence && r.pid === id && r.ppid === (target ? e.parentPid : e.supervisorPid) && r.actor === actor));
      let cursor = 0, prompt: string | undefined;
      const next = (type: string) => { const r = rows[cursor++]; check(r?.type === type); return r; };
      const context = () => {
        const r = next("context");
        check(r.model === pricing.model && r.thinking === "high" && r.target === target && same(r.tools, allowed)
          && typeof r.systemPromptDigest === "string" && /^[a-f0-9]{64}$/.test(r.systemPromptDigest)
          && (prompt === undefined || prompt === r.systemPromptDigest));
        prompt = r.systemPromptDigest;
      };
      const start = next("process_start"); check(start.node === "v24.20.0" && start.piVersion === piVersion); context();
      for (const [turn, message] of messages.entries()) {
        while (rows[cursor]?.type === "child_spawn") { check(target === null && e.arm === "guild-available"); spawns.push({ ...next("child_spawn"), afterTurns: turn }); }
        const requestId = next("request_start").requestId; unique("request", requestId); context(); context();
        const payload = next("payload");
        check(payload.requestId === requestId && payload.final.model === "gpt-6-astra" && payload.final.thinking === "high" && ["omitted", "default"].includes(payload.final.serviceTier));
        const meters = [];
        while (rows[cursor]?.type === "transport") { const r = next("transport"); check(r.requestId === requestId); meters.push(r.record); }
        check(verifyResponseMeters(meters, [message], pricing));
        for (const meter of meters) if (meter.type === "start") unique("attempt", meter.attemptId);
        unique("response", message.responseId);
        const end = next("request_end"); check(end.requestId === requestId && end.complete === true); requests++;
      }
      check(next("process_end").exitCode === 0 && cursor === rows.length);
      return calls;
    }
    const parentCalls = producer(e.parentPid, null, lines(e.parent));
    const targets: string[] = [];
    for (const [index, run] of trace.childRuns.entries()) {
      unique("child", run.childId);
      const target = `${run.role}/${run.profile}`;
      check(/^(explorer|architect|coder|reviewer)\/(general|frontend|angular|typescript|dotnet|rust)$/.test(target));
      const matching = spawns.filter(r => r.childId === run.childId); check(matching.length === 1 && spawns[index] === matching[0]);
      const c = parentCalls.get(run.runId);
      check(c?.call.name === "guild_handover" && c.call.arguments.role === run.role && c.call.arguments.profile === run.profile
        && typeof c.call.arguments.task === "string" && c.call.arguments.task.trim() && matching[0].afterTurns === c.turn + 1);
      check(Object.entries(run.usage).every(([key, value]) => c.result?.details?.usage?.[key] === value));
      producer(matching[0].childPid, target, lines(childText.get(run.childId)!)); targets.push(target);
    }
    check(spawns.length === trace.childRuns.length && same(Object.keys(e.processes).sort(), [...usedPids].map(id => `${id}.jsonl`).sort()));
    return { version: 1 as const, processes: usedPids.size, requests, targets, usage: trace.totalObserved, evidenceDigest: digest(e) };
  } catch { throw new Error("Native evidence mismatch"); }
}
