import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict, resolveOutcome } from '../src/outcome.ts';

const verdictOutcome = (message, failOn = 'blocking') =>
  resolveOutcome({ kind: 'verdict', verdict: parseVerdict(message), failOn });

test('a VERDICT: block review still fails the check', () => {
  const outcome = verdictOutcome('Findings\nVERDICT: block');
  assert.deepEqual(outcome, {
    state: 'failure',
    description: 'Blocking issues found',
    failJob: false,
  });
});

test('an untagged [BLOCKING] finding still fails the check', () => {
  assert.equal(verdictOutcome('[BLOCKING] unsafe cast').state, 'failure');
});

test('approve and comment verdicts pass under fail_on=blocking', () => {
  assert.equal(verdictOutcome('VERDICT: approve').state, 'success');
  assert.equal(verdictOutcome('VERDICT: comment').state, 'success');
});

test('fail_on=any and fail_on=never keep their verdict semantics', () => {
  assert.equal(verdictOutcome('VERDICT: comment', 'any').state, 'failure');
  assert.equal(verdictOutcome('VERDICT: approve', 'any').state, 'success');
  assert.equal(verdictOutcome('VERDICT: block', 'never').state, 'success');
});

test('review timeout passes with a clear non-blocking message', () => {
  const outcome = resolveOutcome({ kind: 'timeout', minutes: 60 });
  assert.equal(outcome.state, 'success');
  assert.equal(outcome.failJob, false);
  assert.match(outcome.description, /not blocking/i);
  assert.match(outcome.description, /60 minutes/);
});

test('infrastructure errors pass without failing the job', () => {
  const errors = [
    'Jules returned HTTP 429: quota exhausted for this project',
    'RESOURCE_EXHAUSTED: Quota exceeded for quota metric',
    'Jules review session 123 failed. Inspect https://jules.google.com/session/123.',
    'Session did not become ready within timeout.',
    'Jules session.info() failed: 503 Service Unavailable',
    'fetch failed: ECONNRESET',
    'GitHub returned no diff text (PR may be too large or comparison refused).',
  ];
  for (const message of errors) {
    const outcome = resolveOutcome({ kind: 'failure', error: new Error(message) });
    assert.equal(outcome.state, 'success', message);
    assert.equal(outcome.failJob, false, message);
    assert.match(outcome.description, /not blocking/i, message);
    assert.ok(outcome.description.length <= 140, message);
  }
});

test('credential and permission errors still fail loudly', () => {
  const errors = [
    'Jules API rejected request (401 Unauthorized). Check JULES_API_KEY is valid.',
    'createCommitStatus failed with 403. The github_token likely lacks statuses:write.',
    'Resource not accessible by integration',
  ];
  for (const message of errors) {
    const outcome = resolveOutcome({ kind: 'failure', error: new Error(message) });
    assert.equal(outcome.state, 'error', message);
    assert.equal(outcome.failJob, true, message);
  }
});

test('non-Error throwables are classified by their text', () => {
  assert.equal(resolveOutcome({ kind: 'failure', error: 'socket hang up' }).failJob, false);
});
