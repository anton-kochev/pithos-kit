import { createConnection, createServer, type Socket } from "node:net";
import { createSocket } from "node:dgram";
import { isDeepStrictEqual, promisify } from "node:util";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { currentNetworkState, assertNetworkIsolation, type NetworkState } from "./offline-state.ts";
export { assertNetworkIsolation, type NetworkState } from "./offline-state.ts";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { snapshotRuntime, assertMatchingRuntime } from "./offline-runtime.ts";

export function loopbackControl(): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer(socket => socket.destroy());
    let client: Socket | undefined, ended = false;
    const finish = (error?: Error) => {
      if (ended) return; ended = true;
      clearTimeout(timer); client?.destroy();
      server.close(() => error ? reject(error) : resolve());
    };
    const timer = setTimeout(() => finish(new Error("Loopback control timeout")), 2000);
    server.on("error", () => finish(new Error("Loopback control failed")));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return finish(new Error("Loopback control failed"));
      client = createConnection({ host: "127.0.0.1", port: address.port });
      client.on("error", () => finish(new Error("Loopback control failed")));
      client.once("connect", () => finish());
    });
  });
}
interface Sockets { tcp: (options: { host: string; port: number; family: number }) => Socket; udp: (family: 4 | 6) => ReturnType<typeof createSocket> }
export function deniedSocket(protocol: "tcp" | "udp", family: 4 | 6, io: Sockets = { tcp: createConnection, udp: family => createSocket(family === 4 ? "udp4" : "udp6") }): Promise<string> {
  return new Promise(resolve => {
    const host = family === 4 ? "192.0.2.1" : "2001:db8::1";
    let close = () => {}, ended = false;
    const finish = (code: string) => {
      if (ended) return; ended = true;
      clearTimeout(timer); try { close(); } catch { /* A failed bind may already be closed. */ }
      resolve(code);
    };
    const failed = (error: any) => finish(error?.code === "ENETUNREACH" ? "ENETUNREACH" : "UNVERIFIED");
    const timer = setTimeout(() => finish("TIMEOUT"), 2000);
    try {
      if (protocol === "tcp") {
        const socket = io.tcp({ host, port: 9, family }); close = () => socket.destroy();
        socket.on("error", failed); socket.once("connect", () => finish("CONNECTED"));
      } else {
        const socket = io.udp(family); close = () => socket.close(); socket.on("error", failed);
        socket.send(Buffer.from([0]), 9, host, error => error ? failed(error) : finish("SENT"));
      }
    } catch (error) { failed(error); }
  });
}

export async function verifyNetworkTree(checks: Checks, launchChild: () => Promise<string>, parentPid = process.pid) {
  const parent = { pid: parentPid, checks: await runNetworkChecks(checks) };
  let child: any;
  try { child = JSON.parse(await launchChild()); } catch { throw new Error("Offline child verification mismatch"); }
  if (!Number.isSafeInteger(child?.pid) || child.pid <= 1 || child.pid === parentPid
    || !isDeepStrictEqual(child, { pid: child.pid, ppid: parentPid, checks: parent.checks })) throw new Error("Offline child verification mismatch");
  return { parent, child };
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === self) {
  let phase = "configuration";
  const watchdog = setTimeout(() => { process.stderr.write(`Offline verification timeout (${phase})\n`); process.exit(1); }, process.argv[2] === "--synthetic-guild" ? 60000 : process.argv[2] === "--synthetic-pi" ? 45000 : 20000);
  try {
    const env = { PATH: "/usr/bin:/bin", HOME: "/tmp/guild-offline", TMPDIR: "/tmp/guild-offline", PI_CODING_AGENT_DIR: "/tmp/guild-offline", PI_OFFLINE: "1" };
    if (!isDeepStrictEqual({ ...process.env }, env) || (process.argv.length !== 2 && !(process.argv.length === 3 && ["--child", "--verify", "--synthetic-pi", "--synthetic-guild"].includes(process.argv[2])))) throw Error();
    // Structural checks precede all sockets, including the local positive control.
    phase = "structure";
    assertNetworkIsolation(currentNetworkState());
    const checks = { state: currentNetworkState, loopback: loopbackControl, denied: deniedSocket };
    if (process.argv[2] === "--child") {
      phase = "child-sockets";
      process.stdout.write(JSON.stringify({ pid: process.pid, ppid: process.ppid, checks: await runNetworkChecks(checks) }) + "\n");
    } else {
      phase = "runtime";
      const runtime = snapshotRuntime();
      assertMatchingRuntime(JSON.parse(readFileSync("/harness/expected-runtime.json", "utf8")), runtime);
      mkdirSync(env.HOME, { mode: 0o700 });
      phase = "parent-and-child-sockets";
      const tree = await verifyNetworkTree(checks, async () => {
        const child = await promisify(execFile)(process.execPath, [self, "--child"], { env, encoding: "utf8", timeout: 10000, killSignal: "SIGKILL", maxBuffer: 65536 });
        if (child.stderr) throw Error();
        return child.stdout;
      });
      phase = "report";
      writeFileSync("/evidence/verification.json", JSON.stringify({ version: 1, kind: "network-denied-readiness-not-pi-execution", runtime, ...tree }), { flag: "wx", mode: 0o600 });
      process.stdout.write("OFFLINE_VERIFIED\n");
      if (["--synthetic-pi", "--synthetic-guild"].includes(process.argv[2])) {
        const guild = process.argv[2] === "--synthetic-guild";
        phase = guild ? "synthetic-guild" : "synthetic-pi";
        const { runSyntheticProbe } = await import("./offline-probe.ts");
        await runSyntheticProbe(guild ? "/evidence/synthetic-guild" : "/evidence/synthetic");
        process.stdout.write(guild ? "SYNTHETIC_GUILD_VERIFIED\n" : "SYNTHETIC_PI_VERIFIED\n");
      }
    }
  } catch { process.stderr.write(`Offline verification failed (${phase})\n`); process.exitCode = 1; }
  finally { clearTimeout(watchdog); }
}

interface Checks {
  state: () => NetworkState;
  loopback: () => Promise<void>;
  denied: (protocol: "tcp" | "udp", family: 4 | 6) => Promise<string>;
}
export async function runNetworkChecks(checks: Checks) {
  const before = assertNetworkIsolation(checks.state());
  await checks.loopback();
  const denials: { protocol: "tcp" | "udp"; family: 4 | 6; error: string }[] = [];
  for (const protocol of ["tcp", "udp"] as const) for (const family of [4, 6] as const) {
    const error = await checks.denied(protocol, family);
    if (error !== "ENETUNREACH") throw new Error("Offline socket denial unverified");
    denials.push({ protocol, family, error });
  }
  const after = assertNetworkIsolation(checks.state());
  if (before.namespace !== after.namespace || before.uid !== after.uid) throw new Error("Offline namespace changed");
  return { ...before, loopbackTCP: true, denials };
}
