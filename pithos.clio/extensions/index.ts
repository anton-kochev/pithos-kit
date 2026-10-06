import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { eligibleRun, latestUser, Lease, planInactive, readOnlyTask, type Run } from '../src/admission.ts';
import { parseConfig } from '../src/config.ts';
import { snapshot } from '../src/evidence.ts';
import { runWorker, selectWorker } from '../src/worker.ts';
import { completion, progress } from '../src/ui.ts';
import { applyProposal, type Applied } from '../src/apply.ts';
import { discoverDestinations } from '../src/destinations.ts';
import { publishCreate, type CreateOperation } from '../src/create.ts';
import { CreateAuthorization } from '../src/create-authorization.ts';

async function loadConfig(cwd: string) {
  try {
    for (const path of [join(cwd, '.pi'), join(cwd, '.pi/clio.json')]) if ((await lstat(path)).isSymbolicLink()) throw new Error('Clio config: symlink refused');
    const file = await open(join(cwd, '.pi/clio.json'), 'r');
    try {
      const data = Buffer.alloc(16_385);
      const {bytesRead} = await file.read(data, 0, data.length, 0);
      if (bytesRead > 16_384) throw new Error('Clio config: too large');
      return parseConfig(JSON.parse(data.subarray(0, bytesRead).toString('utf8')));
    } finally { await file.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return parseConfig({});
    throw error;
  }
}
function builtinEdit(pi: ExtensionAPI): boolean {
  return pi.getAllTools().some(t => t.name === 'edit' && t.sourceInfo.source === 'builtin' && ['builtin:edit', '<builtin:edit>'].includes(t.sourceInfo.path) &&
    (pi.getActiveTools().includes('edit') || t.exposure === 'codemode' || t.exposure === 'deferred'));
}
function admission(pi: ExtensionAPI, ctx: ExtensionContext): boolean {
  return ctx.isProjectTrusted() && !ctx.sessionManager.getHeader()?.parentSession && planInactive(ctx.sessionManager.getBranch()) && !readOnlyTask(ctx.sessionManager.getBranch()) && builtinEdit(pi) && !ctx.hasPendingMessages() && !ctx.signal?.aborted;
}
export default function clio(pi: ExtensionAPI) {
  const lease = new Lease();
  const authorization = new CreateAuthorization();
  let createOperation: CreateOperation | undefined;
  const ownCreate = (ctx: ExtensionToolContext) => {
    const tools = pi.getAllTools().filter(t => t.name === 'clio_create_document');
    if (tools.length !== 1 || tools[0].sourceInfo.path !== fileURLToPath(import.meta.url) || tools[0].exposure !== 'deferred' || !ctx.tools.some(t => t.name === 'clio_create_document')) throw new Error('Clio: own create tool unavailable or provenance changed');
  };
  let generation = 0;
  let scheduled: Run | undefined;
  let active: AbortController | undefined;
  let activeDone: Promise<void> | undefined;
  let skipped: string | undefined;
  let scheduledAt = 0;
  const report = (content: string) => pi.sendMessage({customType: 'clio-result', content, display: true});
  const invalidate = () => { if (scheduled) skipped = 'Clio: capture skipped because newer work or session navigation intervened'; generation++; lease.invalidate(); authorization.revoke(); scheduled = undefined; active?.abort(); };
  pi.on('input', invalidate);
  pi.on('session_start', invalidate);
  pi.on('session_tree', invalidate);
  pi.on('session_shutdown', async () => { invalidate(); await activeDone; });
  pi.on('tool_call', event => {
    if (event.toolName === 'clio_create_document') {
      try { authorization.observe(event.parentToolCallId, event.toolCallId, event.input); }
      catch (error) { return {block: true, reason: error instanceof Error ? error.message : 'Clio: create refused'}; }
    }
    if (!event.parentToolCallId && event.toolName !== 'clio_capture' && scheduled) { skipped = 'Clio: capture skipped because other tool work intervened'; lease.invalidate(); scheduled = undefined; }
  });
  pi.on('agent_settled', () => {
    if (scheduled) skipped = 'Clio: scheduled capture was not invoked; no documentation changes';
    if (skipped) report(completion({changed: [], uncertain: [], problems: [skipped], documented: []}, Date.now() - scheduledAt, undefined, [])!);
    skipped = undefined; scheduled = undefined; lease.invalidate();
  });
  pi.on('agent_before_settle', (event, ctx) => {
    if (event.outcome !== 'completed' || event.continue || event.context.pendingMessages.length || !admission(pi, ctx) || !pi.getActiveTools().includes('clio_capture')) return;
    const run = eligibleRun([...ctx.sessionManager.getBranch(), ...event.entries]);
    if (!run) return;
    scheduled = run;
    scheduledAt = Date.now();
    const nonce = lease.schedule(ctx.sessionManager.getSessionId(), run.runId);
    return {continue: true, entries: [...event.entries,
      {type: 'custom' as const, customType: 'clio-attempt', data: {runId: run.runId}},
      {type: 'custom_message' as const, customType: 'clio-schedule', display: false,
        content: `Clio scheduled capture. Call clio_capture alone with ${JSON.stringify({nonce})}. Do not mix tools. If newer work intervened, skip capture.`, details: {runId: run.runId}},
    ]};
  });
  pi.registerTool({
    name: 'clio_create_document', label: 'Clio create', exposure: 'deferred', executionMode: 'sequential',
    description: 'Internal single-use Clio document publication. Requires host authorization from an active clio_capture; never call directly.',
    annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false},
    parameters: Type.Object({path: Type.String(), content: Type.String(), capability: Type.String(), createDirectory: Type.Optional(Type.String())}, {additionalProperties: false}),
    async execute(id, args, signal, _update, ctx) {
      authorization.claim(id, args); // Consume before any wait, including the mutation queue.
      signal?.throwIfAborted();
      ownCreate(ctx);
      const operation = createOperation;
      if (!operation) throw new Error('Clio: missing host create operation');
      await publishCreate(operation, signal);
      // Result hooks may mutate details in place; never expose host accounting.
      return {content: [{type: 'text', text: 'Document published.'}], details: structuredClone(operation.ledger)};
    },
  });
  pi.registerTool({
    name: 'clio_capture', label: 'Clio', exposure: 'model-only', executionMode: 'sequential',
    description: 'Run only when Clio supplies a fresh host-scheduled nonce at settlement, as the sole tool call. Analyze bounded evidence and apply guarded documentation edits or exclusive new pages. Never call unsolicited.',
    parameters: Type.Object({nonce: Type.String({minLength: 36, maxLength: 36})}, {additionalProperties: false}),
    async execute(id, {nonce}, signal, _update, ctx: ExtensionToolContext) {
      if (!admission(pi, ctx) || active || !ctx.tools.some(t => t.name === 'edit')) throw new Error('Clio: capture not authorized');
      const branch = ctx.sessionManager.getBranch();
      const lastAssistant = [...branch].reverse().find(e => e.type === 'message' && e.message.role === 'assistant');
      const calls = lastAssistant?.type === 'message' && lastAssistant.message.role === 'assistant' ? lastAssistant.message.content.filter(c => c.type === 'toolCall') : [];
      if (!calls.some(c => c.id === id)) throw new Error('Clio: invocation not owned by current assistant batch');
      const run = scheduled;
      lease.claim(nonce, ctx.sessionManager.getSessionId(), latestUser(branch), calls.map(c => c.name));
      scheduled = undefined;
      if (!run) throw new Error('Clio: missing scheduled evidence');
      const owner = ctx.sessionManager.getSessionId();
      const epoch = generation;
      const controller = new AbortController();
      active = controller;
      let done!: () => void;
      activeDone = new Promise<void>(resolve => {done = resolve;});
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, {once: true});
      if (signal?.aborted) abort();
      const guard = () => {
        if (controller.signal.aborted || generation !== epoch || ctx.sessionManager.getSessionId() !== owner || latestUser(ctx.sessionManager.getBranch()) !== run.runId || !admission(pi, ctx) || !ctx.tools.some(t => t.name === 'edit')) throw new Error('Clio: cancelled, stale or permissions changed');
      };
      const started = Date.now();
      let display: ReturnType<typeof progress> | undefined;
      let observed: string[] = [];
      let applied: Applied = {changed: [], uncertain: [], problems: [], documented: []};
      let worker: Awaited<ReturnType<typeof runWorker>> | undefined;
      try {
        guard();
        const config = await loadConfig(ctx.cwd);
        const selection = selectWorker(ctx, config);
        display = progress(ctx, `${selection.model.provider}/${selection.model.id}`, selection.thinking);
        const files = await snapshot(ctx.cwd, run.paths, config);
        const destinations = await discoverDestinations(ctx.cwd, run.paths, config);
        observed = files.map(f => f.path);
        guard();
        if (files.length) {
          display.phase('checking evidence / drafting');
          worker = await runWorker(ctx, files, config, controller.signal, {root: ctx.cwd, entries: branch, destinations});
          observed = files.map(f => f.path);
          if (worker.problem) applied.problems.push(worker.problem);
          if (worker.proposal) {
            display.phase('applying');
            applied = await applyProposal(ctx.cwd, worker.proposal, files, config, (name, args) => ctx.executeTool(name, args, {signal: controller.signal}), guard, {
              destinations, guard: () => ownCreate(ctx),
              dispatch: async operation => {
                guard(); ownCreate(ctx);
                authorization.issue(id, operation.args, () => { guard(); ownCreate(ctx); });
                createOperation = operation;
                try { return await ctx.executeTool('clio_create_document', {...operation.args}, {signal: controller.signal}); }
                finally { authorization.revoke(); createOperation = undefined; }
              },
            });
            applied.problems.push(...worker.proposal.unresolved);
          }
        }
        if (!files.some(f => f.doc) && !destinations.length) applied.problems.push('Clio: no eligible documentation destination; capture unmet.');
      } catch (error) { applied.problems.push(error instanceof Error ? error.message : 'Clio: capture failed'); }
      finally {
        authorization.revoke(); createOperation = undefined;
        signal?.removeEventListener('abort', abort);
        display?.stop();
        active = undefined; activeDone = undefined; done();
      }
      const summary = completion(applied, Date.now() - started, worker, observed);
      if (summary) report(summary);
      return {content: [{type: 'text', text: JSON.stringify(applied)}], details: { ...applied, findings: worker?.proposal?.findings ?? [], sessionEvidence: worker?.sessionEvidence ?? [], usageStatus: worker?.usageStatus ?? 'unknown' }, usage: worker?.usage, isError: applied.problems.length > 0};
    },
  });
}
