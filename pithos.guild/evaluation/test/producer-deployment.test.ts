import assert from 'node:assert/strict';
import test from 'node:test';
import { validateProducerDeployment, installInertProducerDeployment, deploymentData, acquireProducerDeployment } from '../src/producer-deployment.ts';
import { deploymentFixture } from './inert-producer-deployment-fixture.ts';
// List: exact data contract; original detached handles; fixed private storage;
// attempt state/uncertainty; separate producer mounts; connected finalization/audit.
test('deployment data is exact, detached and never acquisition authority', () => {
  const input = deploymentFixture('/fixture');
  assert.deepEqual(validateProducerDeployment(input), input);
  const handle = installInertProducerDeployment(input);
  input.image = 'sha256:' + 'f'.repeat(64);
  assert.notEqual(deploymentData(handle).image, input.image);
  for (const fake of [{}, structuredClone(handle), input]) assert.throws(() => deploymentData(fake as never));
  assert.throws(() => acquireProducerDeployment(input), /CLOSED/);
});
for (const kind of ['missing', 'extra', 'runtime', 'hash', 'gid', 'roster', 'overlap', 'alias', 'git', 'config'] as const) test(`deployment rejects ${kind}`, () => {
  const input: any = deploymentFixture('/fixture');
  if (kind === 'missing') delete input.docker;
  if (kind === 'extra') input.approved = true;
  if (kind === 'runtime') input.runtime.pi = '0.85.1';
  if (kind === 'hash') input.docker.sha256 = '';
  if (kind === 'gid') delete input.gid;
  if (kind === 'roster') input.grader.files['bank.ts'] = 'a'.repeat(64);
  if (kind === 'overlap') input.producer.root = input.retention.trialParent;
  if (kind === 'alias') input.mountAliases = [input.retention.trialParent];
  if (kind === 'git') delete input.git.version;
  if (kind === 'config') input.docker.config.mode = 0o755;
  assert.throws(() => validateProducerDeployment(input));
});
test('every required deployment field rejects omission, including inventory identities', () => {
  const original = deploymentFixture('/fixture');
  const visit = (value: any, path: string[]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const key of Object.keys(value)) {
      const input: any = structuredClone(original);
      let parent = input; for (const part of path) parent = parent[part];
      delete parent[key];
      assert.throws(() => validateProducerDeployment(input), [...path, key].join('.'));
      visit(value[key], [...path, key]);
    }
  };
  visit(original, []);
});
test('deployment install is unavailable outside the inert test issuer', () => {
  const context = process.env.NODE_TEST_CONTEXT;
  try { delete process.env.NODE_TEST_CONTEXT; assert.throws(() => installInertProducerDeployment(deploymentFixture('/fixture')), /test-only/); }
  finally { process.env.NODE_TEST_CONTEXT = context; }
});
