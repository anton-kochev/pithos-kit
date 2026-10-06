import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ExtensionFactory } from '@earendil-works/pi-coding-agent';

async function scenario(kind: string) {
  const root = await mkdtemp(join(tmpdir(), 'clio-create-connected-'));
  let session: AgentSession | undefined;
  try {
    await mkdir(join(root, 'agent'));
    await writeFile(join(root, 'cache.ts'), 'export const ttl = 30;\n');
    if (['empty', 'delayed-dir'].includes(kind)) await mkdir(join(root, 'docs'));
    if (kind === 'existing') { await mkdir(join(root, 'docs')); await writeFile(join(root, 'docs/old.md'), 'Existing page'); }
    const settings = SettingsManager.inMemory({compaction: {enabled: false}, retry: {enabled: false}, defaultProjectTrust: 'always'});
    const runtime = await ModelRuntime.create({authPath: join(root, 'agent/auth.json'), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false});
    const faux = fauxProvider({provider: 'clio-create-test', models: [{id: 'test', reasoning: false}], tokensPerSecond: Infinity});
    runtime.registerNativeProvider(faux.provider);
    await runtime.getAvailable();
    let calls = 0, creates = 0;
    const success = ['missing', 'empty', 'existing', 'hook-before', 'hook-after', 'builtin-before', 'builtin-after', 'mutated-details'].includes(kind);
    const clioPath = fileURLToPath(new URL('../extensions/index.ts', import.meta.url));
    const paths = [clioPath];
    // Supplemental characterization: independent guards use ordinary Pi hooks,
    // not command provenance, a compatibility responder or a shared rule system.
    if (kind.startsWith('hook')) {
      const guard = join(root, 'custom-tool-guard.ts');
      await writeFile(guard, `export default function(pi) {
        pi.on('tool_call', async (event, ctx) => {
          if (event.toolName !== 'clio_create_document') return;
          const target = ${JSON.stringify(join(root, kind.includes('directory') ? 'docs' : 'docs/cache.md'))};
          if (event.input.path !== target && !event.input.path.startsWith(target + '/')) return;
          if (${kind.includes('denied')}) return {block: true, reason: 'Custom mutation denied'};
          if (${kind.includes('no-ui')} && (!ctx.hasUI || !await ctx.ui.confirm('Create page?', event.input.path))) {
            return {block: true, reason: 'Custom mutation requires confirmation'};
          }
        });
      }`);
      if (kind.endsWith('before')) paths.unshift(guard); else paths.push(guard);
    }
    if (kind.startsWith('builtin')) {
      const guard = join(root, 'builtin-guard.ts');
      await writeFile(guard, `export default function(pi) {
        pi.registerCommand('aegis', {description:'Independent built-in-only guard', handler: async () => {}});
        pi.on('tool_call', event => {
          if (['edit', 'write'].includes(event.toolName)) return {block: true, reason: 'Built-in mutation denied'};
        });
      }`);
      if (kind.endsWith('before')) paths.unshift(guard); else paths.push(guard);
    }
    if (kind === 'plan') paths.push(fileURLToPath(new URL('../../pithos.plan/extensions/plan-theme.ts', import.meta.url)));
    const observer: ExtensionFactory = pi => {
      pi.on('tool_call', async event => {
        if (event.toolName === 'clio_create_document') {
          creates++;
          assert.ok(event.parentToolCallId);
          assert.equal(event.input.path, join(root, creates === 1 ? 'docs/cache.md' : 'docs/second.md'));
          await new Promise(resolve => setTimeout(resolve, 1)); // A permission wait, not a worker wait.
          if (kind === 'delayed-source') await writeFile(join(root, 'cache.ts'), 'export const ttl = 60;');
          if (kind === 'delayed-dir') { await rename(join(root, 'docs'), join(root, 'old-docs')); await mkdir(join(root, 'docs')); }
          if (kind === 'delayed-target') { await mkdir(join(root, 'docs')); await writeFile(join(root, 'docs/cache.md'), 'external winner'); }
          if (kind === 'lost-edit') pi.setActiveTools(pi.getActiveTools().filter(name => name !== 'edit'));
          if (kind === 'delayed-plan') pi.appendEntry('plan-theme-state', {active: true});
          if (kind === 'denied') return {block: true, reason: 'Permission denied'};
          if (kind === 'mutated') event.input.content = 'Mutated after authorization';
          if (kind === 'new-input') await session!.followUp('New read-only task');
        }
      });
      pi.on('tool_result', event => {
        if (event.toolName !== 'clio_create_document') return;
        if (kind.startsWith('mutated-details')) {
          const details = event.details as {state: string; createdDirectories: string[]; leftoverTemps: string[]};
          details.state = 'uncertain';
          details.createdDirectories.splice(0, details.createdDirectories.length, '/forged-directory');
          details.leftoverTemps.push('/forged-temp');
        }
        if (kind === 'post-result-error' || kind === 'mutated-details-error') return {isError: true};
      });
    };
    const loader = new DefaultResourceLoader({cwd: root, agentDir: join(root, 'agent'), settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: paths, extensionFactories: [observer]});
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const manager = SessionManager.inMemory(root);
    session = (await createAgentSession({cwd: root, agentDir: join(root, 'agent'), modelRuntime: runtime, model: faux.getModel(), thinkingLevel: 'off', settingsManager: settings, sessionManager: manager, resourceLoader: loader, ...(kind === 'unavailable-create' ? {excludeTools: ['clio_create_document']} : {})})).session;
    await session.bindExtensions({mode: 'json'});
    faux.setResponses(Array.from({length: 12}, () => async (context: any) => {
      const serialized = JSON.stringify(context);
      if (serialized.includes('You are Clio, an isolated documentation analyst')) {
        assert.match(serialized, /destinations/);
        return fauxAssistantMessage(JSON.stringify({findings: [{claim: 'TTL is 30.', kind: 'observed', sources: [{path: 'cache.ts', startLine: 1, endLine: 1}]}], edits: [], creates: ['cache', 'second'].map(name => ({path: `docs/${name}.md`, content: '# Cache\nTTL is 30.\n', findings: [0]})), unresolved: []}));
      }
      calls++;
      if (calls === 1) return fauxAssistantMessage([fauxToolCall('read', {path: 'cache.ts'}), fauxToolCall('read', {path: 'cache.ts'})]);
      if (calls === 3) {
        const nonce = serialized.match(/nonce(?:\\?\"\s*:\s*\\?\")([a-f0-9-]+)/)?.[1];
        if (nonce) return fauxAssistantMessage([fauxToolCall('clio_capture', {nonce})]);
      }
      return fauxAssistantMessage('Complete.');
    }));
    if (kind === 'plan') await session.prompt('/plan');
    await session.prompt('Investigate the cache');
    if (kind === 'plan') {
      assert.ok(manager.getBranch().some(e => e.type === 'custom' && e.customType === 'plan-theme-state' && (e.data as any).active === true), 'actual Plan entered');
      assert.equal(creates, 0);
      assert.ok(!session.messages.some(m => m.role === 'toolResult' && m.toolName === 'clio_capture'));
      await assert.rejects(readFile(join(root, 'docs/cache.md')), /ENOENT/);
      return;
    }
    const capture = session.messages.find(m => m.role === 'toolResult' && m.toolName === 'clio_capture');
    assert.ok(capture && capture.role === 'toolResult', 'scheduled capture');
    assert.equal(capture.isError, !success, kind + ': ' + JSON.stringify(capture));
    if (kind.startsWith('mutated-details')) {
      const details = capture.details as any;
      assert.deepEqual(details.changed, kind === 'mutated-details' ? ['docs/cache.md', 'docs/second.md'] : ['docs/cache.md']);
      assert.deepEqual(details.uncertain, []);
      assert.deepEqual(details.createdDirectories, [join(root, 'docs')]);
      assert.deepEqual(details.leftoverTemps ?? [], []);
      assert.deepEqual(details.documented, success ? [0] : []);
    }
    if (!success) {
      const details = capture.details as any;
      if (kind.startsWith('hook')) assert.match(details.problems.join('\n'), /guarded create denied or failed/, 'custom-tool-aware guard must deny through the real permission hook');
      assert.deepEqual(details.documented, []);
      if (kind === 'post-result-error' || kind === 'mutated-details-error') {
        assert.deepEqual(details.changed, ['docs/cache.md']);
        assert.equal(await readFile(join(root, 'docs/cache.md'), 'utf8'), '# Cache\nTTL is 30.\n');
      } else {
        assert.deepEqual(details.changed, []);
        if (kind === 'delayed-target') assert.equal(await readFile(join(root, 'docs/cache.md'), 'utf8'), 'external winner');
        else await assert.rejects(readFile(join(root, 'docs/cache.md')), /ENOENT/);
      }
      await assert.rejects(readFile(join(root, 'docs/second.md')), /ENOENT/);
      return;
    }
    assert.equal(creates, 2);
    assert.equal(await readFile(join(root, 'docs/cache.md'), 'utf8'), '# Cache\nTTL is 30.\n');
    assert.equal(await readFile(join(root, 'docs/second.md'), 'utf8'), '# Cache\nTTL is 30.\n');
    assert.ok(!(await readdir(join(root, 'docs'))).some(p => p.startsWith('.clio-')));
  } finally { session?.dispose(); await rm(root, {recursive: true, force: true}); }
}
test('connected new pages through parent tools in missing empty and existing docs', async () => {
  for (const kind of ['missing', 'empty', 'existing']) await scenario(kind);
});

test('connected permission waits recheck evidence directories targets Plan and input; denials mutations and partial results are honest', async () => {
  for (const kind of ['delayed-source', 'delayed-dir', 'delayed-target', 'delayed-plan', 'denied', 'mutated', 'new-input', 'lost-edit', 'unavailable-create', 'post-result-error']) await scenario(kind);
});
test('connected result details mutations cannot change host creation accounting', async () => {
  for (const kind of ['mutated-details', 'mutated-details-error']) await scenario(kind);
});
test('connected actual Plan on Pi 1.0.3 prevents automatic creation', () => scenario('plan'));
test('connected built-in-only guard permits standalone creation without responder in both load orders', async t => {
  for (const kind of ['builtin-before', 'builtin-after']) await t.test(kind, () => scenario(kind));
});
test('connected independent custom-tool hooks permit or block creation and deny confirmation without UI in both load orders', async t => {
  for (const kind of ['hook-before', 'hook-after', 'hook-denied-before', 'hook-denied-after', 'hook-directory-denied-before', 'hook-directory-denied-after', 'hook-no-ui-before', 'hook-no-ui-after']) await t.test(kind, () => scenario(kind));
});
