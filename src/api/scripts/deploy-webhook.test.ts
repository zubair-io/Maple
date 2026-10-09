import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { handleDeployWebhook, signatureMatches } from './deploy-webhook.ts';

const SECRET = 'test-secret';

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function delivery(event: string, payload: unknown, signature?: string, method = 'POST'): Request {
  const body = JSON.stringify(payload);
  return new Request('http://localhost/github', {
    method,
    headers: { 'x-github-event': event, 'x-hub-signature-256': signature ?? sign(body) },
    body: method === 'POST' ? body : undefined,
  });
}

async function run(request: Request): Promise<{ status: number; triggered: number }> {
  const calls: number[] = [];
  const response = await handleDeployWebhook(request, SECRET, async () => {
    calls.push(1);
  });
  return { status: response.status, triggered: calls.length };
}

describe('signatureMatches', () => {
  test('accepts the HMAC GitHub computes', () => {
    expect(signatureMatches(SECRET, '{"a":1}', sign('{"a":1}'))).toBe(true);
  });

  test('rejects a missing, malformed, wrong-secret, or wrong-length signature', () => {
    expect(signatureMatches(SECRET, 'x', null)).toBe(false);
    expect(signatureMatches(SECRET, 'x', 'sha1=abc')).toBe(false);
    expect(signatureMatches(SECRET, 'x', sign('x', 'other-secret'))).toBe(false);
    expect(signatureMatches(SECRET, 'x', 'sha256=00')).toBe(false);
  });
});

describe('handleDeployWebhook', () => {
  test('a signed push to main triggers one deploy', async () => {
    expect(await run(delivery('push', { ref: 'refs/heads/main' }))).toEqual({
      status: 202,
      triggered: 1,
    });
  });

  test('a push to another branch or a tag does not deploy', async () => {
    expect(await run(delivery('push', { ref: 'refs/heads/feature/x' }))).toEqual({
      status: 202,
      triggered: 0,
    });
    expect(await run(delivery('push', { ref: 'refs/tags/v1.0.0' }))).toEqual({
      status: 202,
      triggered: 0,
    });
  });

  test('a bad signature is refused before the payload is trusted', async () => {
    expect(await run(delivery('push', { ref: 'refs/heads/main' }, sign('{}', 'wrong')))).toEqual({
      status: 401,
      triggered: 0,
    });
  });

  test('the ping GitHub sends on webhook creation is answered without deploying', async () => {
    expect(await run(delivery('ping', { zen: 'hi' }))).toEqual({ status: 200, triggered: 0 });
  });

  test('other events and non-POST requests do not deploy', async () => {
    expect(await run(delivery('pull_request', { ref: 'refs/heads/main' }))).toEqual({
      status: 202,
      triggered: 0,
    });
    expect(await run(delivery('push', {}, undefined, 'GET'))).toEqual({
      status: 405,
      triggered: 0,
    });
  });

  test('a signed but non-JSON body does not deploy', async () => {
    const request = new Request('http://localhost/github', {
      method: 'POST',
      headers: { 'x-github-event': 'push', 'x-hub-signature-256': sign('not json') },
      body: 'not json',
    });
    expect(await run(request)).toEqual({ status: 202, triggered: 0 });
  });
});
