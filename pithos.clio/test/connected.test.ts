import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ExtensionFactory } from '@earendil-works/pi-coding-agent';
import clio from '../extensions/index.ts';

async function checkScenarios(scenarios: readonly string[]) {
  for (const scenario of scenarios) {
    const sandbox = await mkdtemp(join(tmpdir(), 'clio-connected-'));
    const root = join(sandbox, 'project');
    await mkdir(root);
    const previousHome = process.env.HOME;
    const alias = scenario === 'at-alias' ? '@../README.md' : scenario === 'home-alias' ? '~/README.md' : scenario === 'space-alias' ? 'docs/space\u00a0/README.md' : undefined;
    const outside = scenario === 'home-alias' ? join(sandbox, 'home/README.md') : scenario === 'space-alias' ? join(sandbox, 'space/README.md') : join(sandbox, 'README.md');
    let session: AgentSession | undefined;
    try {
      if (alias) {
        await mkdir(dirname(outside), {recursive: true});
        await writeFile(outside, 'Old description.');
        await mkdir(dirname(join(root, alias)), {recursive: true});
        await writeFile(join(root, alias), 'Old description.');
        if (scenario === 'home-alias') process.env.HOME = join(sandbox, 'home');
        if (scenario === 'space-alias') await symlink(join(sandbox, 'space'), join(root, 'docs/space '));
      }
      await mkdir(join(root, 'src')); await mkdir(join(root, 'agent'));
      await writeFile(join(root, 'src/cache.ts'), 'export const ttl = 30;\n');
      await writeFile(join(root, 'src/rules.ts'), 'export const ttl = 30;\n');
      if (scenario !== 'no-destination') await writeFile(join(root, 'README.md'), '# Cache\nOld description.\n');
      const settings = SettingsManager.inMemory({compaction: {enabled: false}, retry: {enabled: false}, defaultProjectTrust: 'always'});
      const runtime = await ModelRuntime.create({authPath: join(root, 'agent/auth.json'), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false});
      const faux = fauxProvider({provider: 'clio-test', models: [{id: 'test', reasoning: false}], tokensPerSecond: Infinity});
      runtime.registerNativeProvider(faux.provider);
      await runtime.getAvailable();
      let parentCalls = 0, workerCalls = 0, nestedEdits = 0, scheduled = 0;
      let workerAborted = false;
      let enterPlan = () => {};
      const errors: string[] = [];
      const competing: ExtensionFactory = pi => {
        enterPlan = () => pi.appendEntry('plan-theme-state', {active: true});
        pi.on('session_start', () => {
          if (scenario === 'plan' || scenario === 'malformed-plan') pi.appendEntry('plan-theme-state', {active: scenario === 'plan' ? true : 'broken'});
        });
        pi.on('agent_before_settle', event => ({entries: [...event.entries, {type: 'custom', customType: 'other-extension', data: 'preserved'}]}));
        pi.on('tool_call', event => {
          if (event.toolName === 'edit' && event.parentToolCallId) {
            nestedEdits++;
            if (scenario === 'permission-denied') return {block: true, reason: 'Permission guard denied'};
          }
        });
      };
      const observe: ExtensionFactory = pi => {
        pi.on('agent_before_settle', async event => {
          if (event.entries.some(e => e.type === 'custom_message' && e.customType === 'clio-schedule')) {
            scheduled++;
            if (scenario === 'queue') await session!.followUp('New task: read-only, do not edit');
          }
        });
      };
      const loader = new DefaultResourceLoader({cwd: root, agentDir: join(root, 'agent'), settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [competing, clio, observe]});
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      const manager = SessionManager.inMemory(root);
      if (scenario === 'child') manager.newSession({parentSession: '/parent/session.jsonl'});
      session = (await createAgentSession({cwd: root, agentDir: join(root, 'agent'), modelRuntime: runtime, model: faux.getModel(), thinkingLevel: 'off', settingsManager: settings, sessionManager: manager, resourceLoader: loader, tools: scenario === 'readonly-tools' ? ['read', 'clio_capture'] : ['read', 'edit', 'clio_capture']})).session;
      await session.bindExtensions({mode: 'json', onError: e => errors.push(e.error)});
      const respond = async (context: any, options: any) => {
        const serialized = JSON.stringify(context);
        if (serialized.includes('You are Clio, an isolated documentation analyst')) {
          workerCalls++;
          if (['explore', 'explored-stale', 'no-destination'].includes(scenario)) {
            assert.match(serialized, /Investigate cache behavior/, 'worker receives task prose');
            if (workerCalls === 1) return fauxAssistantMessage([fauxToolCall('clio_evidence', {action: 'read', path: 'src/rules.ts'})], {stopReason: 'toolUse'});
            assert.match(serialized, /export const ttl = 30/);
            if (scenario === 'explored-stale') await writeFile(join(root, 'src/rules.ts'), 'changed externally');
            return fauxAssistantMessage(JSON.stringify({findings: [{claim: 'Cache ttl is 30.', kind: 'observed', sources: [{path: 'src/rules.ts', startLine: 1, endLine: 1}]}], edits: scenario === 'no-destination' ? [] : [{path: 'README.md', oldText: 'Old description.', newText: 'Cache ttl is 30.', findings: [0]}], unresolved: []}));
          }
          if (scenario === 'late-plan') enterPlan();
          if (scenario === 'stale-source') await writeFile(join(root, 'src/cache.ts'), 'export const ttl = 60;\n');
          if (scenario === 'noop') return fauxAssistantMessage('{"findings":[],"edits":[],"unresolved":[]}');
          if (scenario === 'cancel' || scenario === 'queue-worker') {
            const wait = new Promise<void>(resolve => options.signal.addEventListener('abort', () => {workerAborted = true; resolve();}, {once: true}));
            setTimeout(() => {if (scenario === 'queue-worker') void session!.followUp('New task: read-only'); else void session!.abort();}, 0);
            await wait;
            return fauxAssistantMessage('', {stopReason: 'aborted'});
          }
          return fauxAssistantMessage(JSON.stringify({findings: [{claim: 'Cache ttl is 30.', kind: 'observed', sources: [{path: 'src/cache.ts', startLine: 1, endLine: 1}]}], edits: [{path: alias ?? 'README.md', oldText: 'Old description.', newText: 'Cache ttl is 30.', findings: [0]}], unresolved: []}));
        }
        parentCalls++;
        if (parentCalls === 1) return fauxAssistantMessage([fauxToolCall('read', {path: 'src/cache.ts'}), fauxToolCall('read', {path: scenario === 'no-destination' ? 'src/cache.ts' : alias ?? 'README.md'})]);
        if (parentCalls === 2 && scenario === 'error') return fauxAssistantMessage('', {stopReason: 'error', errorMessage: 'fixture failure'});
        if (parentCalls === 3 && scenario !== 'decline') {
          const nonce = serialized.match(/nonce(?:\\?\"\s*:\s*\\?\")([a-f0-9-]+)/)?.[1];
          if (nonce) return fauxAssistantMessage([...(scenario === 'mixed' ? [fauxToolCall('read', {path: 'README.md'})] : []), fauxToolCall('clio_capture', {nonce})]);
        }
        return fauxAssistantMessage('Investigation complete.');
      };
      faux.setResponses(Array.from({length: 12}, () => respond));
      await session.prompt(scenario === 'readonly' ? 'Read-only investigation; do not edit' : 'Investigate cache behavior');
      assert.deepEqual(errors, [], scenario);
      const expectedSchedule = !['plan', 'malformed-plan', 'readonly', 'readonly-tools', 'child', 'error'].includes(scenario);
      assert.equal(scheduled, expectedSchedule ? 1 : 0, scenario + ' schedules');
      assert.ok(manager.getBranch().some(e => e.type === 'custom' && e.customType === 'other-extension'), scenario + ' entry preservation');
      const changed = scenario === 'no-destination' ? '' : await readFile(join(root, 'README.md'), 'utf8');
      assert.equal(changed.includes('Cache ttl is 30.'), ['happy', 'explore'].includes(scenario), scenario + ' writes: ' + JSON.stringify(manager.getBranch().filter(e => e.type === 'custom_message' && e.customType === 'clio-result')));
      assert.equal(workerCalls, ['explore', 'explored-stale', 'no-destination'].includes(scenario) ? 2 : ['happy', 'permission-denied', 'cancel', 'queue-worker', 'late-plan', 'noop', 'stale-source', 'at-alias', 'home-alias', 'space-alias'].includes(scenario) ? 1 : 0, scenario + ' worker calls');
      assert.equal(nestedEdits, ['happy', 'permission-denied', 'explore'].includes(scenario) ? 1 : 0, scenario + ' mediated edits');
      if (alias) {
        assert.equal(await readFile(outside, 'utf8'), 'Old description.', scenario + ' outside unchanged');
        assert.equal(await readFile(join(root, alias), 'utf8'), 'Old description.', scenario + ' literal unchanged');
        assert.equal(nestedEdits, 0, 'normalization aliases never reach guarded edit');
      }
      if (scenario === 'no-destination') {
        await assert.rejects(readFile(join(root, 'README.md')), /ENOENT/);
        assert.ok(!manager.getBranch().some(e => e.type === 'custom_message' && e.customType === 'clio-result'), 'no proposed changes is quiet even when root docs is absent');
      }
      if (scenario === 'explored-stale') assert.ok(manager.getBranch().some(e => e.type === 'custom_message' && e.customType === 'clio-result' && /baseline conflict: src\/rules.ts/.test(String(e.content))));
      if (scenario === 'cancel' || scenario === 'queue-worker') assert.equal(workerAborted, true);
      if (scenario === 'noop') assert.ok(!manager.getBranch().some(e => e.type === 'custom_message' && e.customType === 'clio-result'));
      if (scenario === 'decline') assert.ok(manager.getBranch().some(e => e.type === 'custom_message' && e.customType === 'clio-result' && String(e.content).includes('not invoked') && String(e.content).includes('cost unknown')));
      if (scenario === 'happy') {
        assert.ok(manager.getBranch().some(e => e.type === 'custom_message' && e.customType === 'clio-result'));
        const capture = session.messages.find(m => m.role === 'toolResult' && m.toolName === 'clio_capture');
        assert.ok(capture && capture.role === 'toolResult' && capture.usage, 'worker usage reaches parent tool result');
        await session.reload();
        await session.sendCustomMessage({customType: 'fixture-resume', content: 'Continue without a new task.', display: false}, {triggerTurn: true});
        assert.equal(scheduled, 1, 'reload preserves branch-local once-only marker');
        assert.equal(workerCalls, 1, 'reload does not repeat capture');
      }
    } finally {
      session?.dispose();
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
      await rm(sandbox, {recursive: true, force: true});
    }
  }
}

test('connected Pi 1.0.3 settlement, nested guards, stale queue, mixed batches and cancellation', () => checkScenarios(['happy', 'permission-denied', 'plan', 'malformed-plan', 'late-plan', 'readonly', 'readonly-tools', 'child', 'queue', 'queue-worker', 'mixed', 'cancel', 'decline', 'error', 'noop', 'stale-source']));
test('connected exploration keeps task context, rechecks new evidence and keeps empty proposals quiet', () => checkScenarios(['explore', 'explored-stale', 'no-destination']));

test('connected Pi rejects at, home and Unicode-space aliases without outside mutations', () => checkScenarios(['at-alias', 'home-alias', 'space-alias']));
