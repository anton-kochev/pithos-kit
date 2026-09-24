import { createHash } from "node:crypto";

export interface Fixture {
  files: Record<string, string>;
  staged: Record<string, string>;
  untracked: Record<string, string>;
}
export interface EvalTask {
  id: string;
  split: "development" | "promotion";
  prompt: string;
  fixture: Fixture;
  fixtureDigest: string;
  allowedChanges: string[];
  grader: "unchanged" | "authorization";
  rubric: string[];
  delegation: "abstain" | "optional";
}
export interface TaskBank { version: 1; tasks: EvalTask[] }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`Invalid evaluation manifest: ${message}`);
}
function object(raw: unknown): Record<string, unknown> {
  check(raw && typeof raw === "object" && !Array.isArray(raw), "expected object");
  return raw as Record<string, unknown>;
}
function keys(raw: Record<string, unknown>, expected: string[]): void {
  check(Object.keys(raw).length === expected.length && expected.every(k => Object.hasOwn(raw, k)), "unknown or missing field");
}
function text(raw: unknown, max = 16000): asserts raw is string {
  check(typeof raw === "string" && raw.trim() && Buffer.byteLength(raw) <= max && !raw.includes("\u0000"), "invalid text");
}
export function safePath(raw: unknown): asserts raw is string {
  text(raw, 240);
  check(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(raw), `unsafe path ${raw}`);
  check(raw.split("/").every(p => ![".", "..", ".git", ".pi", "node_modules", "__proto__", "constructor", "prototype"].includes(p.toLowerCase())), `reserved path ${raw}`);
}
function paths(raw: unknown): asserts raw is string[] {
  check(Array.isArray(raw) && raw.length <= 256, "expected bounded path list");
  raw.forEach(safePath);
  check(new Set(raw).size === raw.length, "duplicate path");
}
function fileMap(raw: unknown): Record<string, string> {
  const map = object(raw);
  check(Object.keys(map).length <= 256, "too many files");
  for (const [name, content] of Object.entries(map)) {
    safePath(name);
    check(typeof content === "string" && Buffer.byteLength(content) <= 65536, "invalid file content");
  }
  return map as Record<string, string>;
}
export function validateBank(raw: unknown): TaskBank {
  const bank = object(raw);
  keys(bank, ["version", "tasks"]);
  check(bank.version === 1, "unsupported version");
  check(Array.isArray(bank.tasks) && bank.tasks.length > 0 && bank.tasks.length <= 100, "invalid task count");
  const ids = new Set<string>();
  for (const rawTask of bank.tasks) {
    const task = object(rawTask);
    keys(task, ["id", "split", "prompt", "fixture", "fixtureDigest", "allowedChanges", "grader", "rubric", "delegation"]);
    text(task.id, 80);
    check(/^[a-z][a-z0-9-]*$/.test(task.id) && !ids.has(task.id), "invalid or duplicate task ID");
    ids.add(task.id);
    check(task.split === "development" || task.split === "promotion", "unknown split");
    text(task.prompt);
    check(task.delegation === "abstain" || task.delegation === "optional", "unknown delegation expectation");
    check(task.grader === "unchanged" || task.grader === "authorization", "unknown grader");
    check(Array.isArray(task.rubric) && task.rubric.length > 0 && task.rubric.length <= 20, "missing rubric");
    task.rubric.forEach(r => text(r, 2000));
    paths(task.allowedChanges);
    const fixture = object(task.fixture);
    keys(fixture, ["files", "staged", "untracked"]);
    const files = fileMap(fixture.files), staged = fileMap(fixture.staged), untracked = fileMap(fixture.untracked);
    check(Object.keys(files).length > 0, "empty fixture");
    check(Object.keys(staged).every(p => Object.hasOwn(files, p)), "staged overlay must target tracked files");
    check(Object.keys(untracked).every(p => !Object.hasOwn(files, p)), "untracked overlay collides with tracked files");
    const names = [...Object.keys(files), ...Object.keys(untracked)].sort();
    check(new Set(names.map(p => p.toLowerCase())).size === names.length, "case-colliding files");
    check(!names.some(p => names.some(q => q !== p && q.toLowerCase().startsWith(`${p.toLowerCase()}/`))), "file/directory collision");
    check(Buffer.byteLength(canonical(fixture)) <= 1048576, "fixture exceeds 1 MiB");
    check(task.fixtureDigest === digest(fixture), "fixture digest mismatch");
  }
  return structuredClone(raw) as TaskBank;
}
