/**
 * ApnsSender tests — network calls are faked; a real ES256 keypair is
 * generated once per suite so `importPKCS8` has valid PKCS#8 to parse
 * (there is no meaningful way to fake JWT signing itself — the point of
 * the test is that the sender builds a well-formed request, not that jose
 * works).
 */

import { describe, expect, it } from 'bun:test';
import { exportPKCS8, generateKeyPair } from 'jose';
import { ApnsSender, APNS_FILE_PROVIDER_TOPIC } from './apns-sender.ts';
import type { ApnsEnvCredentials } from './apns-config.repo.ts';

async function testCreds(): Promise<ApnsEnvCredentials> {
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  return {
    keyId: 'KEYID12345',
    teamId: 'TEAMID6789',
    privateKeyPem: await exportPKCS8(privateKey),
  };
}

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function fakeFetch(
  status: number,
  body: string,
): { fetch: typeof fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

describe('ApnsSender.sendFileProviderWake', () => {
  it('POSTs to the production host with the file-provider topic and push type', async () => {
    const { fetch: f, calls } = fakeFetch(200, '');
    const sender = new ApnsSender(await testCreds(), f);
    const result = await sender.sendFileProviderWake('deadbeef', 'production');
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.push.apple.com/3/device/deadbeef');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['apns-topic']).toBe(APNS_FILE_PROVIDER_TOPIC);
    expect(headers['apns-push-type']).toBe('fileprovider');
    expect(headers['authorization']).toMatch(/^bearer /);
    expect(calls[0]!.init.body).toBe('{}');
  });

  it('POSTs to the sandbox host for a sandbox-registered device', async () => {
    const { fetch: f, calls } = fakeFetch(200, '');
    const sender = new ApnsSender(await testCreds(), f);
    await sender.sendFileProviderWake('deadbeef', 'sandbox');
    expect(calls[0]!.url).toBe('https://api.sandbox.push.apple.com/3/device/deadbeef');
  });

  it('reuses the provider JWT across sends within the reuse window', async () => {
    const { fetch: f, calls } = fakeFetch(200, '');
    const sender = new ApnsSender(await testCreds(), f);
    await sender.sendFileProviderWake('a', 'production');
    await sender.sendFileProviderWake('b', 'production');
    const t1 = (calls[0]!.init.headers as Record<string, string>)['authorization'];
    const t2 = (calls[1]!.init.headers as Record<string, string>)['authorization'];
    expect(t1).toBe(t2);
  });

  it('reuses one provider JWT across CONCURRENT sends (a burst fans out per device via Promise.allSettled)', async () => {
    // Regression test (Jules review, PR #3214): caching only the resolved
    // JWT left a window open where N concurrent callers all observed
    // `cachedToken: null` and each signed their own token — exactly what a
    // multi-device push fan-out does. Apple rejects more than one
    // provider-token generation per ~20 minutes, so this must produce
    // exactly one signature for the whole burst.
    const { fetch: f, calls } = fakeFetch(200, '');
    const sender = new ApnsSender(await testCreds(), f);
    await Promise.all([
      sender.sendFileProviderWake('a', 'production'),
      sender.sendFileProviderWake('b', 'production'),
      sender.sendFileProviderWake('c', 'production'),
    ]);
    const tokens = calls.map((c) => (c.init.headers as Record<string, string>)['authorization']);
    expect(new Set(tokens).size).toBe(1);
  });

  it('flags BadDeviceToken as prunable', async () => {
    const { fetch: f } = fakeFetch(400, JSON.stringify({ reason: 'BadDeviceToken' }));
    const sender = new ApnsSender(await testCreds(), f);
    const result = await sender.sendFileProviderWake('stale', 'production');
    expect(result).toEqual({
      ok: false,
      status: 400,
      reason: 'BadDeviceToken',
      shouldPrune: true,
    });
  });

  it('flags Unregistered (410) as prunable', async () => {
    const { fetch: f } = fakeFetch(410, JSON.stringify({ reason: 'Unregistered' }));
    const sender = new ApnsSender(await testCreds(), f);
    const result = await sender.sendFileProviderWake('gone', 'production');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.shouldPrune).toBe(true);
  });

  it('does not flag a transient rejection (e.g. TooManyRequests) as prunable', async () => {
    const { fetch: f } = fakeFetch(429, JSON.stringify({ reason: 'TooManyRequests' }));
    const sender = new ApnsSender(await testCreds(), f);
    const result = await sender.sendFileProviderWake('busy', 'production');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.shouldPrune).toBe(false);
  });
});
