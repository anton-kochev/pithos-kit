import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ExtensionFactory } from '@earendil-works/pi-coding-agent';
import clio from '../extensions/index.ts';
import { Inbox } from '../src/inbox.ts';
import { makeRepo } from './helpers.ts';

const until = async (check: () => Promise<boolean> | boolean, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};

async function start(options: { plan?: boolean; child?: boolean } = {}) {
  const repo = await makeRepo({ 'README.md': '# Guide\n\nIntro.\n', 'src/flow.js': 'export const steps = [];\n' });
  await mkdir(join(repo.root, 'agent'));
  // Keep Pi's own files out of the work tree, as a real project would.
  await repo.write('.gitignore', 'agent/\n');
  await repo.commit('ignore agent dir');
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, defaultProjectTrust: 'always' });
  const runtime = await ModelRuntime.create({ authPath: join(repo.root, 'agent/auth.json'), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const faux = fauxProvider({ provider: 'clio-test', models: [{ id: 'test', reasoning: false }], tokensPerSecond: Infinity });
  runtime.registerNativeProvider(faux.provider);
  await runtime.getAvailable();
  const fixtures: ExtensionFactory = pi => {
    pi.on('session_start', () => { if (options.plan) pi.appendEntry('plan-theme-state', { active: true }); });
  };
  const loader = new DefaultResourceLoader({ cwd: repo.root, agentDir: join(repo.root, 'agent'), settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [fixtures, clio] });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const manager = SessionManager.inMemory(repo.root);
  if (options.child) manager.newSession({ parentSession: '/parent/session.jsonl' });
  const session: AgentSession = (await createAgentSession({ cwd: repo.root, agentDir: join(repo.root, 'agent'), modelRuntime: runtime, model: faux.getModel(), thinkingLevel: 'off', settingsManager: settings, sessionManager: manager, resourceLoader: loader, tools: ['read'] })).session;
  const errors: string[] = [];
  await session.bindExtensions({ mode: 'json', onError: e => errors.push(e.error) });
  const results = () => manager.getBranch().filter(e => e.type === 'custom_message' && e.customType === 'clio-result').map(e => String((e as { content: unknown }).content));
  return { ...repo, faux, session, manager, errors, results };
}

const workerReply = [
  fauxAssistantMessage([fauxToolCall('clio_read', { action: 'read', path: 'README.md' })], { stopReason: 'toolUse' }),
  fauxAssistantMessage(JSON.stringify({ edits: [{ path: 'README.md', oldText: 'Intro.', newText: 'Intro.\n\nWalkthroughs live in src/flow.json.', kind: 'interface', value: 'Where walkthrough data lives.', sources: ['file:src/flow.json'] }], unresolved: [] })),
];

test('after the agent settles with a new commit, Clio documents it in the background without a main-model turn', async () => {
  const t = await start();
  try {
    // First settle only places the cursor.
    t.faux.setResponses([fauxAssistantMessage('Hello.')]);
    await t.session.prompt('Hi');
    await until(async () => (await t.git.readCursor('main')) !== undefined);
    assert.match(t.results().join('\n'), /watching main/);

    // The agent's work lands as a commit; the next settle captures it.
    await t.write('src/flow.json', '{"version":1}\n');
    await t.commit('feat(guide): walkthroughs in json');
    t.faux.setResponses([fauxAssistantMessage('Committed the JSON format.'), ...workerReply]);
    const before = t.faux.state.callCount;
    await t.session.prompt('Store walkthroughs as JSON. Yes, do it.');
    await until(() => t.results().some(r => r.includes('to review')));
    // One main-model call for the turn plus two worker calls; no scheduling turn in between.
    assert.equal(t.faux.state.callCount - before, 3);
    assert.ok(!t.session.messages.some(m => m.role === 'toolResult' && m.toolName === 'clio_capture'));
    // No classifier in this runtime, so the change waits for review instead of being committed.
    const items = await new Inbox(await t.git.clioDir()).list();
    assert.equal(items.length, 1);
    assert.equal(items[0].change.type === 'edit' && items[0].change.edit.path, 'README.md');
    assert.deepEqual(t.errors, []);
  } finally {
    t.session.dispose();
    await rm(t.root, { recursive: true, force: true });
  }
});

test('Plan mode and child sessions never trigger a run', async () => {
  for (const options of [{ plan: true }, { child: true }]) {
    const t = await start(options);
    try {
      t.faux.setResponses([fauxAssistantMessage('Hello.')]);
      await t.session.prompt('Hi');
      await new Promise(resolve => setTimeout(resolve, 200));
      assert.equal(await t.git.readCursor('main'), undefined, JSON.stringify(options));
      assert.deepEqual(t.results(), []);
    } finally {
      t.session.dispose();
      await rm(t.root, { recursive: true, force: true });
    }
  }
});

test('/clio --help and /clio status answer without calling a model', async () => {
  const t = await start();
  try {
    await t.session.prompt('/clio --help');
    await t.session.prompt('/clio status');
    await t.session.prompt('/clio status --probe');
    const text = t.results().join('\n');
    assert.match(text, /Usage: \/clio/);
    assert.match(text, /status --probe/);
    assert.match(text, /Clio status · branch main/);
    assert.match(text, /Classifier: unavailable \(no classifier configured\); nothing is auto-committed, every change goes to the inbox/);
    assert.match(text, /Config: autoCommit on · limits 5m 0s and \$0\.5 per run/);
    assert.match(text, /Worker: this session's model \(clio-test\/test, thinking off\)\. Set "model" and "thinking": "low"/);
    assert.equal(t.faux.state.callCount, 0);
  } finally {
    t.session.dispose();
    await rm(t.root, { recursive: true, force: true });
  }
});

test('progress line and elapsed time format', async () => {
  const { formatElapsed, progressLine } = await import('../extensions/index.ts');
  assert.equal(formatElapsed(41_900), '41s');
  assert.equal(formatElapsed(70_000), '1m 10s');
  assert.equal(progressLine({ range: 'a90c9cb..bdaca7a', step: 'drafting, request 3 of 16', startedAt: 0 }, 41_000), 'Clio · a90c9cb..bdaca7a · drafting, request 3 of 16 · 41s');
});
