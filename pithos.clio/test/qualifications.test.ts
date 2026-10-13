import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig } from '../src/config.ts';
import { validateProposal } from '../src/evidence.ts';
import { applyProposal } from '../src/apply.ts';
import { completion } from '../src/ui.ts';
import { POLICY } from '../src/policy.ts';

// Prompt contract: assertion-only corrections need scope qualifications, not
// invented execution verification or unresolved blockers.
test('worker policy distinguishes assertion-only qualifications from unresolved problems', () => {
  assert.match(POLICY, /qualifications[^.]*informational[^.]*nonblocking/s);
  assert.match(POLICY, /missing test execution[^.]*qualification[^.]*assertions/s);
  assert.match(POLICY, /unresolved[^.]*contradictions[^.]*missing evidence/s);
  assert.match(POLICY, /Never claim[^.]*tests passed[^.]*production behavior/s);
});

const qualification = 'Production implementation and test-run results were not verified; correction describes test assertions, not a passed suite.';
test('structured qualifications survive validation and apply without becoming unresolved', async () => {
  const config = parseConfig({});
  const raw = {findings: [], edits: [], unresolved: [], qualifications: [qualification]};
  const proposal = validateProposal(JSON.stringify(raw), [], config);
  const apply = (p: typeof proposal) => applyProposal('.', p, [], config, async () => { throw new Error('unexpected dispatch'); }, () => {});
  const applied = await apply(proposal);
  assert.deepEqual(applied.qualifications, [qualification]);
  assert.deepEqual(applied.problems, []);
  assert.equal(completion(applied, 0, undefined, []), undefined, 'qualification-only no-op stays quiet');
  const changed = {...applied, changed: ['docs/assertions.md']};
  const summary = completion(changed, 0, undefined, [])!;
  assert.match(summary, /0 unresolved/);
  assert.ok(summary.includes(`Qualification: ${qualification}`));
  assert.doesNotMatch(summary, /Unresolved:/);
  const unresolved = await apply({...proposal, unresolved: [qualification]});
  assert.deepEqual(unresolved.problems, [qualification], 'no string heuristic may reclassify explicit unresolved work');
  assert.match(completion(unresolved, 0, undefined, [])!, /1 unresolved/);
  for (const qualifications of [null, 'note', [42], [''], Array(21).fill('note'), ['a'.repeat(4001)]]) {
    assert.throws(() => validateProposal(JSON.stringify({...raw, qualifications}), [], config), /invalid proposal shape/);
  }
  assert.equal(validateProposal(JSON.stringify({findings: [], edits: [], unresolved: []}), [], config).qualifications, undefined);
});
