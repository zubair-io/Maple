import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyPublishedSession, publishThenDelete } from '../src/cleanup.ts';

const savedReview = (id, verdict = 'approve', login = 'github-actions[bot]') => ({
  user: { login },
  body: `<!-- jules-pr-reviewer -->\n## 🤖 Jules Review\n\nVERDICT: ${verdict}\n\n---\n_Session: \`${id}\`_`,
});

test('recovery verifies the exact published session before authenticated deletion', async () => {
  const calls = [];
  const request = async (url, options) => {
    calls.push(url);
    if (url.startsWith('https://api.github.com/')) {
      assert.equal(
        url,
        'https://api.github.com/repos/zubair-io/Maple/issues/3946/comments?per_page=100&page=1',
      );
      assert.equal(options.headers.authorization, 'Bearer github-key');
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json([savedReview('123')]);
    }
    assert.equal(calls.length, 2);
    assert.equal(url, 'https://jules.googleapis.com/v1alpha/sessions/123');
    assert.equal(options.method, 'DELETE');
    assert.equal(options.headers['x-goog-api-key'], 'jules-key');
    return new Response(null, { status: 404 });
  };
  await publishThenDelete(
    '123',
    'jules-key',
    () => verifyPublishedSession('zubair-io/Maple', '3946', '123', 'github-key', request),
    request,
    assert.fail,
  );
  assert.equal(calls.length, 2);
});

test('recovery rejects untrusted, unfinished, failed or different session comments', async () => {
  for (const comments of [
    [],
    [savedReview('456')],
    [savedReview('123', 'approve', 'zubair-io')],
    [savedReview('123', 'still reviewing')],
    [
      {
        user: { login: 'github-actions[bot]' },
        body: '<!-- jules-pr-reviewer -->\nJules is reviewing',
      },
    ],
    [
      {
        user: { login: 'github-actions[bot]' },
        body: '<!-- jules-pr-reviewer -->\nReview failed\nVERDICT: approve\n_Session: `123`_',
      },
    ],
  ]) {
    let requests = 0;
    const request = async (url) => {
      requests++;
      assert.ok(url.startsWith('https://api.github.com/'));
      return Response.json(comments);
    };
    await assert.rejects(
      publishThenDelete(
        '123',
        'jules-key',
        () => verifyPublishedSession('zubair-io/Maple', '3946', '123', 'github-key', request),
        request,
        assert.fail,
      ),
      /No completed review/,
    );
    assert.equal(requests, 1);
  }
});

test('recovery checks subsequent pages and accepts every completed verdict', async () => {
  for (const verdict of ['approve', 'comment', 'block']) {
    const urls = [];
    await verifyPublishedSession('zubair-io/Maple', '3946', '123', 'github-key', async (url) => {
      urls.push(url);
      return Response.json(
        urls.length === 1 ? Array(100).fill(savedReview('other')) : [savedReview('123', verdict)],
      );
    });
    assert.equal(urls.length, 2);
    assert.ok(urls[1].endsWith('page=2'));
  }
});

test('verification rejects invalid targets before requests and suppresses upstream bodies', async () => {
  for (const args of [
    ['bad/repo/extra', '3946', '123'],
    ['zubair-io/Maple', '1&x=2', '123'],
    ['zubair-io/Maple', '3946', '../123'],
  ]) {
    await assert.rejects(
      verifyPublishedSession(...args, 'key', assert.fail),
      /Invalid cleanup target/,
    );
  }
  await assert.rejects(
    verifyPublishedSession(
      'zubair-io/Maple',
      '3946',
      '123',
      'key',
      async () => new Response('private upstream text', { status: 403 }),
    ),
    { message: 'Review verification failed (HTTP 403)' },
  );
});
