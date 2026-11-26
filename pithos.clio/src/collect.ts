import { USEFUL_WINDOW_KINDS, WINDOW_QUESTIONS, type Classifier } from './classify.ts';
import type { ClassifierConfig } from './config.ts';
import { cleanProse } from './redact.ts';

/**
 * One user turn: the latest failed tool call of the run (short), the assistant's last prose
 * before the user answered, and the user's reply. A reply like "yes, do it" only means
 * something next to the proposal it approves, so the two always travel together.
 */
export interface SessionWindow {
  index: number;
  /** Session entry ids the worker may cite. */
  entryIds: string[];
  time: number;
  failure?: string;
  assistant?: string;
  user?: string;
}

export interface CollectedWindow extends SessionWindow {
  kind?: string;
  score?: number;
  /** The window just before, for context. Not separately citable unless also kept. */
  previous?: SessionWindow;
}

export interface Collection {
  windows: CollectedWindow[];
  considered: number;
  /** false when recent windows were used unjudged: no classifier, or it was failing. */
  classified: boolean;
  /** Set when most classifier calls failed; the run then treats the classifier as unavailable. */
  classifierFailure?: { failed: number; total: number; error: string };
}

const cut = (text: string, max: number) => text.length > max ? `${text.slice(0, max)} [...]` : text;

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text as string).join('\n');
}

function timeOf(entry: Record<string, unknown>): number {
  const value = Date.parse(String(entry.timestamp ?? ''));
  return Number.isFinite(value) ? value : 0;
}

export function buildWindows(entries: readonly unknown[], sinceMs = 0): SessionWindow[] {
  const windows: SessionWindow[] = [];
  let prose: { id: string; text: string } | undefined;
  let failure: { id: string; text: string } | undefined;
  // Prose answering an old Clio scheduling message is Clio noise, not project knowledge.
  let skipProse = false;
  const push = (time: number, user?: { id: string; text: string }) => {
    const ids = [failure?.id, prose?.id, user?.id].filter((id): id is string => !!id);
    if (time >= sinceMs && (prose || user)) {
      windows.push({ index: windows.length, entryIds: ids, time, failure: failure?.text, assistant: prose && cut(prose.text, 3000), user: user && cut(user.text, 4000) });
    }
    prose = undefined;
    failure = undefined;
  };
  for (const raw of entries) {
    const entry = raw as Record<string, any>;
    if (entry?.type === 'custom_message' && entry.customType === 'clio-schedule') { skipProse = true; continue; }
    const message = entry?.message;
    if (entry?.type !== 'message' || !message || typeof entry.id !== 'string') continue;
    if (message.role === 'user') {
      const text = cleanProse(textOf(message.content));
      if (text) push(timeOf(entry), { id: entry.id, text });
    } else if (message.role === 'toolResult') {
      if (message.toolName === 'clio_capture') { skipProse = true; continue; }
      if (message.isError) failure = { id: entry.id, text: `${String(message.toolName ?? 'tool')}: ${cut(cleanProse(textOf(message.content)), 500)}` };
    } else if (message.role === 'assistant') {
      const text = cleanProse(textOf(message.content));
      if (!text) continue;
      if (skipProse) { skipProse = false; continue; }
      prose = { id: entry.id, text };
    }
  }
  if (prose) push(Date.now());
  return windows;
}

function stateOf(window: SessionWindow): Record<string, string> {
  const state: Record<string, string> = {};
  if (window.failure) state.failure_before = window.failure;
  if (window.assistant) state.assistant_before = window.assistant;
  if (window.user) state.user = window.user;
  return state;
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }));
  return results;
}

/**
 * Picks the session windows worth the worker's attention. With a classifier, a window must
 * have a useful kind and a usefulness score at or above the threshold. Without one, the most
 * recent windows are used unjudged.
 *
 * A failing classifier must never look like "nothing worth documenting": when more than half
 * of the calls fail, the result falls back to recent windows and reports the failure.
 */
export async function collect(windows: SessionWindow[], classifier: Classifier | undefined, config: ClassifierConfig | undefined, signal?: AbortSignal): Promise<Collection> {
  const max = config?.maxWindows ?? 8;
  const withPrevious = (window: SessionWindow): CollectedWindow => ({ ...window, previous: windows[window.index - 1] });
  if (!classifier || !config) {
    return { windows: windows.slice(-max).map(withPrevious), considered: windows.length, classified: false };
  }
  const judged = await pool(windows, 4, async window => ({ window, judgement: await classifier.judge(stateOf(window), WINDOW_QUESTIONS, signal) }));
  const failed = judged.filter(j => !j.judgement).length;
  if (failed > 0 && failed * 2 > judged.length) {
    return {
      windows: windows.slice(-max).map(withPrevious), considered: windows.length, classified: false,
      classifierFailure: { failed, total: judged.length, error: classifier.usage.lastError ?? 'unknown error' },
    };
  }
  const kept = judged
    .filter(({ judgement }) => judgement && USEFUL_WINDOW_KINDS.has(judgement.kind) && judgement.score >= config.collectThreshold)
    .sort((a, b) => b.judgement!.score - a.judgement!.score)
    .slice(0, max)
    .sort((a, b) => a.window.index - b.window.index)
    .map(({ window, judgement }) => ({ ...withPrevious(window), kind: judgement!.kind, score: judgement!.score }));
  return { windows: kept, considered: windows.length, classified: true };
}
