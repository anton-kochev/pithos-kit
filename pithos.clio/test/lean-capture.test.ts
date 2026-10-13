import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEditTool } from '@earendil-works/pi-coding-agent';
import { parseConfig } from '../src/config.ts';
import { snapshot } from '../src/evidence.ts';
import { discoverDestinations } from '../src/destinations.ts';
import { runWorker } from '../src/worker.ts';
import { applyProposal } from '../src/apply.ts';
import { completion } from '../src/ui.ts';
import { model, answer, stream } from './worker.test.ts';

// Test list: observed-only initial bodies; scoped discovery/read at DEFAULT limits;
// exact test-assertion correction through real guarded edit; qualifications; metrics.
test('lean capture corrects asserted registration at default budget amid unrelated docs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clio-lean-'));
  try {
    await mkdir(join(root, 'tests')); await mkdir(join(root, 'docs/engineering'), {recursive: true});
    const observedPaths = ['tests/RegistrationTests.cs', 'tests/DependencyTests.cs'];
    await writeFile(join(root, observedPaths[0]), 'public void RegistersServices() { Assert.Contains(services, s => s.ServiceType == typeof(IRegistry)); }\n');
    await writeFile(join(root, observedPaths[1]), 'public void DependenciesPointInward() { Assert.DoesNotContain(references, r => r.Name == "Infrastructure"); }\n');
    const target = 'docs/engineering/dependency-direction.md';
    const before = '# Dependency direction\nThe tests assert that IRegistry is not registered.\n';
    const after = '# Dependency direction\nRegistrationTests asserts that IRegistry is registered; DependencyTests asserts that references exclude Infrastructure. These are test assertions, not verified test-run results or production behavior.\n';
    await writeFile(join(root, target), before);
    for (let i = 0; i < 35; i++) await writeFile(join(root, `docs/unrelated-${i}.md`), '# Unrelated guide\n' + 'Unrelated documentation body.\n'.repeat(200));
    await writeFile(join(root, 'docs/secret.md'), 'must not be disclosed');
    await writeFile(join(root, 'docs/unsafe.md'), 'password=super-sensitive-value');
    const config = parseConfig({});
    const files = await snapshot(root, observedPaths, config);
    assert.deepEqual(files.map(f => f.path), observedPaths, 'only original eligible observations are initial body candidates');
    const destinations = await discoverDestinations(root, observedPaths, config);
    let calls = 0, initialRequestBytes = 0;
    const qualification = 'Production and test execution were not verified; this correction describes assertions only.';
    const result = await runWorker({model, thinkingLevel: 'off', modelRegistry: {
      find: () => model, getAvailable: () => [model], streamSimple: (_m, context) => {
        calls++;
        const serialized = JSON.stringify(context);
        assert.ok(Buffer.byteLength(serialized) <= config.maxContextBytes);
        assert.doesNotMatch(serialized, /Unrelated documentation body|secret\.md|unsafe\.md|super-sensitive/);
        if (calls === 1) {
          initialRequestBytes = Buffer.byteLength(serialized);
          assert.match(serialized, /qualifications/);
          const body = JSON.parse((context.messages.find(m => m.role === 'user')!.content as any)[0].text);
          assert.deepEqual(body.files.map((f: any) => f.path), observedPaths);
          assert.equal(body.omissions.files, 0, 'unread discovery is not omitted candidate evidence');
          return stream(answer([{type: 'toolCall', id: 'list', name: 'clio_evidence', arguments: {action: 'list', path: 'docs/engineering'}}], 'toolUse'));
        }
        if (calls === 2) {
          assert.match(serialized, /dependency-direction\.md/);
          assert.equal(files.length, 2, 'listing is not evidence');
          return stream(answer([{type: 'toolCall', id: 'read', name: 'clio_evidence', arguments: {action: 'read', path: target}}], 'toolUse'));
        }
        assert.equal(calls, 3);
        return stream(answer([{type: 'text', text: JSON.stringify({findings: [{claim: 'The observed tests assert registration and inward dependencies.', kind: 'observed', sources: observedPaths.map(path => ({path, startLine: 1, endLine: 1}))}], edits: [{path: target, oldText: before, newText: after, findings: [0]}], unresolved: [], qualifications: [qualification]})}]));
      },
    }}, files, config, undefined, {root, observedPaths, destinations});
    assert.equal(result.problem, undefined);
    assert.equal(calls, 3);
    assert.equal(result.budget?.initialRequestBytes, initialRequestBytes, 'actual provider context bytes, not execution-tool metadata');
    assert.ok(result.budget!.initialGuardedRequestBytes! > initialRequestBytes);
    assert.ok(result.budget!.initialGuardedRequestBytes! <= config.maxContextBytes);
    assert.deepEqual(result.budget, {
      initialRequestBytes, initialGuardedRequestBytes: result.budget!.initialGuardedRequestBytes,
      candidateFiles: 2, admittedFiles: 2, omittedFiles: 0, poolOmittedFiles: 0,
      discoveredDirectories: destinations.filter(d => !d.missing).length,
      missingDestinationDirectories: 0, providerRequests: 3, capacityRefusals: {},
    });
    assert.deepEqual(files.map(f => f.path), [...observedPaths, target]);
    let guards = 0;
    const edit = createEditTool(root);
    const applied = await applyProposal(root, result.proposal!, files, config, async (name, args) => {
      assert.equal(name, 'edit');
      return {isError: false, result: await edit.execute('guarded-edit', args as any)};
    }, () => { guards++; });
    assert.ok(guards >= 2);
    assert.deepEqual(applied.problems, []);
    assert.deepEqual(applied.changed, [target]);
    assert.deepEqual(applied.qualifications, [qualification]);
    const summary = completion(applied, 0, result, files.map(f => f.path))!;
    assert.match(summary, /3 requests/);
    assert.ok(summary.includes(`${initialRequestBytes}B initial`));
    assert.match(summary, /2\/2 candidates admitted · 0 omitted/);
    assert.match(summary, /0 capacity refusals/);
    assert.match(summary, /0 unresolved/);
    assert.ok(summary.includes(`Qualification: ${qualification}`));
    assert.equal(await readFile(join(root, target), 'utf8'), after);
  } finally { await rm(root, {recursive: true, force: true}); }
});
