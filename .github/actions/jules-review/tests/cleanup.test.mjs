import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFinalReview, publishThenDelete } from '../src/cleanup.ts';

test('progress and unfinished sessions never qualify as finished reviews', () => {
  assert.equal(isFinalReview('inProgress', 'VERDICT: approve'), false);
  assert.equal(isFinalReview('completed', 'Still reviewing'), false);
  assert.equal(isFinalReview('failed', 'VERDICT: block'), false);
  for (const verdict of ['approve', 'comment', 'block']) {
    assert.equal(isFinalReview('completed', `Findings\nVERDICT: ${verdict}`), true);
  }
});

test('publishes first, then deletes only the exact session with authentication', async () => {
  const calls = [];
  await publishThenDelete(
    '123',
    'test-key',
    async () => calls.push('published'),
    async (url, options) => {
      assert.deepEqual(calls, ['published']);
      assert.equal(url, 'https://jules.googleapis.com/v1alpha/sessions/123');
      assert.equal(options.method, 'DELETE');
      assert.equal(options.headers['x-goog-api-key'], 'test-key');
      assert.equal(options.redirect, 'error');
      calls.push('deleted');
      return new Response(null, { status: 200 });
    },
    assert.fail,
  );
  assert.deepEqual(calls, ['published', 'deleted']);
});

test('publication failure retains the session', async () => {
  await assert.rejects(
    publishThenDelete(
      '123',
      'key',
      async () => {
        throw new Error('GitHub failed');
      },
      async () => {
        assert.fail('Must not delete');
      },
      assert.fail,
    ),
    /GitHub failed/,
  );
});

test('404 is an idempotent cleanup success', async () => {
  await publishThenDelete(
    '123',
    'key',
    async () => {},
    async () => new Response(null, { status: 404 }),
    assert.fail,
  );
});

test('cleanup failure reports the problem without rewriting the saved review', async () => {
  let published = 0;
  let requested = 0;
  const errors = [];
  await publishThenDelete(
    '123',
    'secret',
    async () => published++,
    async () => {
      requested++;
      return new Response('secret upstream body', { status: 403 });
    },
    (message) => errors.push(message),
  );
  assert.equal(published, 1);
  assert.equal(requested, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Review saved/);
  assert.match(errors[0], /HTTP 403; 1 attempt/);
  assert.doesNotMatch(errors[0], /secret/);
});

test('transient responses retry the exact published session with a fresh timeout', async () => {
  let published = 0;
  const signals = [];
  const statuses = [503, 429, 200];
  await publishThenDelete(
    '123',
    'key',
    async () => published++,
    async (url, options) => {
      assert.equal(published, 1);
      assert.equal(url, 'https://jules.googleapis.com/v1alpha/sessions/123');
      assert.equal(options.headers['x-goog-api-key'], 'key');
      assert.equal(options.method, 'DELETE');
      assert.equal(options.redirect, 'error');
      assert.equal(options.signal.aborted, false);
      assert.ok(!signals.includes(options.signal));
      signals.push(options.signal);
      return new Response(null, { status: statuses[signals.length - 1] });
    },
    assert.fail,
  );
  assert.equal(signals.length, 3);
});

test('a retry returning 404 completes cleanup without republishing', async () => {
  let published = 0;
  let attempts = 0;
  await publishThenDelete(
    '123',
    'key',
    async () => published++,
    async () => new Response(null, { status: ++attempts === 1 ? 408 : 404 }),
    assert.fail,
  );
  assert.equal(published, 1);
  assert.equal(attempts, 2);
});

for (const failure of ['http', 'timeout', 'network']) {
  test(`${failure} failures stop after three attempts and report only a safe category`, async () => {
    let published = 0;
    let attempts = 0;
    const errors = [];
    await publishThenDelete(
      '123',
      'secret',
      async () => published++,
      async () => {
        attempts++;
        if (failure === 'http') return new Response('secret upstream body', { status: 503 });
        if (failure === 'timeout') throw new DOMException('secret timeout', 'TimeoutError');
        throw new TypeError('secret network error');
      },
      (message) => errors.push(message),
    );
    assert.equal(published, 1);
    assert.equal(attempts, 3);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Review saved/);
    assert.match(errors[0], /3 attempts/);
    assert.match(
      errors[0],
      failure === 'http'
        ? /HTTP 503/
        : failure === 'timeout'
          ? /request timed out/
          : /network request failed/,
    );
    assert.doesNotMatch(errors[0], /secret/);
  });
}

test('invalid session IDs cannot change the API path', async () => {
  const errors = [];
  await publishThenDelete(
    '../other',
    'key',
    async () => {},
    async () => assert.fail('Must not request'),
    (message) => errors.push(message),
  );
  assert.equal(errors.length, 1);
});
