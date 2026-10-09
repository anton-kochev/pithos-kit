import { isAbsolute, relative } from 'node:path';
import { Agent, type AgentContext, type AgentToolCall } from '@earendil-works/pi-agent-core';
import { getSupportedThinkingLevels, type Usage } from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Config } from './config.ts';
import { ProposalSchema, validateProposal, snapshotPool, candidatePriority, type Proposal, type Snapshot } from './evidence.ts';
import { POLICY } from './policy.ts';
import { evidenceTool } from './exploration.ts';
import { Value } from 'typebox/value';
import { taskContext, type SessionObservation } from './context.ts';
import type { Destination } from './destinations.ts';
import { evidenceFailureReason, workerDiagnostic } from './diagnostics.ts';
import { BudgetError, evidenceBudget, requestBytes, assertRequestBudget, continuationHeadroom, reservedFeedback, toolResultEnvelope } from './budget.ts';

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
export async function runWorker(ctx: WorkerContext, files: Snapshot[], config: Config, signal: AbortSignal | undefined, evidence?: {root?: string; entries?: readonly unknown[]; destinations?: Destination[]; observedPaths?: readonly string[]}): Promise<WorkerResult> {
  const {model, thinking} = selectWorker(ctx, config);
  const result: WorkerResult = {model: `${model.provider}/${model.id}`, thinking};
  let turns = 0;
  let measuredTurns = 0;
  let timedOut = false;
  let toolProblem: string | undefined;
  let evidenceFailure: string | undefined;
  let budgetProblem: string | undefined;
  const guard = (context: unknown) => {
    try { assertRequestBudget(context, config); }
    catch (error) {
      if (error instanceof BudgetError) budgetProblem = error.message.replace('Clio: ', `Clio: ${turns === 0 ? 'initial' : 'continuation'} request: `);
      throw error;
    }
  };
  let batchContext: AgentContext | undefined;
  let batchCalls: AgentToolCall[] = [];
  const batchResults = new Map<string, ReturnType<typeof toolResultEnvelope>>();
  const admitResult = (id: string, text: string) => {
    if (!batchContext) throw new Error('Clio: missing exploration request context');
    const projected = batchCalls.map(call => batchResults.get(call.id) ??
      toolResultEnvelope(call.id, call.id === id ? text : reservedFeedback(config), call.name));
    const bytes = requestBytes({...batchContext, messages: [...batchContext.messages, ...projected]}) + continuationHeadroom;
    if (bytes > config.maxContextBytes) throw new BudgetError('request-context-bytes', 0, bytes, config.maxContextBytes);
    batchResults.set(id, toolResultEnvelope(id, text));
  };
  const pool = snapshotPool(files);
  const candidates = [...files];
  const candidateCount = candidates.length;
  const observed = new Set((evidence?.observedPaths ?? (pool?.provenance ?? candidates).map(f => f.path))
    .map(path => evidence?.root && isAbsolute(path) ? relative(evidence.root, path) : path));
  // Only original eligible observations grant directory scopes. Discovered
  // candidates never become authorization provenance merely by being found.
  const provenance = (pool?.provenance ?? candidates).filter(f => observed.has(f.path)).map(({path, doc}) => ({path, doc}));
  const tools = evidence?.root ? [evidenceTool(evidence.root, files, config, provenance, admitResult)] : [];
  for (const tool of tools) {
    const execute = tool.execute;
    tool.execute = async (id, args, signal, onUpdate) => {
      try { return await execute(id, args, signal, onUpdate); }
      catch (error) {
        if (error instanceof BudgetError && error.limit === 'request-context-bytes') budgetProblem ??= error.message.replace('Clio: ', 'Clio: continuation request: ');
        evidenceFailure ??= workerDiagnostic('Clio: worker incomplete (evidence tool refused or failed)', result.model, turns, evidenceFailureReason(error), args);
        throw error;
      }
    };
  }
  const task = taskContext(evidence?.entries ?? [], config);
  const priority = candidatePriority(observed, config);
  candidates.sort((a, b) => priority(a.path) - priority(b.path));
  const reserveBytes = tools.length ? continuationHeadroom + requestBytes(Array.from({length: 8}, (_, i) => toolResultEnvelope(`reserved-${i}`, reservedFeedback(config)))) : 0;
  const initialPrompt = (admitted: Snapshot[]) => JSON.stringify({schema: ProposalSchema, task,
    budget: evidenceBudget(admitted, config), omissions: {files: candidateCount + (pool?.omitted ?? 0) - admitted.length, poolFiles: pool?.omitted ?? 0}, continuationReserveBytes: reserveBytes,
    destinations: evidence?.destinations?.map(({path, missing}) => ({path, missing})),
    files: admitted.map(({path, text, doc}) => ({path, text, doc}))});
  const agent = new Agent({
    initialState: {model, thinkingLevel: thinking, tools, systemPrompt: POLICY},
    toolExecution: 'sequential',
    beforeToolCall: async ({context, assistantMessage}) => {
      batchContext = context;
      batchCalls = assistantMessage.content.filter((c): c is AgentToolCall => c.type === 'toolCall');
      return undefined;
    },
    finishTurn: ({message, toolResults}) => {
      if (toolResults.some(r => r.isError)) toolProblem ??= evidenceFailure ?? workerDiagnostic('Clio: worker incomplete (evidence tool refused or failed)', result.model, turns);
      if (turns >= config.maxTurns && message.stopReason === 'toolUse') toolProblem ??= new BudgetError('request-turns', turns, 1, config.maxTurns).message;
      if (toolProblem || message.stopReason !== 'toolUse') return {action: 'end'};
    },
    streamFn: (m, context, options) => ctx.modelRegistry.streamSimple(m, context, {...options, maxTokens: Math.min(model.maxTokens, Math.ceil(config.maxResultBytes / 3))}),
    prepareRequest: ({context}) => {
      if (turns >= config.maxTurns) throw new BudgetError('request-turns', turns, 1, config.maxTurns);
      if (turns === 0) {
        const user = context.messages.find(m => m.role === 'user');
        if (!user || user.role !== 'user') throw new Error('Clio: missing initial request');
        const admitted: Snapshot[] = [];
        const setPrompt = () => { user.content = [{type: 'text', text: initialPrompt(admitted)}]; };
        files.splice(0, files.length);
        setPrompt();
        guard(context);
        const admissionMax = Math.max(requestBytes(context), config.maxContextBytes - reserveBytes);
        for (const candidate of candidates) {
          if (admitted.length >= config.maxFiles) continue;
          admitted.push(candidate); setPrompt();
          if (evidenceBudget(admitted, config).evidenceBytes > config.maxContextBytes || requestBytes(context) > admissionMax) {
            admitted.pop(); setPrompt();
          }
        }
        files.splice(0, files.length, ...admitted);
        candidates.length = 0; // Drop rejected pool bodies before provider execution.
      }
      guard(context);
      turns++;
    },
  });
  const abort = () => agent.abort();
  signal?.addEventListener('abort', abort, {once: true});
  const timer = setTimeout(() => { timedOut = true; agent.abort(); }, config.timeoutMs);
  let finalText = '';
  let stop = '';
  let failureReason: string | undefined;
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
      batchResults.clear();
      const calls = m.content.filter(c => c.type === 'toolCall');
      if (calls.length > 8 || new Set(calls.map(c => c.id)).size !== calls.length || calls.some(c => {
        const tool = tools.find(t => t.name === c.name);
        return !tool || !Value.Check(tool.parameters, c.arguments);
      })) {
        toolProblem = 'Clio: worker incomplete (invalid or unavailable tool batch)';
        agent.abort();
      }
      stop = m.stopReason;
      failureReason = m.errorMessage;
      finalText = m.content.filter(c => c.type === 'text').map(c => c.text).join('');
    }
  });
  try {
    if (signal?.aborted) throw new Error('Clio: cancelled');
    await agent.prompt(initialPrompt([]));
    if (signal?.aborted || timedOut) throw new Error(timedOut ? 'Clio: worker timeout' : 'Clio: cancelled');
    if (budgetProblem) throw new Error(budgetProblem);
    if (toolProblem) throw new Error(toolProblem);
    if (stop !== 'stop') throw new Error(workerDiagnostic(`Clio: worker incomplete (${stop || 'unknown'})`, result.model, turns, failureReason));
    result.proposal = validateProposal(finalText, files, config, task.entries, evidence?.destinations);
    const cited = new Set(result.proposal.findings.flatMap(f => f.sources.flatMap(s => 'entryId' in s ? [s.entryId] : [])));
    result.sessionEvidence = task.entries.filter(e => cited.has(e.entryId));
  } catch (error) {
    result.problem = budgetProblem ?? (error instanceof Error ? error.message : 'Clio: worker failed');
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
