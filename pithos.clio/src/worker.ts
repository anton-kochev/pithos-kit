import { Agent } from '@earendil-works/pi-agent-core';
import { getSupportedThinkingLevels, type Usage } from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Config } from './config.ts';
import { ProposalSchema, validateProposal, type Proposal, type Snapshot } from './evidence.ts';
import { POLICY } from './policy.ts';
import { evidenceTool } from './exploration.ts';
import { Value } from 'typebox/value';
import { taskContext, type SessionObservation } from './context.ts';
import type { Destination } from './destinations.ts';

type WorkerContext = Pick<ExtensionContext, 'model' | 'thinkingLevel'> & {
  modelRegistry: Pick<ExtensionContext['modelRegistry'], 'find' | 'getAvailable' | 'streamSimple'>;
};
export interface WorkerResult { sessionEvidence?: SessionObservation[]; proposal?: Proposal; usage?: Usage; usageStatus?: 'complete' | 'partial' | 'unknown'; problem?: string; model: string; thinking: string }
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function measured(usage: Usage | undefined): usage is Usage {
  return !!usage && ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'].every(k => finite(usage[k as keyof Usage])) && !!usage.cost && Object.values(usage.cost).length === 5 && ['input', 'output', 'cacheRead', 'cacheWrite', 'total'].every(k => finite(usage.cost[k as keyof Usage['cost']]));
}
export function selectWorker(ctx: WorkerContext, config: Config) {
  const slash = config.model?.indexOf('/') ?? -1;
  const model = config.model ? ctx.modelRegistry.find(config.model.slice(0, slash), config.model.slice(slash + 1)) : ctx.model;
  if (!model || !ctx.modelRegistry.getAvailable().some(m => m.id === model.id && m.provider === model.provider)) throw new Error('Clio: worker model unavailable; no fallback');
  const thinking = config.thinking ?? ctx.thinkingLevel ?? 'off';
  if (!getSupportedThinkingLevels(model).includes(thinking)) throw new Error('Clio: unsupported worker thinking level; no fallback');
  return {model, thinking};
}
export async function runWorker(ctx: WorkerContext, files: Snapshot[], config: Config, signal: AbortSignal | undefined, evidence?: {root?: string; entries?: readonly unknown[]; destinations?: Destination[]}): Promise<WorkerResult> {
  const {model, thinking} = selectWorker(ctx, config);
  const result: WorkerResult = {model: `${model.provider}/${model.id}`, thinking};
  let turns = 0;
  let measuredTurns = 0;
  let timedOut = false;
  let toolProblem: string | undefined;
  const tools = evidence?.root ? [evidenceTool(evidence.root, files, config)] : [];
  const task = taskContext(evidence?.entries ?? [], config);
  const agent = new Agent({
    initialState: {model, thinkingLevel: thinking, tools, systemPrompt: POLICY},
    toolExecution: 'sequential',
    finishTurn: ({message, toolResults}) => {
      if (toolResults.some(r => r.isError)) toolProblem ??= 'Clio: worker incomplete (evidence tool refused or failed)';
      if (turns >= config.maxTurns && message.stopReason === 'toolUse') toolProblem ??= 'Clio: worker turn budget exhausted before final proposal';
      if (toolProblem || message.stopReason !== 'toolUse') return {action: 'end'};
    },
    streamFn: (m, context, options) => ctx.modelRegistry.streamSimple(m, context, {...options, maxTokens: Math.min(model.maxTokens, Math.ceil(config.maxResultBytes / 3))}),
    prepareRequest: ({context}) => {
      if (++turns > config.maxTurns || Buffer.byteLength(JSON.stringify(context)) > config.maxContextBytes) throw new Error('Clio: worker context/turn budget exceeded');
    },
  });
  const abort = () => agent.abort();
  signal?.addEventListener('abort', abort, {once: true});
  const timer = setTimeout(() => { timedOut = true; agent.abort(); }, config.timeoutMs);
  let finalText = '';
  let stop = '';
  const unsubscribe = agent.subscribe(event => {
    if (event.type === 'message_update' && Buffer.byteLength(JSON.stringify(event.message)) > config.maxResultBytes) agent.abort();
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      const m = event.message;
      if (measured(m.usage)) {
        measuredTurns++;
        if (!result.usage) result.usage = structuredClone(m.usage);
        else {
          for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const) result.usage[key] += m.usage[key];
          for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const) result.usage.cost[key] += m.usage.cost[key];
          for (const key of ['reasoning', 'cacheWrite1h'] as const) {
            if (finite(result.usage[key]) && finite(m.usage[key])) result.usage[key]! += m.usage[key]!;
            else delete result.usage[key];
          }
        }
      }
      const calls = m.content.filter(c => c.type === 'toolCall');
      if (calls.length > 8 || calls.some(c => {
        const tool = tools.find(t => t.name === c.name);
        return !tool || !Value.Check(tool.parameters, c.arguments);
      })) {
        toolProblem = 'Clio: worker incomplete (invalid or unavailable tool batch)';
        agent.abort();
      }
      stop = m.stopReason;
      finalText = m.content.filter(c => c.type === 'text').map(c => c.text).join('');
    }
  });
  try {
    if (signal?.aborted) throw new Error('Clio: cancelled');
    await agent.prompt(JSON.stringify({schema: ProposalSchema, task, destinations: evidence?.destinations?.map(({path, missing}) => ({path, missing})), files: files.map(({path, text, doc}) => ({path, text, doc}))}));
    if (signal?.aborted || timedOut) throw new Error(timedOut ? 'Clio: worker timeout' : 'Clio: cancelled');
    if (toolProblem) throw new Error(toolProblem);
    if (stop !== 'stop') throw new Error(`Clio: worker incomplete (${stop || 'unknown'})`);
    result.proposal = validateProposal(finalText, files, config, task.entries, evidence?.destinations);
    const cited = new Set(result.proposal.findings.flatMap(f => f.sources.flatMap(s => 'entryId' in s ? [s.entryId] : [])));
    result.sessionEvidence = task.entries.filter(e => cited.has(e.entryId));
  } catch (error) {
    result.problem = error instanceof Error ? error.message : 'Clio: worker failed';
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    agent.abort();
    await agent.waitForIdle();
    unsubscribe();
  }
  result.usageStatus = !result.usage ? 'unknown' : measuredTurns === turns ? 'complete' : 'partial';
  if (result.usage && result.usageStatus !== 'complete') {
    delete result.usage.reasoning;
    delete result.usage.cacheWrite1h;
  }
  return result;
}
