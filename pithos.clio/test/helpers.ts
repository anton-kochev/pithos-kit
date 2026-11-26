import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createAssistantMessageEventStream, createFauxCore, type AssistantMessage } from '@earendil-works/pi-ai';
import { Git, type Exec } from '../src/git.ts';
import type { Classifier, Judgement } from '../src/classify.ts';
import type { WorkerContext } from '../src/worker.ts';

export const exec: Exec = (command, args, options) => new Promise(resolve => {
  execFile(command, args, { cwd: options.cwd, signal: options.signal, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } }, (error, stdout, stderr) => {
    const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0;
    resolve({ stdout: String(stdout), stderr: String(stderr), code });
  });
});

export async function makeRepo(files: Record<string, string> = { 'README.md': '# Demo\n\nIntro.\n' }): Promise<{ root: string; git: Git; write: (path: string, text: string) => Promise<void>; commit: (message: string) => Promise<string> }> {
  const root = await mkdtemp(join(tmpdir(), 'clio-test-'));
  const git = new Git(exec, root);
  await git.run(['init', '-q', '-b', 'main']);
  await git.run(['config', 'user.email', 'test@example.com']);
  await git.run(['config', 'user.name', 'Test']);
  await git.run(['config', 'commit.gpgsign', 'false']);
  const write = async (path: string, text: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  };
  const commit = async (message: string) => {
    await git.run(['add', '-A']);
    await git.run(['commit', '-q', '-m', message]);
    return (await git.head())!;
  };
  for (const [path, text] of Object.entries(files)) await write(path, text);
  await commit('initial');
  return { root, git, write, commit };
}

/** A classifier that answers from a lookup on the state, for deterministic tests. */
export function stubClassifier(answer: (state: Record<string, unknown>) => Judgement | undefined): Classifier {
  const usage = { calls: 0, failed: 0, input: 0, output: 0, cost: 0 };
  return {
    model: 'stub/classifier',
    usage,
    async judge(state) {
      usage.calls++;
      const judgement = answer(state);
      if (!judgement) usage.failed++;
      usage.cost += 0.0001;
      return judgement;
    },
  };
}

export const judgement = (kind: string, score: number): Judgement => ({ kind, kindConfidence: 0.6, score, scoreConfidence: 0.6 });

/** A worker context backed by Pi's faux provider; responses are scripted per test. */
export function fauxWorker(responses: (AssistantMessage | ((context: unknown) => AssistantMessage))[], options: { reasoning?: boolean; costPerRequest?: number } = {}) {
  const core = createFauxCore({ provider: 'clio-test', models: [{ id: 'worker', reasoning: options.reasoning ?? false, contextWindow: 128_000, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }], tokensPerSecond: Infinity });
  core.setResponses(responses as never);
  const model = core.getModel();
  const ctx: WorkerContext = {
    model,
    thinkingLevel: 'off',
    modelRegistry: {
      find: () => model,
      getAvailable: () => [model],
      // The faux provider always reports zero cost; optionally stamp a fixed cost on each answer.
      streamSimple: (options.costPerRequest === undefined ? core.streamSimple : (m: never, c: never, o: never) => {
        const inner = core.streamSimple(m, c, o);
        const outer = createAssistantMessageEventStream();
        void (async () => {
          for await (const event of inner) {
            if (event.type === 'done') event.message.usage = { ...event.message.usage, cost: { ...event.message.usage.cost, total: options.costPerRequest! } };
            outer.push(event);
          }
          outer.end();
        })();
        return outer;
      }) as never,
    } as never,
  };
  return { ctx, core };
}
