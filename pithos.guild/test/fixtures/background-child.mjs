import { readFileSync } from 'node:fs';
const task = JSON.parse(readFileSync(process.env.GUILD_TASK_FILE, 'utf8'));
const args = process.argv.slice(2);
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const {task: text, practices, ...header} = task;
const report = {...header, taskOutcome: practices.length ? 'blocked' : 'succeeded', compliance: practices.length ? [{id: 'tdd', policy: 'required', status: 'blocked', reason: 'Scripted, no task tests', cycles: [], limitations: []}] : [], summary: 'Scripted report', blockers: practices.length ? ['Fixture'] : [], limitations: [], payload: task.role === 'reviewer' ? {scope: [], findings: [], verdict: 'Approve'} : {changes: [], verification: []}};
const submit = () => {
 emit({type: 'message_end', message: {role: 'assistant', content: [{type: 'toolCall', name: 'guild_submit_result', id: 'submit', arguments: report}], usage: {input: 3}}});
 emit({type: 'tool_execution_start', toolName: 'guild_submit_result', toolCallId: 'submit', args: report});
 emit({type: 'tool_execution_end', toolName: 'guild_submit_result', toolCallId: 'submit', isError: false, result: {details: report}});
 if (text === 'nonzero') process.exitCode = 7;
 if (text === 'hang-eof') {process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);}
 if (text === 'post-submit-work') emit({type: 'agent_start'});
 emit({type: 'agent_settled'});
};
let buffer = '';
const steers = [];
// Explicit signal gate gives lifecycle tests real close evidence without timing sleeps.
if (text === 'question-gated') {
 setInterval(() => {}, 1000);
 process.on('SIGTERM', () => emit({type: 'fixture-stopping'}));
 process.on('SIGUSR2', () => process.exit(0));
}
if (text === 'question-hold') {
 const keepAlive = setInterval(() => {}, 1000);
 process.on('SIGTERM', () => { clearInterval(keepAlive); setTimeout(() => process.exit(0), 250); });
}
process.stdin.on('data', chunk => {
 buffer += chunk;
 for (;;) {
  const index = buffer.indexOf('\n'); if (index < 0) break;
  const command = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
  if (command.type === 'prompt') {
   if (text === 'command-timeout') continue;
   if (text === 'unexpected-exit') process.exit(0);
   emit({type: 'response', id: command.id, command: 'prompt', success: true, data: {disposition: 'started'}});
   if (text === 'handshake-timeout') continue;
   emit({type: 'fixture', args, taskFile: process.env.GUILD_TASK_FILE, pid: process.pid});
   emit({type: 'message_end', message: {role: 'custom', customType: 'guild-protocol-ready', details: {protocol: task.protocol, version: 2, runId: task.runId, taskId: task.taskId, tools: args[args.indexOf('--tools') + 1].split(','), capability: 'guild-background/1'}}});
   if (text === 'line-limit') {process.stdout.write('x'.repeat(1048577)); continue;}
   if (text === 'utf8') {process.stdout.write(Buffer.from([255, 10])); continue;}
   if (text === 'stdout-limit') {for (let i = 0; i < 260; i++) emit({type: 'padding', text: 'x'.repeat(65536)}); continue;}
   if (text === 'stderr-limit') {process.stderr.write('x'.repeat(65537)); continue;}
   if (text === 'provider-error') {emit({type: 'message_end', message: {role: 'assistant', stopReason: 'error', errorMessage: 'Scripted provider failed', content: []}}); continue;}
   if (text.startsWith('question')) {
    const question = `Question from ${process.pid}`;
    emit({type: 'message_end', message: {role: 'assistant', content: [{type: 'toolCall', name: 'guild_ask_parent', id: 'ask', arguments: {question}}]}});
    emit({type: 'tool_execution_start', toolName: 'guild_ask_parent', toolCallId: 'ask', args: {question}});
    const ui = {type: 'extension_ui_request', id: 'ui', method: text === 'question-method' ? 'confirm' : 'input', timeout: 300000, title: JSON.stringify({protocol: 'guild-background/1', runId: text === 'question-identity' ? 'wrong' : task.runId, taskId: task.taskId, toolCallId: 'ask', question})};
    emit(ui);
    if (text === 'question-duplicate') emit(ui);
    if (text === 'question-close') setTimeout(() => process.exit(0), 40);
    if (text === 'question-ui-timeout') setTimeout(() => {
     const details = {outcome: 'unavailable', reason: 'cancelled-or-timed-out'};
     emit({type: 'tool_execution_end', toolName: 'guild_ask_parent', toolCallId: 'ask', isError: false, result: {details, content: [{type: 'text', text: JSON.stringify(details)}]}});
    }, 40);
   } else if (text !== 'updates') submit();
  } else if (command.type === 'extension_ui_response') {
   if (command.id !== 'ui' || (!command.cancelled && command.value !== `Answer for ${process.pid}`)) process.exit(7);
   const details = command.cancelled ? {outcome: 'unavailable', reason: 'cancelled-or-timed-out'} : {outcome: 'answered', answer: text === 'question-mismatch' ? 'wrong answer' : command.value};
   emit({type: 'tool_execution_end', toolName: 'guild_ask_parent', toolCallId: 'ask', isError: false, result: {details, content: [{type: 'text', text: JSON.stringify(text === 'question-content' ? {outcome: 'answered', answer: 'forged'} : details)}]}});
   const message = {role: 'toolResult', toolName: 'guild_ask_parent', toolCallId: text === 'question-message-id' ? 'wrong' : 'ask', isError: false,
    details: text === 'question-message-details' ? {outcome: 'answered', answer: 'forged'} : details,
    content: [{type: 'text', text: JSON.stringify(text === 'question-message-content' ? {outcome: 'answered', answer: 'forged'} : details)}], timestamp: Date.now()};
   if (text !== 'question-message-missing') {
    emit({type: 'message_start', message});
    emit({type: 'message_end', message});
    if (text === 'question-message-duplicate') emit({type: 'message_end', message});
   }
   report.summary = `Replied in ${process.pid}`;
   submit();
  } else if (command.type === 'steer') {
   steers.push(command);
   if (steers.length === 2) {
    for (const item of steers.toReversed()) emit({type: 'response', id: item.id, command: 'steer', success: true, data: {disposition: item.message === 'one' ? 'queued' : 'handled'}});
    submit();
   }
  } else if (command.type === 'clear_queue') {
   emit({type: 'queue_update', steering: text === 'invalid-queue-update' ? {} : [], followUp: []});
   emit({type: 'response', id: command.id, command: 'clear_queue', success: true, data: {steering: [], followUp: []}});
  }
 }
});
