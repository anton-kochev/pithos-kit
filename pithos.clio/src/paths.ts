import { lstat, open, opendir, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import type { Config } from './config.ts';
import { redactSensitive } from './redact.ts';

// Hidden paths, dependencies, build output and agent-instruction files are never read or written.
const EXCLUDED = /(^|\/)(?:\.[^/]+|node_modules|vendor|dist|build|coverage|generated|target|bin|obj)(\/|$)|(^|\/)(?:AGENTS(?:\.override)?|CLAUDE|SKILL|SYSTEM|APPEND_SYSTEM)\.md$|(^|\/)[^/]*(?:secret|credential|password)[^/]*$|\.(?:env|pem|key|p12|pfx)$/i;
const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.svelte', '.vue', '.css', '.html',
  '.py', '.rs', '.go', '.cs', '.fs', '.java', '.kt', '.rb', '.php', '.swift', '.c', '.h', '.cpp', '.hpp',
  '.sql', '.sh', '.json', '.yaml', '.yml', '.toml', '.proto', '.graphql', '.csproj', '.sln',
]);
/** Strong credential shapes. Docs Clio writes must never contain these. */
const CREDENTIAL = /-----BEGIN [^-]*PRIVATE KEY-----|\b(?:sk-[a-zA-Z0-9_-]{16,}|gh[pousr]_[a-zA-Z0-9]{16,}|AKIA[A-Z0-9]{16})\b|\b(?:authorization|proxy-authorization)\s*:\s*bearer\s+\S{8,}/i;
const GENERATED = /do\s+not\s+edit|auto-?generated|generated\s+by/i;

export const MAX_FILE_BYTES = 200_000;

export function isExcluded(path: string): boolean {
  return EXCLUDED.test(path);
}

/** A relative, forward-slash path that stays inside the project. */
export function isSafeRelative(path: string): boolean {
  return !!path && !path.startsWith('/') && !path.includes('\\') && !path.includes('\0') &&
    path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

export function isDoc(path: string, config: Pick<Config, 'docsDirs'>): boolean {
  if (!isSafeRelative(path) || isExcluded(path) || extname(path) !== '.md') return false;
  if (basename(path) === 'README.md') return true;
  return dirname(path).split('/').includes('docs') || config.docsDirs.some(dir => path.startsWith(`${dir}/`));
}

/** Minimal glob: `**` spans directories (including none), `*` and `?` stay within one. */
export function globToRegExp(glob: string): RegExp {
  let pattern = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { pattern += '(?:.*/)?'; i += 2; } else { pattern += '.*'; i += 1; }
    } else if (c === '*') pattern += '[^/]*';
    else if (c === '?') pattern += '[^/]';
    else pattern += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${pattern}$`);
}

/** A doc Clio may read for context but never edit, such as an ADR. */
export function isReadOnlyDoc(path: string, config: Pick<Config, 'readOnlyDocs'>): boolean {
  return config.readOnlyDocs.some(glob => globToRegExp(glob).test(path));
}

/** A doc Clio may edit, or a path where it may add a page. */
export function isEditableDoc(path: string, config: Pick<Config, 'docsDirs' | 'readOnlyDocs'>): boolean {
  return isDoc(path, config) && !isReadOnlyDoc(path, config);
}

export function containsCredential(text: string): boolean {
  return CREDENTIAL.test(text);
}

export function looksGenerated(text: string): boolean {
  return GENERATED.test(text.split('\n', 6).join('\n'));
}

async function assertInside(root: string, path: string): Promise<string> {
  if (!isSafeRelative(path) || isExcluded(path)) throw new Error(`path not allowed: ${path}`);
  const base = await realpath(root);
  let current = base;
  for (const part of path.split('/')) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error(`symlink refused: ${path}`);
  }
  const real = await realpath(current);
  if (real !== resolve(base, path) || !real.startsWith(base + sep)) throw new Error(`path escapes the project: ${path}`);
  return real;
}

export interface ReadResult { path: string; text: string; redacted: boolean }

/** Reads a whole UTF-8 text file inside the project. Credential lines come back redacted. */
export async function readProjectFile(root: string, path: string): Promise<ReadResult> {
  if (!TEXT_EXTENSIONS.has(extname(path)) && basename(path) !== 'Dockerfile' && basename(path) !== 'Makefile') {
    throw new Error(`not a text source file: ${path}`);
  }
  const absolute = await assertInside(root, path);
  const handle = await open(absolute, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`not a regular file: ${path}`);
    if (stat.size > MAX_FILE_BYTES) throw new Error(`file too large (${stat.size} bytes, max ${MAX_FILE_BYTES}): ${path}`);
    const buffer = Buffer.alloc(stat.size);
    await handle.read(buffer, 0, stat.size, 0);
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    if (raw.includes('\0')) throw new Error(`binary file: ${path}`);
    const text = redactSensitive(raw);
    return { path, text, redacted: text !== raw };
  } finally {
    await handle.close();
  }
}

/** Reads a doc exactly as it is on disk, for applying an edit. */
export async function readExact(root: string, path: string): Promise<string> {
  const absolute = await assertInside(root, path);
  return new TextDecoder('utf-8', { fatal: true }).decode(await readFile(absolute));
}

export async function absolutePath(root: string, path: string): Promise<string> {
  return assertInside(root, path);
}

/** Absolute target for a new page: its directory must already exist inside the project. */
export async function newFileTarget(root: string, path: string): Promise<string> {
  const parent = dirname(path);
  const absoluteParent = parent === '.' ? await realpath(root) : await assertInside(root, parent);
  if (!(await lstat(absoluteParent)).isDirectory()) throw new Error(`not a directory: ${parent}`);
  return join(absoluteParent, basename(path));
}

export interface Listing { path: string; entries: string[]; truncated: boolean }

/** Immediate children of a project directory: directories end with `/`, files carry their size. */
export async function listProjectDir(root: string, path: string): Promise<Listing> {
  const absolute = path === '.' ? await realpath(root) : await assertInside(root, path);
  const entries: string[] = [];
  let truncated = false;
  for await (const entry of await opendir(absolute)) {
    const child = path === '.' ? entry.name : `${path}/${entry.name}`;
    if (isExcluded(child)) continue;
    if (entries.length >= 200) { truncated = true; break; }
    if (entry.isDirectory()) entries.push(`${child}/`);
    else if (entry.isFile()) entries.push(`${child} (${(await lstat(join(absolute, entry.name))).size} B)`);
  }
  return { path, entries: entries.sort(), truncated };
}
