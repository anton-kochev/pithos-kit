import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { deploymentFixture } from './inert-producer-deployment-fixture.ts';
import { backend } from './inert-docker-composition-fixture.ts';
import { installInertProducerDeployment } from '../src/producer-deployment.ts';
import { prepareInertContainerAttempt, prepareInertProducerAttempt, producerCommand, producerAttemptSelection } from '../src/producer-launcher.ts';
import { reserveFinalizationStorage } from '../src/finalization-storage.ts';
import { readTree } from '../src/grading-owner.ts';
import { approvedGitDigest } from '../src/grading-snapshot-core.ts';
import { digest } from '../src/manifest.ts';
import { loadDevelopmentBank } from '../src/bank.ts';
export async function preparation(t: import('node:test').TestContext, fault = '', container = false) {
  const root = await mkdtemp(join(tmpdir(), 'producer-chain-')); t.after(() => rm(root, { recursive: true, force: true }));
  const data = deploymentFixture(root), deployment = installInertProducerDeployment(data);
  const trialId = '00000000-0000-4000-8000-000000000001', directory = join(data.retention.trialParent, trialId);
  for (const path of [data.retention.trialParent, directory, join(directory, 'repo'), data.exchange]) await mkdir(path, { mode: 0o700 });
  for (const roster of [data.producer, data.grader, data.exporter]) for (const name of Object.keys(roster.files)) {
    await mkdir(dirname(join(roster.root, name)), { recursive: true }); await writeFile(join(roster.root, name), name);
  }
  await mkdir(join(directory, 'repo/src')); await mkdir(join(directory, 'repo/.git'));
  await writeFile(join(directory, 'repo/src/users.mjs'), 'inert never executed', { mode: 0o751 });
  await writeFile(join(directory, 'repo/.git/HEAD'), 'ref: refs/heads/eval\n');
  await writeFile(join(directory, 'repo/.git/index'), 'inert index never read by host Git');
  const baseline = { files: {}, index: 'inert', status: '', diff: '' };
  const identity = { trialId, requestDigest: digest('request'), baselineDigest: digest(baseline), campaignDigest: digest('campaign'), admissionDigest: digest('admission'), launchDigest: digest('launch') };
  const git = approvedGitDigest(await readTree(join(directory, 'repo')));
  const attempt = container ? prepareInertContainerAttempt(deployment, directory, identity, git) : prepareInertProducerAttempt(deployment, directory, identity, git);
  const selection = producerAttemptSelection(attempt), command = producerCommand(attempt);
  selection.grading.producerIdentity.id = 'c'.repeat(64); // Authored daemon outcome only.
  const fake = backend(selection, fault, data.producer.root, command.args);
  const storage = await reserveFinalizationStorage(deployment, directory, attempt);
  return { data, deployment, directory, identity, baseline, attempt, selection, fake, storage, git,
    task: loadDevelopmentBank().tasks.find(t => t.grader === 'authorization')! };
}
