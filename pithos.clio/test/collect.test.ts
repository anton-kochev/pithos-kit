import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildWindows, collect } from '../src/collect.ts';
import { judgement, stubClassifier } from './helpers.ts';

const at = (minute: number) => new Date(Date.UTC(2026, 10, 26, 12, minute)).toISOString();
const user = (id: string, text: string, minute = 0) => ({ type: 'message', id, timestamp: at(minute), message: { role: 'user', content: [{ type: 'text', text }] } });
const assistant = (id: string, text: string, minute = 0) => ({ type: 'message', id, timestamp: at(minute), message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret' }, { type: 'text', text }] } });
const failure = (id: string, text: string, toolName = 'bash') => ({ type: 'message', id, timestamp: at(0), message: { role: 'toolResult', toolName, isError: true, content: [{ type: 'text', text }] } });
const config = { model: 'stub/c', collectThreshold: 1, gateThreshold: 1, maxWindows: 8, timeoutMs: 1000 };

test('one window per user turn: latest failure + assistant proposal + the reply', () => {
  const windows = buildWindows([
    user('u1', 'Do you have a browser?'),
    assistant('a1', 'Yes.'),
    user('u2', 'Use JSON for walkthroughs?'),
    failure('f1', 'ERR_MODULE_NOT_FOUND'),
    assistant('a2', 'I would make one versioned JSON document per walkthrough.'),
    user('u3', 'Yes, do it.'),
  ]);
  assert.equal(windows.length, 3);
  assert.deepEqual(windows[2].entryIds, ['f1', 'a2', 'u3']);
  assert.equal(windows[2].assistant, 'I would make one versioned JSON document per walkthrough.');
  assert.equal(windows[2].user, 'Yes, do it.');
  assert.match(windows[2].failure!, /^bash: ERR_MODULE_NOT_FOUND/);
  assert.ok(!JSON.stringify(windows).includes('secret'), 'thinking never reaches a window');
});

test('old Clio scheduling chatter and harness blocks are not session knowledge', () => {
  const windows = buildWindows([
    user('u1', 'Fix it.<system-reminder>internal</system-reminder>'),
    { type: 'custom_message', customType: 'clio-schedule', content: 'Call clio_capture' },
    assistant('a1', 'Skipped capture.'),
    user('u2', 'continue'),
  ]);
  assert.equal(windows[0].user, 'Fix it.');
  assert.equal(windows[1].assistant, undefined);
});

test('windows before the capture range start are ignored', () => {
  const windows = buildWindows([user('old', 'old talk', 0), assistant('a', 'answer', 5), user('new', 'new talk', 10)], Date.parse(at(9)));
  assert.deepEqual(windows.map(w => w.entryIds.at(-1)), ['new']);
});

test('the classifier keeps useful kinds at or above the threshold, best first, then in order', async () => {
  const windows = buildWindows([
    user('u1', 'status please'), assistant('a1', 'RF-04 passed on Go and .NET.'),
    user('u2', 'continue'), assistant('a2', 'Fix Go, not the text policy: the title is valid NFC.'),
    user('u3', 'Do it.'), assistant('a3', 'ok'),
    user('u4', 'thanks'),
  ]);
  const scores: Record<string, [string, number]> = {
    'status please': ['chatter', 0.1], continue: ['status-report', 2.0], 'Do it.': ['decision', 1.7], thanks: ['chatter', 0.2],
  };
  const classifier = stubClassifier(state => {
    const [kind, score] = scores[String(state.user)] ?? ['chatter', 0];
    return judgement(kind, score);
  });
  const result = await collect(windows, classifier, config);
  assert.equal(result.classified, true);
  assert.equal(result.considered, 4);
  assert.deepEqual(result.windows.map(w => w.user), ['Do it.']);
  assert.equal(result.windows[0].previous?.user, 'continue', 'the window before travels along as context');
});

test('an occasional failed classifier call drops just that window', async () => {
  const windows = buildWindows([user('u1', 'Decide X'), user('u2', 'Fix Go, not the policy'), user('u3', 'Yes, do it.')]);
  const result = await collect(windows, stubClassifier(state => state.user === 'Decide X' ? undefined : judgement('decision', 2)), config);
  assert.equal(result.classified, true);
  assert.equal(result.classifierFailure, undefined);
  assert.deepEqual(result.windows.map(w => w.user), ['Fix Go, not the policy', 'Yes, do it.']);
});

test('without a classifier the most recent windows are used, unjudged', async () => {
  const entries = Array.from({ length: 12 }, (_, i) => user(`u${i}`, `message ${i}`));
  const result = await collect(buildWindows(entries), undefined, undefined);
  assert.equal(result.classified, false);
  assert.equal(result.windows.length, 8);
  assert.equal(result.windows.at(-1)?.user, 'message 11');
});

test('a mostly failing classifier never looks like "nothing worth keeping": recent windows are used and the failure is reported', async () => {
  const windows = buildWindows([user('u1', 'Decide X'), assistant('a', 'ok'), user('u2', 'Yes, do it.')]);
  const result = await collect(windows, stubClassifier(() => undefined), config);
  assert.equal(result.classified, false);
  assert.equal(result.windows.length, 2);
  assert.deepEqual(result.classifierFailure && { failed: result.classifierFailure.failed, total: result.classifierFailure.total }, { failed: 2, total: 2 });
  assert.match(result.classifierFailure!.error, /./);
});
