import { Agent, type AgentEvent, type AgentTool } from '@earendil-works/pi-agent-core';
import { getSupportedThinkingLevels, type AssistantMessage, type Model, type Usage } from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { Config } from './config.ts';
import { isDoc, listProjectDir, readProjectFile } from './paths.ts';
import { POLICY } from './policy.ts';
import { extractJson, ProposalError, validateProposal, type Evidence, type Proposal } from './proposal.ts';

export type WorkerContext = Pick<ExtensionContext, 'model' | 'thinkingLevel'> & {
  modelRegistry: Pick<ExtensionContext['modelRegistry'], 'find' | 'getAvailable' | 'streamSimple'>;
};

export type StopReason = 'cancelled' | 'timeout' | 'cost-limit' | 'turn-limit' | 'context-limit' | 'result-size' | 'provider-error' | 'invalid-proposal';

export interface WorkerUsage { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number; measuredTurns: number }

/** One provider request, for the run record. No message text. */
export interface RequestLog { request: number; ms: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost?: number; stopReason: string; toolCalls: string[] }
/** One clio_read call, for the run record. No file contents. */
export interface ToolLog { request: number; action: string; path: string; outcome: 'ok' | 'refused' | 'error'; chars: number; reason?: string }

export interface WorkerResult {
  model: string;
  thinking: string;
  proposal?: Proposal;
  /** Why the worker stopped without a usable proposal. */
  stop?: StopReason;
  problem?: string;
  usage: WorkerUsage;
  repaired: boolean;
  /** Why the host rejected the first proposal (host validation messages, no file contents). */
  repairReasons?: string[];
  /** Why the repaired proposal was still rejected, when it was. */
  finalRejection?: string[];
  /** Nudges sent to make the worker answer early: deadline, cost or turn limit. */
  nudges: string[];
  requests: RequestLog[];
  tools: ToolLog[];
}

/** At this share of timeoutMs the worker is told to stop reading and answer. */
export const SOFT_DEADLINE = 0.7;
/** At this multiple of maxCostUsd the worker is stopped outright. */
export const HARD_COST = 1.5;

/** Rough tokens for text the model sees. Thinking signatures are opaque and never counted. */
export const estimateTokens = (chars: number) => Math.ceil(chars / 3.5);
const MAX_ANSWER_CHARS = 200_000;
const ReadParameters = Type.Object({ action: Type.Union([Type.Literal('list'), Type.Literal('read')]), path: Type.String({ minLength: 1, maxLength: 300 }) }, { additionalProperties: false });

/** Worker context budget in tokens: configured, or the smaller of 64k and half the model's window. */
export function contextBudget(model: Pick<Model<any>, 'contextWindow'>, config: Pick<Config, 'maxContextTokens'>): number {
  return config.maxContextTokens ?? Math.min(64_000, Math.floor((model.contextWindow || 128_000) / 2));
}

export function selectWorker(ctx: WorkerContext, config: Config): { model: Model<any>; thinking: string } {
  let model = ctx.model;
  if (config.model) {
    const slash = config.model.indexOf('/');
    model = ctx.modelRegistry.find(config.model.slice(0, slash), config.model.slice(slash + 1));
  }
  if (!model || !ctx.modelRegistry.getAvailable().some(m => m.id === model!.id && m.provider === model!.provider)) {
    throw new Error(`worker model ${config.model ?? 'of this session'} is unavailable`);
  }
  const thinking = config.thinking ?? ctx.thinkingLevel ?? 'off';
  const supported = getSupportedThinkingLevels(model) as string[];
  return { model, thinking: supported.includes(thinking) ? thinking : supported.includes('off') ? 'off' : supported[0] };
}

/** Text and tool-call arguments of an assistant message; thinking is left out on purpose. */
function visibleChars(message: AssistantMessage): number {
  let chars = 0;
  for (const part of message.content) {
    if (part.type === 'text') chars += part.text.length;
    else if (part.type === 'toolCall') chars += JSON.stringify(part.arguments ?? {}).length + part.name.length;
  }
  return chars;
}

/**
 * Adds one response's usage. Only a finite cost total counts as measured; extra keys such as
 * Pi's `totalFromProvider` are fine (the old check demanded exactly five and never measured).
 */
export function addUsage(total: WorkerUsage, usage: Usage | undefined): void {
  if (!usage) return;
  total.input += usage.input ?? 0;
  total.output += usage.output ?? 0;
  total.cacheRead += usage.cacheRead ?? 0;
  total.cacheWrite += usage.cacheWrite ?? 0;
  const cost = usage.cost?.total;
  if (typeof cost === 'number' && Number.isFinite(cost) && cost > 0) {
    total.cost += cost;
    total.measuredTurns++;
  }
}

function finalText(message: AssistantMessage | undefined): string {
  return message?.content.filter(p => p.type === 'text').map(p => (p as { text: string }).text).join('') ?? '';
}

export interface WorkerInput {
  root: string;
  task: string;
  /** Shared with the caller; the worker adds every file it reads. */
  evidence: Evidence;
  /** Called before each provider request, for the progress status. */
  onRequest?: (request: number, maxTurns: number) => void;
  /** Clock for the soft deadline; tests pass a fake one. */
  now?: () => number;
}

export async function runWorker(ctx: WorkerContext, config: Config, input: WorkerInput, signal?: AbortSignal): Promise<WorkerResult> {
  const { model, thinking } = selectWorker(ctx, config);
  const budgetTokens = contextBudget(model, config);
  const usage: WorkerUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, measuredTurns: 0 };
  const result: WorkerResult = { model: `${model.provider}/${model.id}`, thinking, usage, repaired: false, nudges: [], requests: [], tools: [] };
  const now = input.now ?? Date.now;
  const started = now();
  const softDeadline = started + config.timeoutMs * SOFT_DEADLINE;
  let requestStarted = started;
  let usedChars = POLICY.length + input.task.length;
  let stop: StopReason | undefined;
  let detail: string | undefined;

  const remaining = () => budgetTokens - estimateTokens(usedChars);
  const refuse = (text: string) => ({ content: [{ type: 'text' as const, text }], details: undefined });
  const nudge = (kind: string, text: string) => {
    if (!result.nudges.includes(kind)) result.nudges.push(kind);
    return refuse(text);
  };
  const logTool = (entry: Omit<ToolLog, 'request'>) => { result.tools.push({ request: usage.turns, ...entry }); };
  /** Why the worker must answer now instead of reading more, if it must. */
  const mustAnswer = (): [string, string] | undefined => {
    if (usage.turns >= config.maxTurns - 1) return ['turn-limit', 'Turn limit reached. Answer now with the JSON proposal, using what you have already read.'];
    if (now() >= softDeadline) return ['deadline', 'Time is nearly up. Do not read anything else: answer now with the JSON proposal, using what you have already read. An empty proposal is fine.'];
    if (usage.cost >= config.maxCostUsd) return ['cost', `This run reached its cost limit ($${config.maxCostUsd}). Do not read anything else: answer now with the JSON proposal, using what you have already read.`];
    return undefined;
  };
  const tool: AgentTool<typeof ReadParameters> = {
    name: 'clio_read',
    label: 'Clio read',
    description: 'Read-only. action "list" shows the immediate entries of a project directory ("." for the root). action "read" returns a whole UTF-8 text file. Paths are relative to the project root. Hidden paths, dependencies and build output are not available.',
    parameters: ReadParameters,
    async execute(_id, { action, path }) {
      const stopReading = mustAnswer();
      if (stopReading) {
        logTool({ action, path, outcome: 'refused', chars: 0, reason: stopReading[0] });
        return nudge(stopReading[0], stopReading[1]);
      }
      let text: string;
      try {
        if (action === 'list') {
          const listing = await listProjectDir(input.root, path);
          text = [`${listing.path}/`, ...listing.entries, ...(listing.truncated ? ['[more entries not shown]'] : [])].join('\n');
        } else {
          const file = await readProjectFile(input.root, path);
          text = file.redacted ? `${file.text}\n[some lines were redacted because they looked like credentials]` : file.text;
          // Reserve a fifth of the budget for the final answer.
          if (estimateTokens(text.length) > remaining() - budgetTokens / 5) {
            logTool({ action, path, outcome: 'refused', chars: text.length, reason: 'context budget' });
            return refuse(`Not read: ${path} is about ${estimateTokens(text.length)} tokens and only about ${Math.max(0, remaining() - Math.floor(budgetTokens / 5))} are left before the answer reserve. Answer with what you have, or read smaller files.`);
          }
          input.evidence.readFiles.add(path);
          if (isDoc(path, config) && !file.redacted) input.evidence.readDocs.set(path, file.text);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'failed';
        logTool({ action, path, outcome: 'error', chars: 0, reason });
        return refuse(`Could not ${action} ${path}: ${reason}`);
      }
      logTool({ action, path, outcome: 'ok', chars: text.length });
      usedChars += text.length;
      return { content: [{ type: 'text' as const, text }], details: undefined };
    },
  };

  const agent = new Agent({
    initialState: { model, thinkingLevel: thinking as never, tools: [tool], systemPrompt: POLICY },
    toolExecution: 'sequential',
    streamFn: (m, context, options) => {
      usage.turns++;
      requestStarted = now();
      input.onRequest?.(usage.turns, config.maxTurns);
      return ctx.modelRegistry.streamSimple(m, context, options);
    },
    prepareRequest: () => {
      if (usage.turns >= config.maxTurns) { stop = 'turn-limit'; throw new Error('turn limit'); }
      if (remaining() < 0) { stop = 'context-limit'; throw new Error('context limit'); }
      if (usage.cost >= config.maxCostUsd * HARD_COST) { stop = 'cost-limit'; throw new Error('cost limit'); }
    },
  });

  const onAbort = () => { stop ??= 'cancelled'; agent.abort(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => { stop ??= 'timeout'; agent.abort(); }, config.timeoutMs);
  let last: AssistantMessage | undefined;
  const unsubscribe = agent.subscribe((event: AgentEvent) => {
    if (event.type === 'message_update' && event.message.role === 'assistant' && visibleChars(event.message as AssistantMessage) > MAX_ANSWER_CHARS) {
      stop ??= 'result-size';
      agent.abort();
    }
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      last = event.message as AssistantMessage;
      usedChars += visibleChars(last);
      const costBefore = usage.cost;
      const measuredBefore = usage.measuredTurns;
      addUsage(usage, last.usage);
      result.requests.push({
        request: usage.turns, ms: now() - requestStarted,
        input: last.usage?.input ?? 0, output: last.usage?.output ?? 0, cacheRead: last.usage?.cacheRead ?? 0, cacheWrite: last.usage?.cacheWrite ?? 0,
        cost: usage.measuredTurns > measuredBefore ? usage.cost - costBefore : undefined,
        stopReason: last.stopReason,
        toolCalls: last.content.filter(part => part.type === 'toolCall').map(part => {
          const call = part as { name: string; arguments?: { action?: unknown; path?: unknown } };
          return `${call.name} ${String(call.arguments?.action ?? '')} ${String(call.arguments?.path ?? '')}`.trim();
        }),
      });
      // Stop outright only when the worker wants to keep going; a final answer that crosses the line is kept.
      if (usage.cost >= config.maxCostUsd * HARD_COST && last.stopReason === 'toolUse') { stop ??= 'cost-limit'; agent.abort(); }
    }
  });

  const finish = (): boolean => {
    if (stop) return false;
    if (!last || last.stopReason !== 'stop') {
      stop = last?.stopReason === 'aborted' ? 'cancelled' : 'provider-error';
      detail = last?.errorMessage;
      return false;
    }
    return true;
  };

  try {
    if (signal?.aborted) throw new Error('cancelled');
    await agent.prompt(input.task);
    if (finish()) {
      try {
        result.proposal = validateProposal(extractJson(finalText(last)), input.evidence, config);
      } catch (error) {
        if (!(error instanceof ProposalError)) throw error;
        // One repair turn: show the worker exactly what the host rejected.
        result.repaired = true;
        result.repairReasons = error.problems.slice(0, 10);
        await agent.prompt(`The host rejected your proposal:\n${error.problems.map(p => `- ${p}`).join('\n')}\nReturn the corrected JSON object only. Drop any change you cannot fix.`);
        if (finish()) {
          try { result.proposal = validateProposal(extractJson(finalText(last)), input.evidence, config); }
          catch (retry) {
            if (!(retry instanceof ProposalError)) throw retry;
            stop = 'invalid-proposal';
            result.finalRejection = retry.problems.slice(0, 10);
            detail = retry.problems.slice(0, 3).join('; ');
          }
        }
      }
    }
  } catch (error) {
    stop ??= 'provider-error';
    detail ??= error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    unsubscribe();
    agent.abort();
    await agent.waitForIdle();
  }
  if (!result.proposal) {
    result.stop = stop ?? 'provider-error';
    const limit = result.stop === 'cost-limit' ? ` at $${config.maxCostUsd * HARD_COST}` : result.stop === 'timeout' ? ` at ${Math.round(config.timeoutMs / 1000)}s` : '';
    result.problem = `worker stopped (${result.stop}${limit}) on ${result.model} after ${usage.turns} requests${detail ? `: ${detail.slice(0, 300)}` : ''}`;
  }
  return result;
}
