// Evaluation-only, process-lifetime instrumentation. No installed SDK file is changed.
import { openSync, closeSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { channel } from "node:diagnostics_channel";
import { assertScopedAuth } from "./scoped-auth-identity.ts";
import { installNativeRequestGate, verifyNativePreparedAuth } from "./native-request.ts";
import { inspectNativeSession } from "./native-session.ts";

import { readNativeConfig } from "./native-config.ts";
import { readNativeRuntimeInput } from "./native-runtime-input.ts";
import { observeNativeRuntime } from "./native-runtime-observation.ts";
import { createCandidateNativeEnvelope } from "./native-producer.ts";
const file = process.env.GUILD_EVAL_NATIVE_CONFIG;
if (file !== undefined || process.env.GUILD_EVAL_NATIVE_CONFIG_SHA256 !== undefined) {
  try {
    const config = readNativeConfig(file!, process.env.GUILD_EVAL_NATIVE_CONFIG_SHA256!);
    if (process.argv[1] === config.piEntry) {
      const candidate = Object.hasOwn(config, "admissionBinding");
      const requirement = candidate ? readNativeRuntimeInput(file!, process.env.GUILD_EVAL_NATIVE_CONFIG_SHA256!) : undefined;
      // Keep the admitted runtime/producer gate closed. Candidate code below is
      // prepared for review but cannot observe /proc, runtime files or SDK state.
      if (candidate) throw Error();
      if (config.version !== 1 || process.version !== config.node || process.execPath !== config.nodePath
        || process.cwd() !== config.cwd || process.env.HOME !== process.env.TMPDIR || process.env.HOME !== process.env.PI_CODING_AGENT_DIR) throw Error();
      if (config.scopedAuthIdentity.fileDigest !== process.env.GUILD_EVAL_AUTH_DIGEST) throw Error();
      assertScopedAuth(join(process.env.HOME!, "auth.json"), config.scopedAuthIdentity, 0);
      const manifest = JSON.parse(readFileSync(join(config.piRoot, "package.json"), "utf8"));
      if (manifest.name !== "@earendil-works/pi-coding-agent" || manifest.version !== (requirement?.runtime.piVersion ?? "0.85.1")) throw Error();
      const actor: "parent" | "child" = process.ppid === config.launchParentPid ? "parent" : "child";
      const fd = openSync(join(config.directory, `${process.pid}.jsonl`), "wx", 0o600);
      const producerContext = candidate ? { trialId: config.admissionBinding.trialId,
        configurationSha256: process.env.GUILD_EVAL_NATIVE_CONFIG_SHA256!,
        runtimeRequirementSha256: config.admissionBinding.runtimeRequirementSha256,
        invocationDigest: config.admissionBinding.invocationDigest, supervisorPid: config.launchParentPid,
        pid: process.pid, ppid: process.ppid, actor } : undefined;
      let sequence = 0, bytes = 0;
      const report = (event: any) => {
        const row = producerContext ? createCandidateNativeEnvelope(producerContext, sequence++, event)
          : { version: 1, pid: process.pid, ppid: process.ppid, actor, sequence: sequence++, ...event };
        const line = Buffer.from(JSON.stringify(row) + "\n");
        bytes += line.length;
        if (bytes > 16 * 1024 * 1024) throw new Error("Native observation output limit");
        for (let offset = 0; offset < line.length;) offset += writeSync(fd, line, offset, line.length - offset);
      };
      process.on("exit", code => { try { report({ type: "process_end", exitCode: code }); } finally { closeSync(fd); } });
      report({ type: "process_start", node: process.version, piVersion: manifest.version,
        ...(candidate ? { runtimeDigest: requirement!.runtimeDigest, trialBindingDigest: requirement!.trialBindingDigest } : {}) });
      if (candidate) {
        report({ type: "runtime_observation", observation: observeNativeRuntime(requirement!) });
        if (actor === "child") {
          const childId = process.env.GUILD_EVAL_CHILD_ID, runId = process.env.GUILD_EVAL_CHILD_RUN_ID,
            role = process.env.GUILD_EVAL_CHILD_ROLE, profile = process.env.GUILD_EVAL_CHILD_PROFILE,
            taskDigest = process.env.GUILD_EVAL_CHILD_TASK_DIGEST, target = `${role}/${profile}`;
          if (!childId || !/^[a-f0-9-]{36}$/.test(childId) || !runId || runId.length > 1024
            || !/^(explorer|architect|coder|reviewer)$/.test(role ?? "")
            || !/^(general|frontend|angular|typescript|dotnet|rust)$/.test(profile ?? "")
            || !/^[a-f0-9]{64}$/.test(taskDigest ?? "")) throw Error();
          report({ type: "child_binding", childId, runId, role, profile, target, taskDigest });
        }
      }
      const { AgentSession } = await import(pathToFileURL(join(config.piRoot, "dist/core/agent-session.js")).href);
      const { ModelRuntime } = await import(pathToFileURL(join(config.piRoot, "dist/core/model-runtime.js")).href);
      const { buildSystemPrompt } = await import(pathToFileURL(join(config.piRoot, "dist/core/system-prompt.js")).href);
      let session: any;
      const verify = () => {
        if (!session) throw new Error("Native session not bound");
        report({ type: "context", ...inspectNativeSession(session, { cwd: config.cwd, arm: config.arm, guildRoot: config.guildRoot, pricing: config.pricing, actor }, buildSystemPrompt) });
      };
      const original = AgentSession.prototype.bindExtensions;
      AgentSession.prototype.bindExtensions = async function (...args: any[]) {
        await original.apply(this, args);
        if (session) throw new Error("Native session rebound");
        session = this; verify();
      };
      installNativeRequestGate(ModelRuntime, { pricing: config.pricing, thinking: "high", verifyContext: verify, report,
        ...(candidate ? { requestContentEvidence: "candidate-native-v2" as const } : {}),
        verifyPrepared(prepared, runtime) {
          try {
            if (runtime !== session.modelRuntime || runtime.getProviderAuthStatus("openai-codex").source !== "stored") throw Error();
            verifyNativePreparedAuth(prepared, join(process.env.HOME!, "auth.json"), config.scopedAuthIdentity);
          } catch { throw new Error("Native authentication policy mismatch"); }
        },
      });
      let pendingChild: any;
      channel("pithos.guild.child").subscribe((event: any) => {
        if (event.type === "start") pendingChild = event;
        if (event.type === "end" && pendingChild?.childId === event.childId) pendingChild = undefined;
      });
      channel("child_process").subscribe((event: any) => event.process.once("spawn", () => {
        const child = event.process;
        if (child.spawnargs?.[1] !== config.piEntry) return;
        if (candidate) {
          const bound = pendingChild, target = `${bound?.role}/${bound?.profile}`;
          if (!bound?.childId || !bound.runId || !bound.taskDigest) throw Error();
          report({ type: "child_spawn", childPid: child.pid, childId: bound.childId, runId: bound.runId,
            role: bound.role, profile: bound.profile, target, taskDigest: bound.taskDigest });
        } else report({ type: "child_spawn", childPid: child.pid, childId: pendingChild?.childId ?? null });
      }));
    }
  } catch {
    process.stderr.write("Native observation initialization failed\n");
    process.exit(1);
  }
}
