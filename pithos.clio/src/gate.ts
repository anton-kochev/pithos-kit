import { EDIT_QUESTIONS, USEFUL_EDIT_KINDS, type Classifier } from './classify.ts';
import type { ClassifierConfig } from './config.ts';
import type { Proposal, ProposedCreate, ProposedEdit } from './proposal.ts';

export type Change = { type: 'edit'; edit: ProposedEdit } | { type: 'create'; create: ProposedCreate };
export type Verdict = 'commit' | 'inbox' | 'drop';

export interface GatedChange {
  change: Change;
  verdict: Verdict;
  reason: string;
  kind?: string;
  score?: number;
}

export const changePath = (change: Change) => change.type === 'edit' ? change.edit.path : change.create.path;
export const changePurpose = (change: Change) => change.type === 'edit' ? change.edit.value : change.create.value;

export function changesOf(proposal: Proposal): Change[] {
  return [
    ...proposal.edits.map(edit => ({ type: 'edit' as const, edit })),
    ...(proposal.creates ?? []).map(create => ({ type: 'create' as const, create })),
  ];
}

const cut = (text: string, max: number) => text.length > max ? `${text.slice(0, max)} [...]` : text;

function stateOf(change: Change): Record<string, string> {
  return change.type === 'edit'
    ? { file: change.edit.path, purpose: change.edit.value, removed_text: cut(change.edit.oldText, 1500), new_text: cut(change.edit.newText, 3000) }
    : { file: change.create.path, purpose: change.create.value, new_page: cut(change.create.content, 4000) };
}

/**
 * Decides what happens to each proposed change:
 * - commit: useful kind and score at or above the threshold;
 * - inbox: no classifier, the classifier failed, or a useful kind below the threshold;
 * - drop: the classifier sees test narration, code restatement, a status report, a bug report or speculation.
 */
export async function gate(changes: Change[], classifier: Classifier | undefined, config: ClassifierConfig | undefined, unavailable: string | undefined, signal?: AbortSignal): Promise<GatedChange[]> {
  const gated: GatedChange[] = [];
  for (const change of changes) {
    if (!classifier || !config) {
      gated.push({ change, verdict: 'inbox', reason: `needs review: ${unavailable ?? 'no classifier'}` });
      continue;
    }
    const judgement = await classifier.judge(stateOf(change), EDIT_QUESTIONS, signal);
    if (!judgement) {
      gated.push({ change, verdict: 'inbox', reason: 'needs review: the classifier did not answer' });
    } else if (!USEFUL_EDIT_KINDS.has(judgement.kind)) {
      gated.push({ change, verdict: 'drop', reason: `dropped: reads as ${judgement.kind}`, kind: judgement.kind, score: judgement.score });
    } else if (judgement.score < config.gateThreshold) {
      gated.push({ change, verdict: 'inbox', reason: `needs review: ${judgement.kind}, score ${judgement.score.toFixed(2)} below ${config.gateThreshold}`, kind: judgement.kind, score: judgement.score });
    } else {
      gated.push({ change, verdict: 'commit', reason: `${judgement.kind}, score ${judgement.score.toFixed(2)}`, kind: judgement.kind, score: judgement.score });
    }
  }
  return gated;
}
