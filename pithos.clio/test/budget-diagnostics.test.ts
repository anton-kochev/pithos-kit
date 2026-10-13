import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config.ts';
import { snapshot } from '../src/evidence.ts';
import { discoverDestinations } from '../src/destinations.ts';
import { runWorker } from '../src/worker.ts';
import { completion } from '../src/ui.ts';
import { model, answer, stream } from './worker.test.ts';

// Diagnostic pins: checked candidates vs unread discovery, pool omissions,
// admitted feedback vs absence, and actual provider invocations on failure.
test('budget totals distinguish checked candidates, directory discovery, capacity and absence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clio-counts-'));
  try {
    await mkdir(join(root, 'src'));
    await mkdir(join(root, 'handbook/guides'), {recursive: true});
    const config = parseConfig({maxFiles: 1, docsDirs: ['handbook']});
    await writeFile(join(root, 'src/a.ts'), 'export const a = 1;');
    await writeFile(join(root, 'src/b.ts'), 'export const b = 2;');
    await writeFile(join(root, 'src/secret.ts'), 'excluded body');
    await writeFile(join(root, 'src/oversized.ts'), 'x'.repeat(config.maxContextBytes + 1));
    await writeFile(join(root, 'handbook/guides/unread.md'), 'Unread documentation body');
    const observedPaths = ['src/a.ts', 'src/b.ts', 'src/secret.ts', 'src/oversized.ts'];
    const files = await snapshot(root, observedPaths, config);
    const destinations = await discoverDestinations(root, observedPaths, config);
    let calls = 0;
    const result = await runWorker({model, thinkingLevel: 'off', modelRegistry: {
      find: () => model, getAvailable: () => [model], streamSimple: (_m, context) => {
        const serialized = JSON.stringify(context);
        assert.doesNotMatch(serialized, /secret\.ts|oversized\.ts|excluded body|unread\.md|Unread documentation body/);
        calls++;
        if (calls === 1) return stream(answer([{type: 'toolCall', id: 'capacity', name: 'clio_evidence', arguments: {action: 'read', path: 'src/b.ts'}}], 'toolUse'));
        const feedback = context.messages.filter(m => m.role === 'toolResult').at(-1)!;
        assert.equal(feedback.role, 'toolResult');
        const body = JSON.parse((feedback.content[0] as any).text);
        if (calls === 2) {
          assert.equal(body.status, 'capacity');
          assert.equal(body.refusal.limit, 'file-count');
          return stream(answer([{type: 'toolCall', id: 'missing', name: 'clio_evidence', arguments: {action: 'list', path: 'docs'}}], 'toolUse'));
        }
        assert.deepEqual(body, {status: 'not-found', action: 'list', path: 'docs'});
        return stream(answer([{type: 'text', text: '{"findings":[],"edits":[],"unresolved":[]}'}]));
      },
    }}, files, config, undefined, {root, observedPaths, destinations});
    assert.equal(result.problem, undefined);
    assert.equal(calls, 3);
    assert.deepEqual(result.budget, {
      initialRequestBytes: result.budget!.initialRequestBytes,
      initialGuardedRequestBytes: result.budget!.initialGuardedRequestBytes,
      candidateFiles: 2, admittedFiles: 1, omittedFiles: 1, poolOmittedFiles: 1,
      discoveredDirectories: 2, missingDestinationDirectories: 1,
      providerRequests: calls, capacityRefusals: {'file-count': 1},
    });
    assert.deepEqual(files.map(f => f.path), ['src/a.ts']);
    assert.doesNotMatch(JSON.stringify(result.budget), /src\/|handbook\/|docs|export/);
    const summary = completion({changed: ['docs/example.md'], uncertain: [], documented: [], problems: []}, 0, result, [])!;
    assert.match(summary, /1\/2 candidates admitted · 1 omitted · 3 requests · 1 capacity refusals/);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('provider invocation throwing still counts once without retry', async () => {
  let calls = 0;
  const result = await runWorker({model, thinkingLevel: 'off', modelRegistry: {
    find: () => model, getAvailable: () => [model], streamSimple: () => { calls++; throw new Error('fixture unavailable'); },
  }}, [], parseConfig({}), undefined);
  assert.equal(calls, 1);
  assert.equal(result.budget?.providerRequests, 1);
  assert.ok(result.budget!.initialRequestBytes! > 0);
  assert.ok(result.problem);
  assert.equal(result.proposal, undefined);
});
