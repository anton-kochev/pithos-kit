// Inert Docker CLI boundary. Never contacts a daemon or starts a container.
import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2), root = process.env.FAKE_DOCKER_ROOT;
appendFileSync(join(root, 'calls.jsonl'), JSON.stringify(args) + '\n');
const image = 'sha256:' + 'a'.repeat(64);
const scenario = process.env.FAKE_DOCKER_SCENARIO;
if (args[0] === 'exec') console.log('{}');
else if (args[0] === 'image' && args[1] === 'inspect') console.log(scenario === 'image-volumes' ? '1' : '0');
else if (args[0] === 'create') { writeFileSync(join(root, 'create.json'), JSON.stringify(args)); if (scenario.startsWith('create-error')) process.exit(1); console.log('b'.repeat(64)); }
else if (args[0] === 'inspect') {
  const format = args[2];
  if (args.at(-1) === 'source') console.log(`${scenario === 'source-stopped' ? 'false' : 'true'}|${image}`);
  else if (format.includes('.Config.Labels')) {
    if (scenario === 'create-error-uninspectable') process.exit(1);
    const create = JSON.parse(readFileSync(join(root, 'create.json'), 'utf8'));
    console.log(create[create.indexOf('--label') + 1].split('=')[1]);
  }
  else if (format.includes('.Mounts')) console.log(scenario === 'mount-drift' ? 'bind:/home/pi:true' : 'bind:/harness:false\nbind:/evidence:true\n');
  else if (format.includes('.State.OOMKilled')) {
    if (scenario === 'final-state-error') process.exit(1);
    const create = JSON.parse(readFileSync(join(root, 'create.json'), 'utf8'));
    console.log(JSON.stringify({ status: 'exited', exitCode: scenario === 'exit-error' ? 1 : 0, oomKilled: false, memoryLimit: 536870912, memorySwap: 1073741824, pidsLimit: Number(create[create.indexOf('--pids-limit') + 1]), nanoCpus: 1000000000 }));
  }
  else if (format.includes('.State.ExitCode')) console.log(scenario === 'exit-error' ? 'exited|1' : 'exited|0');
  else {
    const create = JSON.parse(readFileSync(join(root, 'create.json'), 'utf8'));
    const user = create[create.indexOf('--user') + 1];
    console.log(`${image}|${scenario === 'network-drift' ? 'bridge' : 'none'}|false|true|["ALL"]|["no-new-privileges=true"]|${user}||private||0`);
  }
} else if (args[0] === 'start') {
  if (scenario === 'start-error') process.exit(1);
  if (scenario === 'interrupt') { process.kill(process.ppid, 'SIGTERM'); process.exit(143); }
  const create = JSON.parse(readFileSync(join(root, 'create.json'), 'utf8'));
  const mount = create.find(arg => arg.includes('target=/evidence'));
  const output = /source=([^,]+)/.exec(mount)[1];
  if (scenario !== 'missing-report') writeFileSync(join(output, 'verification.json'), '{}');
  if (scenario !== 'missing-marker') console.log('OFFLINE_VERIFIED');
  if (create.includes('--synthetic-guild')) {
    mkdirSync(join(output, 'synthetic-guild'));
    if (scenario !== 'missing-guild-summary') writeFileSync(join(output, 'synthetic-guild/summary.json'), '{}');
    if (scenario !== 'missing-guild-marker') console.log('SYNTHETIC_GUILD_VERIFIED');
  }
  if (create.includes('--synthetic-pi')) {
    mkdirSync(join(output, 'synthetic'));
    if (scenario !== 'missing-synthetic-summary') writeFileSync(join(output, 'synthetic/summary.json'), '{}');
    if (scenario !== 'missing-synthetic-marker') console.log('SYNTHETIC_PI_VERIFIED');
  }
} else if (args[0] === 'rm') { if (scenario === 'cleanup-error') process.exit(1); }
else throw Error('Unexpected fake Docker command');
