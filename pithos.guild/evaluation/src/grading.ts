import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { EvalTask } from "./manifest.ts";
import { changedPaths, snapshot, type Snapshot } from "./fixture.ts";
import { requireConfinedGrading } from "./grading-boundary.ts";

// The checker is sent on stdin to an external driver, never copied into the fixture.
// Candidate modules still execute arbitrary JS: this is NOT a hostile-code sandbox.
const authorizationChecks = `
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const { updateUser } = await import(pathToFileURL(resolve('src/users.mjs')).href);
for (const [actor, target, allowed] of [
  [{id:'a'}, 'a', true], [{id:'a'}, 'b', false],
  [{id:'a',admin:true}, 'b', true], [{id:'',admin:true}, 'b', false],
  [{id:'a',admin:'true'}, 'b', false], [{id:'a',admin:1}, 'b', false],
]) {
  let saves = 0, invalidSave = false;
  const store = { save(id, name) {
    saves++;
    try { assert.equal(id, target); assert.equal(name, 'New'); }
    catch (error) { invalidSave = true; throw error; }
    return 'saved';
  } };
  if (allowed) assert.equal(await updateUser(actor, target, 'New', store), 'saved');
  else await assert.rejects(async () => updateUser(actor, target, 'New', store));
  assert.equal(saves, allowed ? 1 : 0);
  assert.equal(invalidSave, false); // Catching the callback assertion cannot erase its failure.
}
const error = new Error('persistence');
await assert.rejects(() => updateUser({id:'a'}, 'a', 'New', {save() {throw error;}}), e => e === error);
`;

export async function runNodeCheck(cwd: string, source: string, signal?: AbortSignal): Promise<{ passed: boolean; diagnostic: string; cancelled: boolean }> {
  if (signal?.aborted) return { passed: false, diagnostic: "Checker cancelled before launch", cancelled: true };
  return new Promise(resolve => {
    const marker = `guild-check-complete-${randomUUID()}`;
    const child = spawn(process.execPath, ["--input-type=module"], {
      cwd, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH, HOME: cwd, NODE_ENV: "test" },
    });
    let output = "", terminated = false, cancelled = false;
    const kill = () => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") { terminated = true; output += "Checker process cleanup failed\n"; } }
    };
    const stop = () => { terminated = true; kill(); };
    const abort = () => { cancelled = true; stop(); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(stop, 5000);
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      if (Buffer.byteLength(output) > 65536) { output = output.slice(0, 32768); stop(); }
    };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    child.stdin.on("error", () => undefined);
    child.on("error", e => { output += e.message; });
    child.on("close", code => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      kill(); // Early parent exit must not leave ordinary descendant writers behind.
      resolve({ passed: code === 0 && !terminated && output.split("\n").includes(marker), cancelled,
        diagnostic: cancelled ? `Checker cancelled\n${output}` : terminated ? `Checker limit exceeded\n${output}` : output.replace(marker, "[checks completed]") });
    });
    child.stdin.end(`${source}\nconsole.log(${JSON.stringify(marker)});\n`);
  });
}
// Connected entry has no caller-supplied launcher or unsafe fallback. Until owned
// confinement/import exists, dynamic grading cannot enter the legacy checker.
export async function gradeConnectedOutcome(task: EvalTask, cwd: string, baseline: Snapshot, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (task.grader === "authorization") requireConfinedGrading();
  return gradeOutcome(task, cwd, baseline, signal);
}

// Historical local/inert route, NOT a supervisor isolation boundary.
export async function gradeOutcome(task: EvalTask, cwd: string, baseline: Snapshot, signal?: AbortSignal) {
  signal?.throwIfAborted();
  // Snapshot before executing checks; checker side effects cannot masquerade as agent work.
  const final = await snapshot(cwd, signal);
  const changed = changedPaths(baseline, final);
  const scope = changed.every(p => task.allowedChanges.includes(p)) && baseline.index === final.index;
  const result = task.grader === "authorization"
    ? await runNodeCheck(cwd, authorizationChecks, signal)
    : { passed: changed.length === 0 && baseline.index === final.index, diagnostic: "Read-only state check only; prose requires review.", cancelled: signal?.aborted ?? false };
  const afterCheck = signal?.aborted ? undefined : await snapshot(cwd, signal);
  const checkerMutated = afterCheck ? changedPaths(final, afterCheck).length > 0 || final.index !== afterCheck.index : null;
  return {
    behavior: result.passed && !result.cancelled && checkerMutated === false,
    checkCancelled: result.cancelled,
    scope, changed, indexPreserved: baseline.index === final.index,
    diagnostic: result.diagnostic, checkerMutated,
    review: "pending" as const,
    // Deterministic gates never certify report truth, test quality, or complete task success.
    taskSuccess: null,
    final,
  };
}
