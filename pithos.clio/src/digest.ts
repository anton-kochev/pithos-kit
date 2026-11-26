import { lstat, opendir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Collection, SessionWindow } from './collect.ts';
import type { Config } from './config.ts';
import type { CommitInfo } from './git.ts';
import { isDoc, isExcluded } from './paths.ts';
import { ProposalSchema } from './proposal.ts';

export interface DigestInput {
  from: string;
  to: string;
  commits: CommitInfo[];
  truncatedRange: boolean;
  diff: string;
  changedPaths: string[];
  collection: Collection;
  docs: DocMap;
}

export interface DocMap {
  /** Existing README.md files nearest to the changed paths, root first. */
  nearby: string[];
  /** Markdown pages found under docs directories (and configured docsDirs). */
  pages: string[];
  /** Existing docs directories a new page may go into. */
  directories: string[];
}

async function exists(root: string, path: string, kind: 'file' | 'dir'): Promise<boolean> {
  try {
    const stat = await lstat(join(root, path));
    return kind === 'file' ? stat.isFile() : stat.isDirectory();
  } catch { return false; }
}

async function walkDocs(root: string, dir: string, depth: number, pages: string[], directories: string[], config: Config): Promise<void> {
  if (depth > 3 || pages.length >= 200 || isExcluded(dir) || !(await exists(root, dir, 'dir'))) return;
  directories.push(dir);
  for await (const entry of await opendir(join(root, dir))) {
    const child = `${dir}/${entry.name}`;
    if (entry.isDirectory()) await walkDocs(root, child, depth + 1, pages, directories, config);
    else if (entry.isFile() && isDoc(child, config) && pages.length < 200) pages.push(child);
  }
}

/** Finds the docs a change could affect: ancestor READMEs of changed paths and docs trees. */
export async function mapDocs(root: string, changedPaths: string[], config: Config): Promise<DocMap> {
  const nearby = new Set<string>();
  const docDirs = new Set<string>(['docs', ...config.docsDirs]);
  for (const path of changedPaths) {
    if (isExcluded(path)) continue;
    for (let dir = dirname(path); ; dir = dirname(dir)) {
      const readme = dir === '.' ? 'README.md' : `${dir}/README.md`;
      if (await exists(root, readme, 'file')) nearby.add(readme);
      if (dir !== '.') docDirs.add(`${dir}/docs`);
      if (dir === '.' || dir === '/') break;
    }
  }
  const pages: string[] = [];
  const directories: string[] = [];
  for (const dir of [...docDirs].sort()) await walkDocs(root, dir, 0, pages, directories, config);
  return { nearby: [...nearby].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b)), pages: pages.sort(), directories };
}

function windowText(window: SessionWindow, label: string): string {
  const lines = [`### ${label} · cite as ${window.entryIds.map(id => `entry:${id}`).join(', ')}`];
  if (window.failure) lines.push(`[failed tool call before this]\n${window.failure}`);
  if (window.assistant) lines.push(`[assistant]\n${window.assistant}`);
  if (window.user) lines.push(`[user]\n${window.user}`);
  return lines.join('\n');
}

/** The worker's task message. Plain Markdown: easier for the model than nested JSON. */
export function buildTask(input: DigestInput, maxDiffChars: number): string {
  const { collection } = input;
  const diff = input.diff.length > maxDiffChars
    ? `${input.diff.slice(0, maxDiffChars)}\n[diff truncated at ${maxDiffChars} characters; read files for the rest]`
    : input.diff;
  const sessionHeading = collection.classified
    ? `${collection.windows.length} of ${collection.considered} session excerpts, picked by a classifier as decisions, reasons, gotchas or constraints`
    : `the ${collection.windows.length} most recent of ${collection.considered} session excerpts (no classifier; not pre-filtered)`;
  const sections = [
    `# Commits ${input.from.slice(0, 12)}..${input.to.slice(0, 12)}${input.truncatedRange ? ' (only the newest commits; the range was capped)' : ''}`,
    ...input.commits.map(c => `- commit:${c.sha.slice(0, 12)} ${c.subject}${c.body ? `\n  ${c.body.slice(0, 600).replace(/\n/g, '\n  ')}` : ''}`),
    '',
    '# Diff',
    '```diff', diff || '(no textual changes outside excluded paths)', '```',
    '',
    `# Session (${sessionHeading})`,
    collection.windows.length ? '' : '(no excerpts)',
    ...collection.windows.flatMap(window => [
      ...(window.previous && !collection.windows.some(w => w.index === window.previous!.index) ? [windowText(window.previous, 'Context just before')] : []),
      windowText(window, window.kind ? `Excerpt (${window.kind})` : 'Excerpt'),
      '',
    ]),
    '# Documentation',
    `READMEs near the changed files: ${input.docs.nearby.join(', ') || '(none)'}`,
    `Pages under docs directories: ${input.docs.pages.join(', ') || '(none)'}`,
    `Directories a new page may go into: ${input.docs.directories.join(', ') || '(none; edit an existing README instead)'}`,
    '',
    '# Answer schema',
    JSON.stringify(ProposalSchema),
  ];
  return sections.join('\n');
}
