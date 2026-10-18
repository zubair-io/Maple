import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAuthFailure, parseVerdict, resolveOutcome, settleFailure } from '../src/outcome.ts';

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

test('authentication is detected from status codes on the error object', () => {
  const withStatus = (message, extra) => Object.assign(new Error(message), extra);
  const errors = [
    withStatus('Request failed', { status: 401 }),
    withStatus('Request failed', { status: '403' }),
    withStatus('Request failed', { response: { status: 403 } }),
  ];
  for (const error of errors) {
    assert.equal(isAuthFailure(error), true);
    const outcome = resolveOutcome({ kind: 'failure', error });
    assert.equal(outcome.failJob, true);
    assert.equal(outcome.state, 'error');
  }
  for (const status of [429, 500, 503]) {
    const error = Object.assign(new Error('Request failed'), { status });
    assert.equal(isAuthFailure(error), false, String(status));
  }
});

test('authentication is detected from provider message wording', () => {
  for (const message of [
    'Bad credentials',
    'UNAUTHENTICATED: Request had invalid authentication credentials',
    'API key not valid. Please pass a valid API key.',
    'Unauthorized',
    'Jules API rejected request (upstream). Check JULES_API_KEY is valid.',
  ]) {
    assert.equal(
      resolveOutcome({ kind: 'failure', error: new Error(message) }).failJob,
      true,
      message,
    );
  }
});

const blocked = () => resolveOutcome({ kind: 'verdict', verdict: 'block', failOn: 'blocking' });

test('a failure before any verdict writes the infrastructure skip status', async () => {
  const written = [];
  const outcome = await settleFailure(new Error('503 upstream'), undefined, async (o) => {
    written.push(o);
  });
  assert.equal(outcome.state, 'success');
  assert.deepEqual(written, [outcome]);
});

test('a transient status failure after a block verdict retries the real verdict, never a pass', async () => {
  const written = [];
  let calls = 0;
  const outcome = await settleFailure(new Error('502 Bad Gateway'), blocked(), async (o) => {
    calls++;
    if (calls < 3) throw new Error('502');
    written.push(o);
  });
  assert.equal(calls, 3);
  assert.equal(outcome.state, 'failure');
  assert.deepEqual(
    written.map((o) => o.state),
    ['failure'],
  );
});

test('if the verdict status can never be written the job fails loudly without a passing status', async () => {
  const written = [];
  const outcome = await settleFailure(new Error('502'), blocked(), async (o) => {
    written.push(o);
    throw new Error('still down');
  });
  assert.equal(outcome.failJob, true);
  assert.notEqual(outcome.state, 'success');
  assert.ok(written.every((o) => o.state === 'failure'));
  assert.equal(written.length, 3);
});
