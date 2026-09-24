import { isDeepStrictEqual } from "node:util";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertNetworkIsolation, currentNetworkState } from "./offline-state.ts";
import { prepareNativeLaunch } from "./native-launch.ts";
import { captureProcess } from "./offline-capture.ts";
import { validateBasePricing, type BasePricing } from "./pricing.ts";
import { verifyResponseMeters } from "./response-observer.ts";

export function syntheticProbeInvocation(directory: string) {
  if (!["/evidence/synthetic", "/evidence/synthetic-guild"].includes(directory)) throw new Error("Synthetic probe admission failed");
  const guild = directory === "/evidence/synthetic-guild";
  return { arm: guild ? "guild-available" as const : "main-only" as const, guildRoot: guild ? "/harness/guild" : "/harness",
    bootstrap: guild ? "/harness/offline-guild-bootstrap.ts" : "/harness/offline-bootstrap.ts",
    args: ["/opt/pi-npm/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js", "--mode", "json", "-p", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--approve",
      ...(guild ? ["-e", "/harness/guild/extensions/index.ts"] : []),
      "--tools", `read,write,edit,bash,grep,find,ls${guild ? ",guild_handover" : ""}`, "--model", "openai-codex/gpt-6-astra", "--thinking", "high", "--", "Exercise the synthetic offline transport fixture."] };
}

export function syntheticProbeAuth() {
  const expires = Math.floor(Date.now() / 1000) * 1000 + 3600000;
  const access = "header." + Buffer.from(JSON.stringify({ exp: expires / 1000, "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64url") + ".synthetic-signature";
  const auth = JSON.stringify({ "openai-codex": { type: "oauth", access, refresh: "", expires, accountId: "synthetic-account" } });
  return { auth, access };
}

export async function runSyntheticProbe(directory: string) {
  const invocation = syntheticProbeInvocation(directory), guild = invocation.arm === "guild-available";
  const isolation = assertNetworkIsolation(currentNetworkState());
  const readiness = JSON.parse(readFileSync("/evidence/verification.json", "utf8"));
  if (readiness.parent.pid !== process.pid || readiness.parent.checks.namespace !== isolation.namespace) throw new Error("Synthetic probe admission failed");
  mkdirSync(directory, { mode: 0o700 });
  if (guild) for (const name of ["transports", "diagnostics"]) mkdirSync(join(directory, name), { mode: 0o700 });
  const temporary = mkdtempSync("/tmp/guild-offline/probe-");
  let summary: unknown;
  try {
    const agent = join(temporary, "agent"), cwd = join(temporary, "repo");
    mkdirSync(agent, { mode: 0o700 }); mkdirSync(cwd, { mode: 0o700 });
    const { auth, access } = syntheticProbeAuth();
    writeFileSync(join(agent, "auth.json"), auth, { flag: "wx", mode: 0o600 });
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } }, transport: "auto", packages: [], extensions: [], skills: [], prompts: [], enableInstallTelemetry: false }), { flag: "wx", mode: 0o600 });
    const piRoot = "/opt/pi-npm/lib/node_modules/@earendil-works/pi-coding-agent", cli = `${piRoot}/dist/cli.js`;
    const model = JSON.parse(readFileSync(`${piRoot}/node_modules/@earendil-works/pi-ai/dist/providers/data/openai-codex.json`, "utf8"))["openai-codex-responses"]["gpt-6-astra"];
    const pricing = validateBasePricing({ version: 1, model: "openai-codex/gpt-6-astra", api: model.api, serviceTier: "base", cost: model.cost });
    const native = await prepareNativeLaunch({ artifactDirectory: directory, agent, cwd, guildRoot: invocation.guildRoot, piEntry: cli, pricing, arm: invocation.arm });
    const env = { PATH: "/usr/bin:/bin", HOME: agent, TMPDIR: agent, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", ...native,
      NODE_OPTIONS: `--import=${pathToFileURL(invocation.bootstrap).href}` };
    const args = invocation.args;
    writeFileSync(join(directory, "invocation.json"), JSON.stringify({ version: 1, mode: guild ? "synthetic-guild" : "synthetic-main-only", args, pricing, environmentKeys: Object.keys(env).sort() }), { flag: "wx", mode: 0o600 });
    const capture = () => captureProcess(process.execPath, args, cwd, env, directory, guild ? 30000 : 20000, guild);
    const outcome = guild ? await (await import("./offline-diagnostics.ts")).withResourceSnapshots(directory, capture) : await capture();
    writeFileSync(join(directory, "process-outcome.json"), JSON.stringify(outcome), { flag: "wx", mode: 0o600 });
    const read = (file: string) => { const path = join(directory, file); if (statSync(path).size > (file === "children.jsonl" ? 16 : 1) * 1024 * 1024) throw Error(); return readFileSync(path, "utf8"); };
    const lines = (file: string) => read(file).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    const files = readdirSync(join(directory, "native"));
    let records: any[], stats: unknown, acceptance: object = {}, privateRaw: string[] = [];
    if (guild) {
      if (files.length !== 3 || files.some(file => !/^[0-9]+\.jsonl$/.test(file))) throw new Error("Synthetic process evidence mismatch");
      records = files.map(file => lines(`native/${file}`));
      const transportFiles = readdirSync(join(directory, "transports"));
      if (!isDeepStrictEqual(transportFiles, files.map(file => file.replace(/jsonl$/, "json")))) throw new Error("Synthetic transport evidence mismatch");
      const transports = transportFiles.map(file => JSON.parse(read(`transports/${file}`)));
      const children = read("children.jsonl");
      const { validateSyntheticGuild } = await import("./offline-guild-evidence.ts");
      acceptance = validateSyntheticGuild({ outcome, parentPid: process.pid, isolation, parent: lines("stdout.jsonl"), children, native: records, transports }, pricing);
      stats = transports;
      privateRaw = children.split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(r => ["stdout", "stderr"].includes(r.type)).map(r => Buffer.from(r.base64, "base64").toString("utf8"));
    } else {
      if (!isDeepStrictEqual(files, [`${outcome.pid}.jsonl`])) throw new Error("Synthetic process evidence mismatch");
      records = lines(`native/${outcome.pid}.jsonl`); stats = JSON.parse(read("synthetic-transport.json"));
      validateSyntheticRun({ ...outcome, parentPid: process.pid, stdout: lines("stdout.jsonl"), native: records, stats }, pricing);
    }
    if (readFileSync(join(agent, "auth.json"), "utf8") !== auth || readdirSync(cwd).length || readdirSync(agent).some(file => file.startsWith("pi-guild-"))
      || [read("stdout.jsonl"), read("stderr.txt"), JSON.stringify(records), ...privateRaw].some(raw => raw.includes(access))) throw new Error("Synthetic fixture preservation mismatch");
    if (assertNetworkIsolation(currentNetworkState()).namespace !== isolation.namespace) throw Error();
    summary = { version: 1, kind: guild ? "synthetic-guild-cli-not-campaign-binding" : "synthetic-main-only-cli-not-campaign-binding", namespace: isolation.namespace, pid: outcome.pid, model: pricing.model, thinking: "high", requests: 1, ...acceptance, stats, syntheticAuthUnchanged: true, fixtureUnchanged: true };
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  writeFileSync(join(directory, "summary.json"), JSON.stringify({ ...(summary as object), temporaryCleanup: true }), { flag: "wx", mode: 0o600 });
}

export function validateSyntheticRun(e: any, pricing: BasePricing) {
  try {
    if (e.status !== 0 || e.signal !== null || e.limited !== false || e.timedOut !== false || e.captureFailed !== false
      || !isDeepStrictEqual(e.stats, { version: 1, sockets: 1, sends: 1, fetches: 0, rejected: 0 }) || !Array.isArray(e.native) || !Array.isArray(e.stdout)) throw Error();
    const types = ["process_start", "context", "request_start", "context", "context", "payload", "transport", "transport", "transport", "request_end", "process_end"];
    if (!isDeepStrictEqual(e.native.map((r: any) => r.type), types)) throw Error();
    if (!Number.isSafeInteger(e.pid) || e.pid <= 1 || e.pid === e.parentPid) throw Error();
    e.native.forEach((r: any, i: number) => {
      if (r.version !== 1 || r.pid !== e.pid || r.ppid !== e.parentPid || r.actor !== "parent" || r.sequence !== i) throw Error();
    });
    if (e.native[0].piVersion !== "0.85.1" || e.native[0].node !== "v24.20.0" || e.native.at(-1).exitCode !== 0) throw Error();
    const contexts = e.native.filter((r: any) => r.type === "context");
    for (const c of contexts) {
      if (c.model !== pricing.model || c.thinking !== "high" || c.target !== null || !/^[a-f0-9]{64}$/.test(c.systemPromptDigest)
        || c.systemPromptDigest !== contexts[0].systemPromptDigest || !isDeepStrictEqual(c.tools, ["bash", "edit", "find", "grep", "ls", "read", "write"])) throw Error();
    }
    const id = e.native[2].requestId;
    if (!/^[a-f0-9-]{36}$/.test(id) || e.native[9].complete !== true) throw Error();
    for (const r of e.native.filter((r: any) => ["request_start", "payload", "transport", "request_end"].includes(r.type))) if (r.requestId !== id) throw Error();
    const payload = e.native[5].final;
    if (payload.model !== "gpt-6-astra" || payload.thinking !== "high" || !["omitted", "default"].includes(payload.serviceTier)) throw Error();
    const messages = e.stdout.filter((r: any) => r.type === "message_end" && r.message?.role === "assistant").map((r: any) => r.message);
    if (messages.length !== 1 || messages[0].stopReason !== "stop" || messages[0].content.length !== 1
      || messages[0].content[0].type !== "text" || messages[0].content[0].text !== "Synthetic offline result" || e.stdout.filter((r: any) => r.type === "agent_settled").length !== 1
      || e.stdout.some((r: any) => r.type.startsWith("tool_") || r.message?.role === "toolResult")) throw Error();
    const meters = e.native.filter((r: any) => r.type === "transport").map((r: any) => r.record);
    if (meters.some((r: any) => r.transport !== "websocket") || !verifyResponseMeters(meters, messages, pricing)) throw Error();
  } catch { throw new Error("Synthetic CLI evidence mismatch"); }
}
