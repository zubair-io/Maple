/**
 * POST /api/enrichment/test-describe — the describe-provider connection check
 * on the settings page. The Ollama health probe is faked by spying on
 * `globalThis.fetch`; nothing leaves the process.
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { Elysia } from 'elysia';
import { signAccessToken } from '../src/auth/tokens.ts';
import { newObjectIdHex } from '../src/db/object-id.ts';
import { enrichmentRoutes } from '../src/routes/enrichment.ts';

process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);

const ownerJwt = await signAccessToken(
  { file_access: true, sub: newObjectIdHex(), email: 'o@m.c', role: 'owner' },
  'x'.repeat(32),
);

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function stubFetch(respond: () => Promise<Response>): void {
  spies.push(spyOn(globalThis, 'fetch').mockImplementation(respond as unknown as typeof fetch));
}

async function testDescribe(body: Record<string, unknown>): Promise<Response> {
  return new Elysia().use(enrichmentRoutes).handle(
    new Request('http://localhost/api/enrichment/test-describe', {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerJwt}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/enrichment/test-describe', () => {
  it('rejects an unknown provider with 400', async () => {
    const response = await testDescribe({ provider: 'llamafile' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false });
  });

  it('reports a healthy Ollama with the requested model', async () => {
    stubFetch(async () => new Response(JSON.stringify({ models: [] }), { status: 200 }));
    const response = await testDescribe({
      provider: 'ollama',
      url: 'http://ollama.test:11434',
      model: 'qwen2.5vl',
    });
    expect(await response.json()).toEqual({
      ok: true,
      info: { provider: 'ollama', model: 'qwen2.5vl' },
    });
  });

  it('carries the upstream status when Ollama answers with an error', async () => {
    stubFetch(async () => new Response('down', { status: 503 }));
    const response = await testDescribe({ provider: 'ollama', url: 'http://ollama.test:11434' });
    expect(await response.json()).toMatchObject({ ok: false, status: 503 });
  });

  it('reports a transport failure without a status', async () => {
    stubFetch(async () => {
      throw new Error('ECONNREFUSED');
    });
    const response = await testDescribe({ provider: 'ollama', url: 'http://ollama.test:11434' });
    expect(await response.json()).toMatchObject({ ok: false, status: null });
  });
});
