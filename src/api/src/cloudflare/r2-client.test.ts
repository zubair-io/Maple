/**
 * `aws4fetch` signs requests and dispatches them through the global
 * `fetch`, so these tests stub `globalThis.fetch` rather than hitting a
 * real R2 bucket — no network calls, no Cloudflare account needed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { deleteThumbFromR2, testR2Credentials, uploadThumbToR2 } from './r2-client.ts';

const CONFIG = {
  account_id: 'acct123',
  bucket: 'maple-thumbs',
  access_key_id: 'AKIAEXAMPLE',
  secret_access_key: 'secretexample',
};

let originalFetch: typeof fetch;
let calls: Array<{ method: string; url: string }>;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(status: number, body = ''): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    // aws4fetch signs the request and hands `fetch` a `Request` object
    // directly (method lives on the Request, not a separate `init`).
    const method = input instanceof Request ? input.method : (init?.method ?? 'GET');
    const url = input instanceof Request ? input.url : input.toString();
    calls.push({ method, url });
    return new Response(body, { status });
  }) as typeof fetch;
}

describe('uploadThumbToR2', () => {
  it('PUTs to the account/bucket/key S3-compatible endpoint', async () => {
    stubFetch(200);
    await uploadThumbToR2(CONFIG, 'thumbs/main/a.jpg', new Uint8Array([1, 2, 3]));
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].url).toBe(
      'https://acct123.r2.cloudflarestorage.com/maple-thumbs/thumbs/main/a.jpg',
    );
  });

  it('throws with the response body on a non-2xx response', async () => {
    stubFetch(403, 'AccessDenied');
    await expect(uploadThumbToR2(CONFIG, 'thumbs/main/a.jpg', new Uint8Array([1]))).rejects.toThrow(
      /403/,
    );
  });
});

describe('deleteThumbFromR2', () => {
  it('DELETEs the account/bucket/key S3-compatible endpoint', async () => {
    stubFetch(200);
    await deleteThumbFromR2(CONFIG, 'thumbs/main/a.jpg');
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toBe(
      'https://acct123.r2.cloudflarestorage.com/maple-thumbs/thumbs/main/a.jpg',
    );
  });

  it('treats a 404 (already absent) as success, not an error', async () => {
    stubFetch(404, 'NoSuchKey');
    await expect(deleteThumbFromR2(CONFIG, 'thumbs/main/a.jpg')).resolves.toBeUndefined();
  });

  it('throws with the response body on a non-2xx, non-404 response', async () => {
    stubFetch(403, 'AccessDenied');
    await expect(deleteThumbFromR2(CONFIG, 'thumbs/main/a.jpg')).rejects.toThrow(/403/);
  });
});

describe('testR2Credentials', () => {
  it('PUTs then DELETEs a probe object under a scoped prefix', async () => {
    stubFetch(200);
    await testR2Credentials(CONFIG);
    expect(calls.map((c) => c.method)).toEqual(['PUT', 'DELETE']);
    expect(calls[0].url).toContain('_maple_credential_probe/');
    expect(calls[1].url).toBe(calls[0].url);
  });

  it('throws when the probe PUT fails, without attempting a DELETE', async () => {
    stubFetch(401, 'InvalidAccessKeyId');
    await expect(testR2Credentials(CONFIG)).rejects.toThrow(/401/);
    expect(calls).toHaveLength(1);
  });
});
