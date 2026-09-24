// Supervisor-private create-registration preparation. Never derives authority
// from DriverResult, SupervisorSpawnObservation or a Docker client's PID.
import { randomUUID, createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { deploymentData, deploymentCheck as check, exactKeys, type ProducerDeployment } from './producer-deployment.ts';
import { inertDockerBoundary, type DockerSpawn } from './grading-docker.ts';
import { assertGradingPolicy, ownerControl, readTree, type GradingCommand } from './grading-owner.ts';
import type { DockerGradingSelection } from './grading-composition.ts';
import type { FinalizationIdentity } from './trial-finalization.ts';
import { digest } from './manifest.ts';
declare const attemptBrand: unique symbol;
export type ProducerAttempt = { readonly [attemptBrand]: true };
type State = 'prepared' | 'create-submitted' | 'identified' | 'handed' | 'consumed';
interface Attempt {
  deployment: ProducerDeployment; directory: string; identity: FinalizationIdentity; git: string;
  name: string; id?: string; state: State; submitting?: boolean; spawn?: DockerSpawn;
  mode?: 'container-diagnostic-launch-v1';
}
const attempts = new WeakMap<ProducerAttempt, Attempt>();
const reservedTrials = new WeakMap<ProducerDeployment, Set<string>>();
function held(handle: ProducerAttempt) { const value = attempts.get(handle); check(value); return value; }
export function producerAttemptState(handle: ProducerAttempt): State { return held(handle).state; }
export function prepareInertProducerAttempt(deployment: ProducerDeployment, directory: string, identity: FinalizationIdentity, git: string): ProducerAttempt {
  if (!process.env.NODE_TEST_CONTEXT) throw new Error('Inert producer issuer is test-only');
  const d = deploymentData(deployment);
  exactKeys(identity, ['trialId', 'requestDigest', 'baselineDigest', 'campaignDigest', 'admissionDigest', 'launchDigest']);
  check(dirname(directory) === d.retention.trialParent && basename(directory) === identity.trialId
    && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(identity.trialId)
    && Object.entries(identity).every(([k, v]) => k === 'trialId' || (typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)))
    && typeof git === 'string' && /^[a-f0-9]{64}$/.test(git));
  const reserved = reservedTrials.get(deployment) ?? new Set<string>();
  check(!reserved.has(directory)); reserved.add(directory); reservedTrials.set(deployment, reserved);
  const handle = Object.freeze({}) as ProducerAttempt;
  attempts.set(handle, { deployment, directory, identity: structuredClone(identity), git, name: `guild-grade-${randomUUID()}`, state: 'prepared' });
  return handle;
}
// Explicit separate discriminator; historical create-registration stays unchanged.
export function prepareInertContainerAttempt(deployment: ProducerDeployment, directory: string, identity: FinalizationIdentity, git: string): ProducerAttempt {
  const handle = prepareInertProducerAttempt(deployment, directory, identity, git);
  held(handle).mode = 'container-diagnostic-launch-v1';
  return handle;
}
export function containerAttemptBinding(handle: ProducerAttempt) {
  const a = held(handle), d = deploymentData(a.deployment);
  check(a.mode === 'container-diagnostic-launch-v1' && a.state === 'handed' && a.id);
  return { kind: a.mode, version: 1 as const, identity: structuredClone(a.identity), deploymentDigest: digest(d),
    producer: { id: a.id, name: a.name, image: d.image }, daemon: d.docker.daemonIdentity,
    endpoint: d.docker.endpoint, namespace: d.docker.namespaceIdentity,
    intentDigest: digest({ identity: a.identity, plan: producerCommand(handle), deployment: d }),
    receiver: `/tmp/guild-auth/${a.identity.trialId}/auth.json`, timeoutMs: 300000,
    forbiddenRoots: [d.producer.root, d.grader.root, d.exporter.root, d.exchange, d.retention.trialParent] };
}
export function producerCommand(handle: ProducerAttempt): GradingCommand {
  const a = held(handle), d = deploymentData(a.deployment);
  // Fixed create-only preparation. The preload itself still stops. No native
  // invocation, auth transport, namespace translation or start is authorized.
  return { file: 'docker', args: ['create', '--name', a.name, '--label', `pithos.guild.grading-owner=${a.name}`,
    '--pull', 'never', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges=true', '--user', `${d.uid}:${d.gid}`, '--ipc', 'private', '--init',
    '--pids-limit', '64', '--memory', '512m', '--cpus', '1',
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777',
    '--mount', `type=bind,source=${d.producer.root},target=/harness/guild,readonly`,
    '--mount', `type=bind,source=${join(a.directory, 'repo')},target=/evidence`,
    '--workdir', '/evidence', '--interactive', '--entrypoint', '/usr/bin/env', d.image,
    '-i', 'PATH=/usr/bin:/bin', 'HOME=/tmp', 'TMPDIR=/tmp', '/usr/bin/node', '/harness/guild/evaluation/src/native-preload.ts'] };
}
export function producerAttemptSelection(handle: ProducerAttempt): DockerGradingSelection {
  const a = held(handle), d = deploymentData(a.deployment);
  return { docker: { executable: d.docker.executable, endpoint: d.docker.endpoint, config: d.docker.config.root },
    grading: { image: d.image, uid: d.uid, gid: d.gid, code: d.grader.root, producer: join(a.directory, 'repo'),
      retained: join(d.retention.trialParent, '.finalization', a.identity.trialId, 'artifact'), exchange: d.exchange,
      sources: d.grader.files, imageFiles: { '/usr/bin/env': d.runtime.files['/usr/bin/env'], '/usr/bin/node': d.runtime.files['/usr/bin/node'] },
      producerIdentity: { id: a.id ?? '', name: a.name, image: d.image }, snapshotGitDigest: a.git },
    exporter: { code: d.exporter.root, sources: d.exporter.files } };
}
export function assertProducerAttemptPolicy(handle: ProducerAttempt, value: any) {
  const a = held(handle), d = deploymentData(a.deployment), s = producerAttemptSelection(handle).grading;
  check(['identified', 'handed', 'consumed'].includes(a.state) && value.Id === a.id && value.Image === d.image
    && value.Name === '/' + a.name && value.Config?.Labels?.['pithos.guild.grading-owner'] === a.name);
  assertGradingPolicy(value, { ...s, exchange: s.producer }, d.producer.root);
  const plan = producerCommand(handle).args;
  check(JSON.stringify(value.Config.Cmd) === JSON.stringify(plan.slice(plan.indexOf(d.image) + 1)));
}
export async function submitInertProducerCreate(handle: ProducerAttempt, spawn: DockerSpawn, signal?: AbortSignal) {
  if (!process.env.NODE_TEST_CONTEXT) throw new Error('Inert producer launcher is test-only');
  const a = held(handle); check(a.state === 'prepared' && !a.submitting);
  // Latch before the first await. Even a failed preflight cannot race/retry.
  a.submitting = true; a.spawn = spawn;
  let owner: ReturnType<typeof ownerControl>;
  try {
    const d = deploymentData(a.deployment), code = await readTree(d.producer.root, signal);
    const files = [...code].filter(([, e]) => e.kind === 'file');
    check(files.map(([p]) => p).sort().join(',') === Object.keys(d.producer.files).sort().join(',')
      && files.every(([p, e]) => e.kind === 'file' && createHash('sha256').update(e.bytes).digest('hex') === d.producer.files[p])
      && [...code].every(([p, e]) => e.kind === 'file' || Object.keys(d.producer.files).some(file => file.startsWith(p + '/'))));
    owner = ownerControl(inertDockerBoundary({ ...producerAttemptSelection(handle).docker, producerAttempt: handle }, spawn));
    signal?.throwIfAborted();
  } catch (error) { a.state = 'consumed'; throw error; }
  a.state = 'create-submitted';
  const id = await owner.control(producerCommand(handle).args, signal);
  check(/^[a-f0-9]{64}$/.test(id)); a.id = id; a.state = 'identified';
  const identity = producerAttemptSelection(handle).grading.producerIdentity;
  assertProducerAttemptPolicy(handle, await owner.inspect(identity, signal));
  signal?.throwIfAborted(); a.state = 'handed';
  // No cleanup by name, retry, absence inference or authority on uncertain create.
}
export function consumeProducerAttempt(handle: ProducerAttempt, deployment: ProducerDeployment) {
  const a = held(handle); check(a.state === 'handed'); a.state = 'consumed';
  check(a.deployment === deployment && a.spawn);
  const data = deploymentData(deployment);
  return { directory: a.directory, identity: structuredClone(a.identity), selection: producerAttemptSelection(handle), spawn: a.spawn,
    commitment: digest({ deployment: data, identity: a.identity, plan: producerCommand(handle), id: a.id }), mode: a.mode };
}
export function launchProducer(): never {
  throw new Error('CLOSED: operational producer launch, native namespace schema and auth transport unavailable');
}
