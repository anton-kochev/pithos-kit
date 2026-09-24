import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2), scenario = process.env.SCENARIO;
appendFileSync(process.env.FAKE_ROOT + '/calls', JSON.stringify(args) + '\n');
if (args[0] === 'image') {
  const user = { 'user-pi': 'pi', 'user-root': 'root', 'user-empty': '', 'user-pair': '501:501' }[scenario] ?? '501';
  console.log([scenario === 'id' ? 'sha256:unexpected' : 'sha256:edcbed99a004b66c67c0dd1d3ea794d6c0a2e83da18be770aeddedeff534dbff', scenario === 'os' ? 'darwin' : 'linux', scenario === 'arch' ? 'amd64' : 'arm64', user, scenario === 'volume' ? 'true' : 'false'].join('\t'));
} else if (args[0] === 'create') {
  if (scenario === 'collision') process.exit(1);
  if (scenario === 'cancel-no-id') { process.kill(process.ppid, 'SIGTERM'); process.exit(1); }
  console.log('a'.repeat(64));
  if (scenario === 'cancel-id') process.kill(process.ppid, 'SIGTERM');
  if (scenario === 'returned-error') process.exit(1);
} else if (args[0] === 'rm') {
  if (scenario === 'cleanup') process.exit(1);
} else if (args[0] === 'cp') {
  const targeted = /^(main|config)-(.*)$/.exec(scenario);
  const leafScenario = targeted ? (args[1].endsWith('/dist/' + targeted[1] + '.js') ? targeted[2] : '') : scenario;
  if (leafScenario === 'missing') process.exit(1);
  const h = Buffer.alloc(512), payload = Buffer.from('inert selected bytes: ' + args[1].split(':').slice(1).join(':') + '\n');
  h.write(leafScenario === 'traversal' ? '../escape' : args[1].split('/').at(-1));
  h.write('0000600\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write((leafScenario === 'oversize' ? 134217729 : payload.length).toString(8).padStart(11, '0') + '\0', 124);
  h.fill(32, 148, 156); h[156] = (leafScenario === 'symlink' ? '2' : leafScenario === 'directory' ? '5' : '0').charCodeAt(0);
  h.write('ustar\0', 257); h.write('00', 263);
  const sum = h.reduce((a,b) => a+b, 0); h.write(sum.toString(8).padStart(6, '0') + '\0 ',148);
  if (leafScenario === 'checksum') h[0] ^= 1;
  process.stdout.write(Buffer.concat([h, payload, Buffer.alloc(512-payload.length), leafScenario === 'extra' ? Buffer.concat([h, Buffer.alloc(512)]) : Buffer.alloc(1024)]));
} else process.exit(99);
