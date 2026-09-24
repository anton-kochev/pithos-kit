import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { safePath, type Fixture } from "./manifest.ts";

const exec = promisify(execFile);
export async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  // Do not inherit GIT_DIR, GIT_INDEX_FILE, templates, or user hooks/config.
  const result = await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.autocrlf=false", ...args], {
    cwd, env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...env },
    timeout: 10000, maxBuffer: 8 * 1024 * 1024, signal, killSignal: "SIGKILL",
  });
  return result.stdout;
}
export async function createFixture(cwd: string, fixture: Fixture, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await mkdir(cwd); // Exclusive admission: never reset or reuse an existing directory.
  await git(cwd, ["init", "--quiet", "--template=", "--initial-branch=eval"], {}, signal);
  const put = async (files: Record<string, string>) => {
    for (const [name, content] of Object.entries(files)) {
      signal?.throwIfAborted();
      safePath(name);
      await mkdir(dirname(join(cwd, name)), { recursive: true });
      await writeFile(join(cwd, name), content, { signal });
    }
  };
  await put({ ...fixture.files, ...fixture.staged });
  await git(cwd, ["add", "--", ...Object.keys(fixture.files)], {}, signal);
  await put(fixture.files);
  await put(fixture.untracked);
}
export interface FileState { kind: "file" | "symlink"; digest: string; mode: number }
export interface Snapshot { files: Record<string, FileState>; index: string; status: string; diff: string }
export async function snapshot(cwd: string, signal?: AbortSignal): Promise<Snapshot> {
  signal?.throwIfAborted();
  const files: Record<string, FileState> = Object.create(null);
  let bytes = 0, entries = 0;
  const walk = async (relative: string) => {
    signal?.throwIfAborted();
    for (const name of (await readdir(join(cwd, relative))).sort()) {
      signal?.throwIfAborted();
      if (!relative && name === ".git") continue;
      const file = relative ? `${relative}/${name}` : name;
      if (++entries > 2000 || file.split("/").length > 32) throw new Error("Snapshot directory limit exceeded");
      const info = await lstat(join(cwd, file));
      if (info.isDirectory()) { await walk(file); continue; }
      if (Object.keys(files).length >= 1000) throw new Error("Snapshot file limit exceeded");
      if (!info.isFile() && !info.isSymbolicLink()) throw new Error(`Unsupported file type: ${file}`);
      bytes += info.size;
      if (bytes > 8 * 1024 * 1024) throw new Error("Snapshot byte limit exceeded");
      const data = info.isSymbolicLink() ? await readlink(join(cwd, file)) : await readFile(join(cwd, file), { signal });
      files[file] = { kind: info.isSymbolicLink() ? "symlink" : "file", digest: createHash("sha256").update(data).digest("hex"), mode: info.mode & 0o777 };
    }
  };
  await walk("");
  return {
    files,
    index: await git(cwd, ["ls-files", "--stage", "-z"], {}, signal),
    status: await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {}, signal),
    diff: await git(cwd, ["diff", "--binary", "--no-ext-diff", "--no-textconv"], {}, signal),
  };
}
export function changedPaths(before: Snapshot, after: Snapshot): string[] {
  return [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])]
    .filter(p => JSON.stringify(before.files[p]) !== JSON.stringify(after.files[p])).sort();
}
