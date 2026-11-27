import { basename } from 'node:path';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import type { Config } from './config.ts';
import { expectedEdit } from './edit-content.ts';
import { containsCredential, isDoc, isReadOnlyDoc } from './paths.ts';

// Must list the same kinds as USEFUL_EDIT_KINDS (checked by a test); junk kinds are not valid output.
const Kind = Type.Union([
  Type.Literal('decision'), Type.Literal('rationale'), Type.Literal('invariant'),
  Type.Literal('gotcha'), Type.Literal('howto'), Type.Literal('interface'),
]);
const Sources = Type.Array(Type.String({ minLength: 3, maxLength: 300 }), { minItems: 1, maxItems: 8 });
const Purpose = Type.String({ minLength: 1, maxLength: 400 });

export const ProposalSchema = Type.Object({
  edits: Type.Array(Type.Object({
    path: Type.String({ minLength: 1, maxLength: 300 }),
    oldText: Type.String({ minLength: 1, maxLength: 20_000 }),
    newText: Type.String({ maxLength: 20_000 }),
    kind: Kind,
    value: Purpose,
    sources: Sources,
  }, { additionalProperties: false }), { maxItems: 20 }),
  creates: Type.Optional(Type.Array(Type.Object({
    path: Type.String({ minLength: 1, maxLength: 300 }),
    content: Type.String({ minLength: 1, maxLength: 60_000 }),
    kind: Kind,
    value: Purpose,
    sources: Sources,
  }, { additionalProperties: false }), { maxItems: 10 })),
  unresolved: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 10 }),
}, { additionalProperties: false });

export type Proposal = Static<typeof ProposalSchema>;
export type ProposedEdit = Proposal['edits'][number];
export type ProposedCreate = NonNullable<Proposal['creates']>[number];

/** What the host knows, to check the worker's citations and targets against. */
export interface Evidence {
  /** Exact text of every doc the worker read in full during this run. */
  readDocs: Map<string, string>;
  readFiles: Set<string>;
  changedPaths: Set<string>;
  entryIds: Set<string>;
  commits: string[];
}

const NEW_PAGE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.md$/;

export class ProposalError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`proposal rejected: ${problems.join('; ')}`);
    this.problems = problems;
  }
}

/** Pulls the JSON object out of the worker's final answer, tolerating a code fence around it. */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end < start) throw new ProposalError(['the answer contains no JSON object']);
  try { return JSON.parse(text.slice(start, end + 1)); } catch { throw new ProposalError(['the answer is not valid JSON']); }
}

function checkSources(sources: string[], evidence: Evidence, where: string, problems: string[]): void {
  for (const source of sources) {
    const [type, ...rest] = source.split(':');
    const value = rest.join(':').trim();
    const known =
      type === 'entry' ? evidence.entryIds.has(value) :
      type === 'commit' ? value.length >= 7 && evidence.commits.some(sha => sha.startsWith(value)) :
      type === 'file' ? evidence.readFiles.has(value) || evidence.changedPaths.has(value) :
      false;
    if (!known) problems.push(`${where}: unknown source "${source}" (use entry:<id>, commit:<sha> or file:<path> from this run)`);
  }
}

/** Validates shape, targets and citations. Throws ProposalError listing every problem found. */
export function validateProposal(raw: unknown, evidence: Evidence, config: Pick<Config, 'docsDirs' | 'readOnlyDocs' | 'maxEdits'>): Proposal {
  if (!Value.Check(ProposalSchema, raw)) {
    const problems = [...Value.Errors(ProposalSchema, raw)].slice(0, 6).map(e => `${(e as { instancePath?: string }).instancePath || '/'}: ${e.message}`);
    throw new ProposalError(problems.length ? problems : ['the JSON does not match the schema']);
  }
  const proposal = raw;
  const creates = proposal.creates ?? [];
  const problems: string[] = [];
  if (proposal.edits.length + creates.length > config.maxEdits) problems.push(`at most ${config.maxEdits} edits and new pages in total`);
  const targets = new Set<string>();
  for (const [i, edit] of proposal.edits.entries()) {
    const where = `edits[${i}] ${edit.path}`;
    if (!isDoc(edit.path, config)) problems.push(`${where}: only README.md files and Markdown under docs directories can be edited`);
    else if (isReadOnlyDoc(edit.path, config)) problems.push(`${where}: this page is read-only (a record such as an ADR); drop the edit and say what is missing in unresolved instead`);
    else if (!evidence.readDocs.has(edit.path)) problems.push(`${where}: read the whole file with clio_read before editing it`);
    else {
      try { expectedEdit(evidence.readDocs.get(edit.path)!, edit.oldText, edit.newText); }
      catch { problems.push(`${where}: oldText must match the file exactly and occur once`); }
    }
    if (targets.has(edit.path)) problems.push(`${where}: one edit per file; combine them into one larger oldText`);
    if (/\[REDACTED/.test(edit.oldText) || /\[REDACTED/.test(edit.newText)) problems.push(`${where}: do not touch redacted lines`);
    if (containsCredential(edit.newText)) problems.push(`${where}: newText looks like it contains a credential`);
    if (edit.oldText === edit.newText) problems.push(`${where}: newText is identical to oldText`);
    targets.add(edit.path);
    checkSources(edit.sources, evidence, where, problems);
  }
  for (const [i, create] of creates.entries()) {
    const where = `creates[${i}] ${create.path}`;
    if (!isDoc(create.path, config) || !NEW_PAGE.test(basename(create.path)) || basename(create.path) === 'README.md') {
      problems.push(`${where}: new pages need a name of ASCII letters, digits, - or _ ending in .md, inside an existing docs directory`);
    } else if (isReadOnlyDoc(create.path, config)) {
      problems.push(`${where}: pages cannot be added to a read-only directory such as ADRs; say what is missing in unresolved instead`);
    }
    if (targets.has(create.path) || evidence.readDocs.has(create.path) || evidence.readFiles.has(create.path)) problems.push(`${where}: that page already exists; edit it instead`);
    if (containsCredential(create.content)) problems.push(`${where}: content looks like it contains a credential`);
    targets.add(create.path);
    checkSources(create.sources, evidence, where, problems);
  }
  if (problems.length) throw new ProposalError(problems);
  return proposal;
}
