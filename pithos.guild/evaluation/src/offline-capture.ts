import { spawn } from "node:child_process";
import { openSync, writeSync, closeSync } from "node:fs";
import { join } from "node:path";

export async function captureProcess(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, directory: string, timeoutMs = 20000, childTrace = false) {
  const out = openSync(join(directory, "stdout.jsonl"), "wx", 0o600);
  let err: number | undefined, trace: number | undefined;
  try {
    err = openSync(join(directory, "stderr.txt"), "wx", 0o600);
    if (childTrace) trace = openSync(join(directory, "children.jsonl"), "wx", 0o600);
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe", ...(trace === undefined ? [] : [trace])] });
    let timedOut = false, limited = false, captureFailed = false;
    const kill = () => { if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already reaped. */ } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const sink = (fd: number) => {
      let bytes = 0;
      return (chunk: Buffer) => {
        const kept = chunk.subarray(0, Math.max(0, 1024 * 1024 - bytes)); bytes += chunk.length;
        try { for (let offset = 0; offset < kept.length;) { const n = writeSync(fd, kept, offset, kept.length - offset); if (!n) throw Error(); offset += n; } }
        catch { captureFailed = true; kill(); }
        if (bytes > 1024 * 1024) { limited = true; kill(); }
      };
    };
    child.stdout!.on("data", sink(out)); child.stderr!.on("data", sink(err));
    child.once("error", () => { captureFailed = true; kill(); });
    child.once("exit", kill); // Do not leave ordinary descendants holding pipes open.
    return await new Promise<{ pid: number | undefined; status: number | null; signal: string | null; timedOut: boolean; limited: boolean; captureFailed: boolean }>(resolve => {
      child.once("close", (status, signal) => { clearTimeout(timer); resolve({ pid: child.pid, status, signal, timedOut, limited, captureFailed }); });
    });
  } finally { closeSync(out); if (err !== undefined) closeSync(err); if (trace !== undefined) closeSync(trace); }
}
