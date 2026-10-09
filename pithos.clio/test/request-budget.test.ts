import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config.ts';
import { safeFile, snapshot, type Snapshot } from '../src/evidence.ts';
import { runWorker } from '../src/worker.ts';
import { model, answer, stream } from './worker.test.ts';

const empty = () => answer([{type: 'text', text: '{"findings":[],"edits":[],"unresolved":[]}'}]);
function ctx(respond: (context: any) => ReturnType<typeof answer>) {
  return {model, thinkingLevel: 'off' as const, modelRegistry: {find: () => model, getAvailable: () => [model], streamSimple: (_m: any, context: any) => stream(respond(context))}};
}
const prompt = (context: any) => JSON.parse(context.messages.find((m: any) => m.role === 'user').content[0].text);

test('initial full request admits whole observed source before many discovered docs', async () => {
  const config = parseConfig({});
  const source: Snapshot = {path: 'src/Cache.cs', text: 'public class Cache { string path = "C:\\cache"; }\n'.repeat(500), hash: 'source', dev: 1, ino: 1, doc: false};
  const files: Snapshot[] = [...Array.from({length: 13}, (_, i) => ({path: `docs/page${i}.md`, text: 'Documentation "quoted" é \\ line\n'.repeat(180), hash: `doc${i}`, dev: 1, ino: i + 2, doc: true})), source];
  assert.ok(Buffer.byteLength(JSON.stringify(files)) < config.maxContextBytes);
  let calls = 0;
  const result = await runWorker(ctx(context => {
    calls++;
    assert.ok(Buffer.byteLength(JSON.stringify(context)) <= config.maxContextBytes);
    const body = prompt(context);
    assert.deepEqual(body.files[0], {path: source.path, text: source.text, doc: false});
    assert.ok(body.omissions.files > 0);
    assert.equal(body.omissions.files, 14 - body.files.length);
    assert.deepEqual(body.files.map((f: any) => f.path), files.map(f => f.path));
    for (const f of body.files) assert.equal(f.text, f.path === source.path ? source.text : 'Documentation "quoted" é \\ line\n'.repeat(180));
    return empty();
  }), files, config, undefined, {observedPaths: ['src/Cache.cs']} as any);
  assert.equal(result.problem, undefined);
  assert.equal(calls, 1);
});

test('candidate collection does not let observed docs consume the source admission slot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clio-request-'));
  try {
    await mkdir(join(root, 'src')); await mkdir(join(root, 'docs'));
    await writeFile(join(root, 'src/Cache.cs'), 'public class Cache {}');
    await writeFile(join(root, 'docs/observed.md'), 'Observed documentation');
    const config = parseConfig({maxFiles: 1});
    const files = await snapshot(root, ['docs/observed.md', 'src/Cache.cs'], config);
    const result = await runWorker(ctx(context => {
      assert.deepEqual(prompt(context).files.map((f: any) => f.path), ['src/Cache.cs']);
      assert.equal(prompt(context).omissions.files, 1);
      return empty();
    }), files, config, undefined, {root, observedPaths: ['docs/observed.md', 'src/Cache.cs']});
    assert.equal(result.problem, undefined);
    assert.deepEqual(files.map(f => f.path), ['src/Cache.cs']);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('impossible mandatory initial request makes no provider call and preserves host numeric diagnostic', async () => {
  const files: Snapshot[] = [{path: 'src/a.ts', text: 'a', doc: false, hash: 'a', dev: 1, ino: 1}];
  let calls = 0;
  const result = await runWorker(ctx(() => { calls++; return empty(); }), files, parseConfig({maxContextBytes: 1000}), undefined);
  assert.equal(calls, 0);
  assert.match(result.problem!, /^Clio: initial request: request-context-bytes budget exceeded; current=0; requested=\d+; max=1000$/);
  assert.equal(files.length, 0, 'no citable evidence when initial admission is impossible');
});

test('projected batch continuation refuses bodies before registration and permits finalization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clio-continuation-'));
  try {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src/a.ts'), 'export const a = 1;');
    await writeFile(join(root, 'src/b.ts'), 'b'.repeat(6000));
    await writeFile(join(root, 'src/c.ts'), 'c'.repeat(6000));
    const config = parseConfig({maxContextBytes: 24000});
    const files = [await safeFile(root, 'src/a.ts', config)];
    let calls = 0;
    const result = await runWorker(ctx(context => {
      assert.ok(Buffer.byteLength(JSON.stringify(context)) <= config.maxContextBytes);
      if (++calls === 1) return answer([
        {type: 'toolCall', id: 'first', name: 'clio_evidence', arguments: {action: 'read', path: 'src/b.ts'}},
        {type: 'toolCall', id: 'second', name: 'clio_evidence', arguments: {action: 'read', path: 'src/c.ts'}},
        {type: 'toolCall', id: 'repeat', name: 'clio_evidence', arguments: {action: 'read', path: 'src/b.ts'}},
        {type: 'toolCall', id: 'listing', name: 'clio_evidence', arguments: {action: 'list', path: 'src'}},
      ], 'toolUse');
      const results = context.messages.filter((m: any) => m.role === 'toolResult');
      assert.equal(JSON.parse(results[0].content[0].text).text, 'b'.repeat(6000));
      for (const index of [1, 2]) {
        const feedback = JSON.parse(results[index].content[0].text);
        assert.equal(feedback.status, 'capacity');
        assert.equal(feedback.refusal.limit, 'request-context-bytes');
        assert.ok(feedback.refusal.requested > feedback.refusal.max);
        assert.equal(results[index].isError, false);
      }
      assert.doesNotMatch(JSON.stringify(results), /c{100}/);
      assert.equal(files.some(f => f.path === 'src/c.ts'), false);
      return empty();
    }), files, config, undefined, {root, observedPaths: ['src/a.ts']});
    assert.equal(result.problem, undefined);
    assert.equal(calls, 2);
    assert.deepEqual(files.map(f => f.path), ['src/a.ts', 'src/b.ts']);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('relevant ancestor docs are admitted before other discovered documentation', async () => {
  const files: Snapshot[] = [
    {path: 'handbook/other.md', text: 'Other', doc: true, hash: 'other', dev: 1, ino: 1},
    {path: 'src/docs/local.md', text: 'Local', doc: true, hash: 'local', dev: 1, ino: 2},
    {path: 'src/a.ts', text: 'Source', doc: false, hash: 'source', dev: 1, ino: 3},
  ];
  const result = await runWorker(ctx(context => {
    assert.deepEqual(prompt(context).files.map((f: any) => f.path), ['src/a.ts', 'src/docs/local.md']);
    return empty();
  }), files, parseConfig({maxFiles: 2, docsDirs: ['handbook']}), undefined, {observedPaths: ['src/a.ts']});
  assert.equal(result.problem, undefined);
});

test('duplicate tool IDs cannot bypass batch reservations or register evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clio-duplicate-'));
  try {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src/a.ts'), 'a'); await writeFile(join(root, 'src/b.ts'), 'b');
    const config = parseConfig({});
    const files = [await safeFile(root, 'src/a.ts', config)];
    let calls = 0;
    const result = await runWorker(ctx(() => {
      if (++calls > 1) return empty();
      return answer([
        {type: 'toolCall', id: 'same', name: 'clio_evidence', arguments: {action: 'read', path: 'src/a.ts'}},
        {type: 'toolCall', id: 'same', name: 'clio_evidence', arguments: {action: 'read', path: 'src/b.ts'}},
      ], 'toolUse');
    }), files, config, undefined, {root});
    assert.match(result.problem!, /invalid or unavailable tool batch/);
    assert.equal(calls, 1);
    assert.deepEqual(files.map(f => f.path), ['src/a.ts']);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('omitted ancestor documentation does not expand observed source authorization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clio-scope-budget-'));
  try {
    await mkdir(join(root, 'pkg/src'), {recursive: true});
    await writeFile(join(root, 'pkg/src/a.ts'), 'a');
    await writeFile(join(root, 'pkg/README.md'), 'Parent documentation');
    await writeFile(join(root, 'pkg/unrelated.ts'), 'not observed');
    const config = parseConfig({maxFiles: 1});
    const files = await snapshot(root, ['pkg/src/a.ts'], config);
    let calls = 0;
    const result = await runWorker(ctx(() => {
      if (++calls > 1) return empty();
      return answer([{type: 'toolCall', id: 'outside', name: 'clio_evidence', arguments: {action: 'list', path: 'pkg'}}], 'toolUse');
    }), files, config, undefined, {root, observedPaths: ['pkg/src/a.ts']});
    assert.match(result.problem!, /outside observed scope/);
    assert.equal(calls, 1);
    assert.deepEqual(files.map(f => f.path), ['pkg/src/a.ts']);
  } finally { await rm(root, {recursive: true, force: true}); }
});

// Intentional invariant pin: guard counts UTF-8 bytes of the nested JSON,
// not JS characters, and admits equality while refusing one extra ASCII byte.
test('serialized request boundary counts multibyte and nested escaping exactly', async () => {
  const {assertRequestBudget, requestBytes} = await import('../src/budget.ts');
  const config = parseConfig({maxContextBytes: 1000});
  const context = {messages: [{role: 'user', content: [{type: 'text', text: JSON.stringify({text: 'é"\\\n'})}]}]};
  const block = context.messages[0].content[0];
  const bytes = Buffer.byteLength(JSON.stringify(context));
  block.text += 'a'.repeat(1000 - bytes);
  assert.equal(requestBytes(context), 1000);
  assert.doesNotThrow(() => assertRequestBudget(context, config));
  block.text += 'a';
  assert.throws(() => assertRequestBudget(context, config), /current=0; requested=1001; max=1000/);
});

// Review test list: bounded many-large-doc pool and source priority; omitted
// eligible observations retain scopes without retaining bodies; exclusions do not.
test('many large docs retain a bounded pool and still admit a later observed source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clio-pool-'));
  try {
    await mkdir(join(root, 'docs')); await mkdir(join(root, 'src'));
    const docs = Array.from({length: 80}, (_, i) => `docs/page${i}.md`);
    for (const path of docs) await writeFile(join(root, path), 'Large documentation\n'.repeat(5000));
    await writeFile(join(root, 'src/Cache.cs'), 'public class Cache {}');
    const config = parseConfig({});
    const files = await snapshot(root, [...docs, 'src/Cache.cs'], config);
    assert.ok(Buffer.byteLength(JSON.stringify(files)) <= config.maxContextBytes, 'retained snapshot pool exceeds aggregate byte cap');
    assert.ok(files.length <= config.maxFiles);
    assert.equal(files[0].path, 'src/Cache.cs');
    const result = await runWorker(ctx(context => {
      const body = prompt(context);
      assert.equal(body.files[0].path, 'src/Cache.cs');
      assert.equal(body.files[0].text, 'public class Cache {}');
      assert.equal(body.omissions.files, 81 - body.files.length);
      assert.ok(body.omissions.poolFiles > 0);
      assert.ok(Buffer.byteLength(JSON.stringify(files)) <= config.maxContextBytes);
      return empty();
    }), files, config, undefined, {root, observedPaths: [...docs, 'src/Cache.cs']});
    assert.equal(result.problem, undefined);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('pool-omitted eligible observations authorize scopes but excluded observations do not', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clio-pool-scope-'));
  try {
    for (const dir of ['first', 'second', 'hidden']) await mkdir(join(root, dir));
    await writeFile(join(root, 'first/a.ts'), 'a');
    await writeFile(join(root, 'second/b.ts'), 'b');
    await writeFile(join(root, 'second/c.ts'), 'c');
    await writeFile(join(root, 'hidden/secret.ts'), 'excluded');
    await writeFile(join(root, 'hidden/sibling.ts'), 'not authorized');
    const config = parseConfig({maxFiles: 1});
    const observedPaths = ['first/a.ts', 'second/b.ts', 'hidden/secret.ts'];
    const files = await snapshot(root, observedPaths, config);
    assert.deepEqual(files.map(f => f.path), ['first/a.ts']);
    let calls = 0;
    const result = await runWorker(ctx(context => {
      if (++calls === 1) return answer([{type: 'toolCall', id: 'allowed', name: 'clio_evidence', arguments: {action: 'list', path: 'second'}}], 'toolUse');
      const listing = JSON.parse(context.messages.find((m: any) => m.role === 'toolResult').content[0].text);
      assert.deepEqual(new Set(listing.entries), new Set(['second/b.ts', 'second/c.ts']));
      assert.doesNotMatch(JSON.stringify(context), /hidden|secret\.ts/);
      return answer([{type: 'toolCall', id: 'excluded', name: 'clio_evidence', arguments: {action: 'list', path: 'hidden'}}], 'toolUse');
    }), files, config, undefined, {root}); // Direct snapshot API must retain original provenance.
    assert.equal(calls, 2);
    assert.match(result.problem!, /outside observed scope/);
    assert.deepEqual(files.map(f => f.path), ['first/a.ts']);
  } finally { await rm(root, {recursive: true, force: true}); }
});
