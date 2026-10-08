import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config.ts';
import { safeFile } from '../src/evidence.ts';
import { evidenceTool } from '../src/exploration.ts';

test('evidence byte and response capacity feedback is numeric and never registers refused files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clio-budget-'));
  try {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src/a.ts'), 'a'.repeat(700));
    await writeFile(join(root, 'src/b.ts'), 'b'.repeat(700));
    const config = parseConfig({maxContextBytes: 1000});
    const files = [await safeFile(root, 'src/a.ts', config)];
    const result = await evidenceTool(root, files, config).execute('bytes', {action: 'read', path: 'src/b.ts'}, undefined);
    const body = JSON.parse((result.content[0] as any).text);
    assert.equal(body.status, 'capacity');
    assert.equal(body.refusal.limit, 'evidence-bytes');
    assert.equal(body.refusal.current, Buffer.byteLength(JSON.stringify(files)));
    assert.ok(body.refusal.requested > 700);
    assert.equal(body.refusal.max, 1000);
    assert.equal(files.length, 1);
    // Escaped control characters fit as raw UTF-8, but not as a whole JSON response.
    await writeFile(join(root, 'src/c.ts'), '\t'.repeat(700));
    const response = await evidenceTool(root, files, config).execute('response', {action: 'read', path: 'src/c.ts'}, undefined);
    const refusal = JSON.parse((response.content[0] as any).text).refusal;
    assert.equal(refusal.limit, 'response-bytes');
    assert.equal(refusal.current, 0);
    assert.ok(refusal.requested > refusal.max);
    assert.equal(files.length, 1);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('bounded listings expose eligible UTF-8 sizes and exact remaining evidence allowance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clio-budget-'));
  try {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src/a.ts'), 'é');
    await writeFile(join(root, 'src/b.ts'), 'hello');
    await writeFile(join(root, 'src/unsafe.ts'), 'password=VerySensitiveValue');
    const config = parseConfig({maxFiles: 1});
    const files = [await safeFile(root, 'src/a.ts', config)];
    const result = await evidenceTool(root, files, config).execute('list', {action: 'list', path: 'src'}, undefined);
    const body = JSON.parse((result.content[0] as any).text);
    assert.deepEqual(body.fileSizes, {'src/a.ts': 2, 'src/b.ts': 5});
    assert.equal(body.budget.remainingFiles, 0);
    assert.equal(body.budget.remainingEvidenceBytes, config.maxContextBytes - Buffer.byteLength(JSON.stringify(files)));
    assert.equal(files.length, 1);
  } finally { await rm(root, {recursive: true, force: true}); }
});
