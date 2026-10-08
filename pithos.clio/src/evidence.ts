import { createHash } from 'node:crypto';
import { lstat, open, realpath, readdir } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import type { Config } from './config.ts';
import type { Destination } from './destinations.ts';
import { redactSensitive, type SessionObservation } from './context.ts';

const excluded = /(^|\/)(?:\.[^/]+|node_modules|vendor|dist|build|coverage|assets|generated|skills?|prompts?|instructions?)(\/|$)|(?:^|\/)(?:AGENTS(?:\.override)?|CLAUDE|SKILL|SYSTEM|APPEND_SYSTEM)\.md$|(?:secret|credential|password|token|private|instructions?|\.generated\.|\.min\.)/i;
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.go', '.cs', '.java', '.rb', '.md']);
export interface Snapshot { path: string; text: string; hash: string; dev: number; ino: number; doc: boolean }
export function isExcludedEvidencePath(path: string): boolean { return excluded.test(path); }
export function isDoc(path: string, config: Config): boolean {
  return !excluded.test(path) && (/(^|\/)README\.md$/.test(path) || (path.endsWith('.md') && (path.split('/').slice(0, -1).includes('docs') || config.docsDirs.some(d => path.startsWith(d + '/')))));
}
// Pi 1.0.3 resolveToCwd uses normalizePath with stripAtPrefix and
// normalizeUnicodeSpaces, plus tilde/file-URL expansion. Do not admit aliases.
// Check the canonical absolute path too: its root can contain Unicode spaces.
export function assertStableEditPath(path: string): void {
  if (path.startsWith('@') || /^~(?:\/|$)/.test(path) || path.startsWith('file://') || /[\u00a0\u2000-\u200a\u202f\u205f\u3000]/.test(path)) throw new Error('Clio: path normalization refused');
}
export async function safeDirectory(root: string, path: string): Promise<string> {
  const base = await realpath(root);
  if (path === '.') return base;
  if (!path || isAbsolute(path) || path.includes('\\') || path.split('/').some(p => !p || p === '.' || p === '..') || excluded.test(path)) throw new Error('Clio: excluded directory');
  let target = base;
  for (const part of path.split('/')) {
    target = join(target, part);
    const stat = await lstat(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Clio: unsafe directory');
  }
  if (await realpath(target) !== resolve(base, path)) throw new Error('Clio: canonical directory changed');
  return target;
}
export function assertSafeContent(text: string, config: Config): void {
  if (Buffer.byteLength(text, 'utf8') > config.maxContextBytes) throw new Error('Clio: file budget exceeded');
  if (text.includes('\0') || redactSensitive(text) !== text || /(?:auto[- ]?generated|<!--\s*generated|do not edit|BEGIN .*PRIVATE KEY|(?:api[_-]?key|password|secret)\s*[:=]\s*["'][^"']{8,})/i.test(text)) throw new Error('Clio: generated or sensitive content refused');
}
export async function safeFile(root: string, path: string, config: Config, doc = false): Promise<Snapshot> {
  assertStableEditPath(path);
  if (!path || isAbsolute(path) || path.includes('\\') || path.split('/').some(p => !p || p === '.' || p === '..') || excluded.test(path) || !sourceExtensions.has(extname(path)) || (doc && !isDoc(path, config))) throw new Error(`Clio: excluded path ${path}`);
  const base = await realpath(root);
  assertStableEditPath(resolve(base, path));
  let target = base;
  for (const part of path.split('/')) {
    target = join(target, part);
    if ((await lstat(target)).isSymbolicLink()) throw new Error('Clio: symlink refused');
  }
  if (await realpath(target) !== resolve(base, path)) throw new Error('Clio: canonical path changed');
  const handle = await open(target, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > config.maxContextBytes) throw new Error('Clio: file budget exceeded');
    const buffer = Buffer.alloc(config.maxContextBytes + 1);
    const {bytesRead} = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > config.maxContextBytes) throw new Error('Clio: growing file exceeds budget');
    const text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(buffer.subarray(0, bytesRead));
    assertSafeContent(text, config);
    return {path, text, hash: createHash('sha256').update(text).digest('hex'), dev: stat.dev, ino: stat.ino, doc: isDoc(path, config)};
  } finally { await handle.close(); }
}
export async function snapshot(root: string, observed: string[], config: Config): Promise<Snapshot[]> {
  const paths = new Set(observed.map(p => isAbsolute(p) ? relative(root, p) : p));
  const dirs = new Set<string>(['docs', ...config.docsDirs]);
  for (const path of [...paths]) {
    let dir = dirname(path);
    for (let depth = 0; depth < 12 && dir !== '..'; depth++) {
      paths.add(dir === '.' ? 'README.md' : `${dir}/README.md`);
      dirs.add(dir === '.' ? 'docs' : `${dir}/docs`);
      if (dir === '.') break;
      dir = dirname(dir);
    }
  }
  let visited = 0;
  async function discover(dir: string, depth: number): Promise<void> {
    if (depth > 3 || excluded.test(dir) || dir.split('/').includes('..') || visited++ > 100) return;
    try {
      const stat = await lstat(join(root, dir));
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      for (const ent of (await readdir(join(root, dir), {withFileTypes: true})).slice(0, 100)) {
        if (ent.isDirectory()) await discover(`${dir}/${ent.name}`, depth + 1);
        else if (ent.isFile() && ent.name.endsWith('.md')) paths.add(`${dir}/${ent.name}`);
      }
    } catch { /* Missing documentation is normal; never create it implicitly. */ }
  }
  for (const dir of dirs) await discover(dir, 0);
  const files: Snapshot[] = [];
  let bytes = 0;
  for (const path of paths) {
    if (files.length >= config.maxFiles) break;
    try {
      const file = await safeFile(root, path, config);
      const size = Buffer.byteLength(JSON.stringify(file));
      if (bytes + size > config.maxContextBytes) continue;
      files.push(file); bytes += size;
    } catch { /* Ineligible evidence is not sent to the worker. */ }
  }
  return files;
}
const text = Type.String({minLength: 1, maxLength: 4000});
const lines = {startLine: Type.Integer({minimum: 1}), endLine: Type.Integer({minimum: 1})};
const Source = Type.Union([
  Type.Object({path: text, ...lines}, {additionalProperties: false}),
  Type.Object({entryId: text, ...lines, quote: text}, {additionalProperties: false}),
]);
export const ProposalSchema = Type.Object({
  findings: Type.Array(Type.Object({claim: text, kind: Type.Union([Type.Literal('observed'), Type.Literal('unknown')]), sources: Type.Array(Source, {minItems: 1, maxItems: 8})}, {additionalProperties: false}), {maxItems: 20}),
  edits: Type.Array(Type.Object({path: text, oldText: Type.String({minLength: 1, maxLength: 20000}), newText: Type.String({maxLength: 20000}), findings: Type.Array(Type.Integer({minimum: 0}), {minItems: 1, maxItems: 20})}, {additionalProperties: false}), {maxItems: 20}),
  creates: Type.Optional(Type.Array(Type.Object({path: text, content: Type.String({minLength: 1, maxLength: 100000}), findings: Type.Array(Type.Integer({minimum: 0}), {minItems: 1, maxItems: 20})}, {additionalProperties: false}), {maxItems: 20})),
  unresolved: Type.Array(text, {maxItems: 20}),
}, {additionalProperties: false});
export type Proposal = Static<typeof ProposalSchema>;
export function validateProposal(raw: string, files: Snapshot[], config: Config, session: SessionObservation[] = [], destinations: Destination[] = []): Proposal {
  if (Buffer.byteLength(raw) > config.maxResultBytes) throw new Error('Clio: result budget exceeded');
  let p: unknown;
  try { p = JSON.parse(raw); } catch { throw new Error('Clio: expected exact JSON'); }
  if (!Value.Check(ProposalSchema, p) || p.edits.length + (p.creates?.length ?? 0) > config.maxEdits) throw new Error('Clio: invalid proposal shape');
  const byPath = new Map(files.map(f => [f.path, f]));
  for (const finding of p.findings) for (const ref of finding.sources) {
    const f = 'path' in ref ? byPath.get(ref.path) : session.find(e => e.entryId === ref.entryId);
    if (!f || ref.endLine < ref.startLine || ref.endLine > f.text.split('\n').length) throw new Error('Clio: invalid source reference');
    if ('entryId' in ref) {
      const observation = f as SessionObservation;
      const quote = observation.text.split('\n').slice(ref.startLine - 1, ref.endLine).join('\n');
      if (ref.quote !== quote || /\[(?:REDACTED|OMITTED)/.test(quote) || (observation.role === 'assistant' && finding.kind !== 'unknown')) throw new Error('Clio: invalid session evidence or unmarked assistant inference');
    }
  }
  const edited = new Set<string>();
  for (const edit of p.edits) {
    const file = byPath.get(edit.path);
    if (!file?.doc || edited.has(edit.path) || file.text.split(edit.oldText).length !== 2 || edit.findings.some(i => !p.findings[i])) throw new Error('Clio: invalid or ungrounded patch');
    edited.add(edit.path);
  }
  for (const create of p.creates ?? []) {
    assertCreatePath(create.path, destinations, config);
    if (byPath.has(create.path) || edited.has(create.path) || create.findings.some(i => !p.findings[i])) throw new Error('Clio: invalid or ungrounded create');
    assertSafeContent(create.content, config);
    edited.add(create.path);
  }
  return p;
}
export function assertCreatePath(path: string, destinations: Destination[], config: Config): Destination {
  assertStableEditPath(path);
  const destination = destinations.find(d => d.path === dirname(path));
  if (!destination || isAbsolute(path) || path.includes('\\') || path.split('/').some(p => !p || p === '.' || p === '..') || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.md$/.test(basename(path)) || !isDoc(path, config) || excluded.test(path)) throw new Error('Clio: invalid create destination');
  return destination;
}
