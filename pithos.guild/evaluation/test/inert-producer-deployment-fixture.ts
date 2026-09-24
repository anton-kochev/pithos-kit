import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { digest } from '../src/manifest.ts';
export const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
// Every identity is authored synthetic data, not supplied image verification.
export function deploymentFixture(root: string) {
  const roster = (directory: string, names: string[]) => {
    const files = Object.fromEntries(names.map(name => [name, hash(name)]));
    return { root: join(root, directory), files, inventoryDigest: digest(files) };
  };
  return {
    version: 1 as const, image: 'sha256:' + hash('inert image'), uid: 1000, gid: 1000,
    runtime: { node: 'v24.20.0', pi: '0.87.0', piAi: '0.87.0', platform: 'linux', arch: 'arm64',
      files: { '/usr/bin/env': hash('env'), '/usr/bin/node': hash('node') }, inventoryDigest: digest({ '/usr/bin/env': hash('env'), '/usr/bin/node': hash('node') }) },
    docker: { executable: '/reviewed/docker', sha256: hash('docker'), endpoint: 'unix:///private/docker.sock',
      daemonIdentity: hash('daemon'), namespaceIdentity: hash('namespace'),
      config: { root: '/private/config', uid: 1000, gid: 1000, mode: 0o700, files: { 'config.json': hash('{}') }, inventoryDigest: digest({ 'config.json': hash('{}') }) } },
    git: { executable: '/usr/bin/git', version: '2.47.0', sha256: hash('git') },
    producer: roster('producer-code', ['evaluation/src/native-preload.ts']),
    grader: roster('grader-code', ['grading-bootstrap.ts', 'grading-observer.ts']),
    exporter: roster('exporter-code', ['grading-snapshot-bootstrap.ts', 'grading-snapshot-core.ts', 'grading-snapshot-protocol.ts']),
    exchange: join(root, 'exchange'), mountAliases: [] as string[],
    retention: { trialParent: join(root, 'trials'), uid: process.getuid!(), gid: process.getgid!(), mode: 0o700 },
  };
}
