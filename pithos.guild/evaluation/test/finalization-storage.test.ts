import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, rename, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installInertProducerDeployment } from '../src/producer-deployment.ts';
import { reserveFinalizationStorage, consumeFinalizationStorage, recheckFinalizationStorage } from '../src/finalization-storage.ts';
import { deploymentFixture } from './inert-producer-deployment-fixture.ts';
const id = '00000000-0000-4000-8000-000000000001';
async function fixture(t: import('node:test').TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'producer-storage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = deploymentFixture(root), deployment = installInertProducerDeployment(data);
  await mkdir(data.retention.trialParent, { mode: 0o700 });
  const directory = join(data.retention.trialParent, id); await mkdir(directory, { mode: 0o700 });
  for (const path of [data.producer.root, data.grader.root, data.exporter.root, data.exchange, join(directory, 'repo')]) await mkdir(path);
  return { root, data, deployment, directory, attempt: Object.freeze({}) };
}
test('storage is exclusive, original, trial and attempt bound', async t => {
  const p = await fixture(t), storage = await reserveFinalizationStorage(p.deployment, p.directory, p.attempt);
  await assert.rejects(reserveFinalizationStorage(p.deployment, p.directory, p.attempt));
  for (const fake of [{}, structuredClone(storage)]) assert.throws(() => consumeFinalizationStorage(fake as never, p.deployment, p.directory, p.attempt));
  assert.throws(() => consumeFinalizationStorage(storage, p.deployment, p.directory, {}));
  const second = await fixture(t), next = await reserveFinalizationStorage(second.deployment, second.directory, second.attempt);
  const evidence = consumeFinalizationStorage(next, second.deployment, second.directory, second.attempt);
  assert.equal(evidence.root, join(second.data.retention.trialParent, '.finalization', id));
  await recheckFinalizationStorage(evidence);
  assert.throws(() => consumeFinalizationStorage(next, second.deployment, second.directory, second.attempt));
});
for (const fault of ['mode', 'replacement', 'ancestor', 'symlink'] as const) test(`storage rejects ${fault}`, async t => {
  const p = await fixture(t);
  if (fault === 'symlink') {
    await mkdir(join(p.root, 'elsewhere'));
    await symlink(join(p.root, 'elsewhere'), join(p.data.retention.trialParent, '.finalization'));
    await assert.rejects(reserveFinalizationStorage(p.deployment, p.directory, p.attempt)); return;
  }
  const handle = await reserveFinalizationStorage(p.deployment, p.directory, p.attempt);
  const evidence = consumeFinalizationStorage(handle, p.deployment, p.directory, p.attempt);
  if (fault === 'mode') await chmod(evidence.root, 0o755);
  else {
    const path = fault === 'ancestor' ? p.data.retention.trialParent : evidence.root;
    await rename(path, path + '-old'); await mkdir(path, { mode: 0o700 });
  }
  await assert.rejects(recheckFinalizationStorage(evidence));
});
test('declared mount aliases cannot hide symlinked retention ancestors', async t => {
  const p = await fixture(t);
  const alias = join(p.root, 'mounted-alias');
  await symlink(p.data.retention.trialParent, alias);
  const deployment = installInertProducerDeployment({ ...p.data, mountAliases: [alias] });
  await assert.rejects(reserveFinalizationStorage(deployment, p.directory, p.attempt));
});
