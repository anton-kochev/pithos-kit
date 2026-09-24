import { spawn } from "node:child_process";
import { openSync, closeSync, writeFileSync, fsyncSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, dirname, basename } from "node:path";
import { digest } from "./manifest.ts";
import { createCodexAuthLease, type CodexAuthSource } from "./codex-auth.ts";
import { validateBasePricing, type BasePricing } from "./pricing.ts";
import type { Driver, DriverResult, SupervisorSpawnObservation } from "./runner.ts";
import type { NativeRuntimeInventory } from "./native-input-contracts.ts";

interface Options {
  // This acknowledgement is NOT an authorization mechanism. The operator must
  // obtain user approval of the cohort/task bank and spend ceiling separately.
  approval: "explicit-model-run-approval";
  piEntry: string;
  piPackageJson: string;
  guildRoot: string;
  credentials: Record<string, string>;
  codexAuth?: CodexAuthSource;
  nativeRequestGate?: BasePricing;
  nativeRuntime?: NativeRuntimeInventory;
}
export async function fingerprint(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(name: string): Promise<void> {
    const file = join(root, name);
    const info = await lstat(file);
    if (info.isSymbolicLink()) throw new Error(`Symlink implementation input: ${name}`);
    if (info.isDirectory()) {
      for (const child of (await readdir(file)).sort()) await visit(`${name}/${child}`);
    } else result[name] = digest((await readFile(file)).toString("base64"));
  }
  for (const name of ["package.json", "package-lock.json", "agents", "extensions", "src", "evaluation/src"]) await visit(name);
  return result;
}
export function createPiDriver(options: Options): Driver {
  options = structuredClone(options);
  const nativeRequested = Boolean(options.nativeRequestGate);
  if (options.nativeRuntime !== undefined && !nativeRequested) throw new Error("Native runtime inventory requires native observation");
  if (options.approval !== "explicit-model-run-approval") throw new Error("Explicit user model-run approval is required");
  if (process.platform === "win32") throw new Error("Native evaluation driver currently requires POSIX process groups");
  for (const name of [options.piEntry, options.piPackageJson, options.guildRoot]) if (!isAbsolute(name)) throw new Error("Driver paths must be absolute");
  if (options.codexAuth && Object.keys(options.credentials).length) throw new Error("Cannot mix Codex authentication with API-key credentials");
  for (const key of Object.keys(options.credentials)) {
    if (!["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"].includes(key)) throw new Error(`Unsupported credential environment key: ${key}`);
  }
  options = { ...options, ...(options.nativeRequestGate ? { nativeRequestGate: validateBasePricing(options.nativeRequestGate) } : {}) };
  return async ({ trialIdentity, cwd, artifactDirectory, retentionRoot, request, signal, emit, stderr, prepareNativeLaunch }) => {
    try { trialIdentity = structuredClone(trialIdentity); request = structuredClone(request); }
    catch { throw new Error("Driver trial identity mismatch"); }
    if (options.codexAuth && !request.cohort.model.startsWith("openai-codex/")) throw new Error("Codex authentication requires the openai-codex provider");
    const piManifest = JSON.parse(await readFile(options.piPackageJson, "utf8"));
    const version = /^(\d+)\.(\d+)\.(\d+)$/.exec(piManifest.version ?? "");
    if (piManifest.name !== "@earendil-works/pi-coding-agent" || !version || (Number(version[1]) === 0 && Number(version[2]) < 83)) throw new Error("Pi >=0.83.0 package required");
    // Exact reviewed policies, not a compatibility range or a campaign-runtime fallback.
    if (options.codexAuth && !["0.83.0", "0.85.1"].includes(piManifest.version)) throw new Error("Scoped Codex auth is verified only for Pi 0.83.0 and 0.85.1; review the refresh policy before changing runtime");
    if (options.nativeRequestGate && (piManifest.version !== (options.nativeRuntime?.piVersion ?? "0.85.1") || !options.codexAuth || request.cohort.thinking !== "high"
      || request.cohort.model !== options.nativeRequestGate.model || options.nativeRequestGate.api !== "openai-codex-responses"
      || options.piEntry !== join(dirname(options.piPackageJson), "dist/cli.js"))) throw new Error("Native request observation requires the selected Node/Pi runtime, scoped Codex authentication and a matching high/base cohort");
    if (options.nativeRequestGate) throw new Error("Native request observation is disabled pending verified offline isolation and completion of execution binding");
    if (nativeRequested && (!options.nativeRuntime || typeof prepareNativeLaunch !== "function")) throw new Error("Native driver configuration unavailable");
    const entryRelative = relative(dirname(options.piPackageJson), options.piEntry);
    if (entryRelative.startsWith("..") || isAbsolute(entryRelative)) throw new Error("Pi entry must belong to the selected package");
    if (!trialIdentity || typeof trialIdentity !== "object" || Array.isArray(trialIdentity) || Object.keys(trialIdentity).sort().join(",") !== "id,requestDigest,version" || trialIdentity.version !== 1
      || typeof trialIdentity.id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(trialIdentity.id)
      || basename(artifactDirectory) !== trialIdentity.id || trialIdentity.requestDigest !== digest(request)) throw new Error("Driver trial identity mismatch");
    const implementation = await fingerprint(options.guildRoot);
    const authLease = options.codexAuth ? await createCodexAuthLease({
      ...options.codexAuth, forbiddenRoots: [dirname(artifactDirectory), ...(retentionRoot ? [retentionRoot] : []), cwd, options.guildRoot], timeoutMs: request.timeoutMs,
    }) : undefined;
    const agent = authLease?.directory ?? join(artifactDirectory, "agent");
    try {
      if (!authLease) await mkdir(agent, { mode: 0o700 });
      await writeFile(join(agent, "settings.json"), JSON.stringify({
        compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } },
        packages: [], extensions: [], skills: [], prompts: [], enableInstallTelemetry: false,
      }), { flag: "wx", mode: 0o600 });
      const tools = ["read", "write", "edit", "bash", "grep", "find", "ls"];
      const args = ["--import", pathToFileURL(join(options.guildRoot, "evaluation/src/child-observer.ts")).href, options.piEntry, "--mode", "json", "-p", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--approve"];
      if (request.arm === "guild-available") {
        args.push("--extension", resolve(options.guildRoot, "extensions/index.ts"));
        tools.push("guild_handover");
      }
      args.push("--tools", tools.join(","), "--model", request.cohort.model, "--thinking", request.cohort.thinking, "--", request.task.prompt);
      const nativeEnvironment = nativeRequested ? structuredClone(await prepareNativeLaunch!({
        runtime: structuredClone(options.nativeRuntime!), guildRoot: options.guildRoot, authLease: authLease!,
        invocation: structuredClone({ version: 1, trialIdentity, command: process.execPath, args, cwd }),
      })) : undefined;
      if (nativeRequested && (!nativeEnvironment || typeof nativeEnvironment !== "object" || Array.isArray(nativeEnvironment)
        || Object.keys(nativeEnvironment).sort().join(",") !== "GUILD_EVAL_AUTH_DIGEST,GUILD_EVAL_NATIVE_CONFIG,GUILD_EVAL_NATIVE_CONFIG_SHA256,NODE_OPTIONS"
        || nativeEnvironment.NODE_OPTIONS !== `--import=${pathToFileURL(join(options.guildRoot, "evaluation/src/native-preload.ts")).href}`
        || nativeEnvironment.GUILD_EVAL_NATIVE_CONFIG !== join(artifactDirectory, "native-config.json")
        || typeof nativeEnvironment.GUILD_EVAL_NATIVE_CONFIG_SHA256 !== "string" || !/^[a-f0-9]{64}$/.test(nativeEnvironment.GUILD_EVAL_NATIVE_CONFIG_SHA256)
        || nativeEnvironment.GUILD_EVAL_AUTH_DIGEST !== authLease!.identity.fileDigest)) throw new Error("Native driver configuration mismatch");
      await writeFile(join(artifactDirectory, "invocation.json"), JSON.stringify({
        version: 1, trialIdentity, command: process.execPath, args, cwd,
        piVersion: piManifest.version, piEntryDigest: digest((await readFile(options.piEntry)).toString("base64")),
        piPackageDigest: digest(piManifest), implementation, implementationDigest: digest(implementation),
        credentialKeys: Object.keys(options.credentials).sort(),
        authentication: authLease ? "codex-access-only; transient storage; no refresh" : "explicit API-key environment",
        ...(authLease ? { scopedAuthIdentity: authLease.identity } : {}),
        ...(nativeEnvironment ? { nativeEnvironment } : {}),
        contextPolicy: "clean-agent-dir; no ambient resources; native parent prompt; explicit Guild extension in Guild arm",
      }, null, 2), { flag: "wx", mode: 0o600 });
      signal.throwIfAborted();
      authLease?.assertFresh();
      const observationFd = openSync(join(artifactDirectory, "children.jsonl"), "wx", 0o600);
      let result: DriverResult;
      let supervisorFd: number | undefined;
      try {
        // Reserve exclusively before spawn; an existing or partial record is not repaired.
        supervisorFd = openSync(join(artifactDirectory, "supervisor.json"), "wx", 0o600);
        result = await new Promise<DriverResult>((resolveResult, reject) => {
          const child = spawn(process.execPath, args, {
            cwd, detached: true, stdio: ["ignore", "pipe", "pipe", observationFd],
            env: { PATH: process.env.PATH, HOME: agent, TMPDIR: agent, PI_CODING_AGENT_DIR: agent,
              PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", ...options.credentials, ...nativeEnvironment },
          });
          // Kill the entire group on timeout/abort, including Guild grandchildren.
          const kill = (kind: NodeJS.Signals) => {
            if (!child.pid) return;
            try { process.kill(-child.pid, kind); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") stderr(String(e)); }
          };
          const abort = () => kill("SIGKILL");
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
          child.stdout!.setEncoding("utf8"); child.stderr!.setEncoding("utf8");
          child.stdout!.on("data", emit); child.stderr!.on("data", stderr);
          let failure: Error | undefined, supervisor: SupervisorSpawnObservation | undefined;
          child.on("error", e => { failure ??= e; });
          child.on("close", code => {
            signal.removeEventListener("abort", abort);
            kill("SIGKILL"); // Do not leave orphan writers after an early parent exit.
            if (failure) reject(failure);
            else if (!supervisor) reject(new Error("Supervisor spawn observation unavailable"));
            else resolveResult({ exitCode: code ?? 1, supervisor });
          });
          if (child.pid !== undefined) {
            try {
              if (!Number.isInteger(child.pid) || child.pid < 2 || child.pid > 2147483647) throw Error();
              supervisor = Object.freeze({ version: 1, kind: "guild-eval-supervisor-spawn",
                trialIdentity: Object.freeze({ ...trialIdentity }),
                invocationDigest: digest({ version: 1, trialIdentity, command: process.execPath, args, cwd }),
                configurationSha256: nativeEnvironment?.GUILD_EVAL_NATIVE_CONFIG_SHA256 ?? null,
                supervisorPid: process.pid, parentPid: child.pid });
              writeFileSync(supervisorFd!, JSON.stringify(supervisor) + "\n", { encoding: "utf8" });
              fsyncSync(supervisorFd!);
            } catch {
              failure = new Error("Supervisor spawn observation failed");
              kill("SIGKILL");
            }
          }
        });
      } finally {
        try { if (supervisorFd !== undefined) closeSync(supervisorFd); }
        finally { closeSync(observationFd); }
      }
      if (digest(await fingerprint(options.guildRoot)) !== digest(implementation)) throw new Error("Implementation changed during trial; comparison invalid");
      return result;
    } finally { await authLease?.dispose(); }
  };
}
