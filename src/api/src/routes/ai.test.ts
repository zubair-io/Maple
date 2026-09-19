import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Elysia } from 'elysia';
import { aiRoutes } from './ai.ts';
import { enrichmentRoutes } from './enrichment.ts';
import { computeWorkersStatus } from '../workers/routes-status.ts';
import { withTestEnv } from '../test-support/env.test-helpers.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { signAccessToken } from '../auth/tokens.ts';
import {
  loadEnrichmentConfig,
  saveEnrichmentConfig,
} from '../enrichment/enrichment-config.repo.ts';

const JWT_SECRET = 'x'.repeat(32);
withTestEnv('MAPLE_JWT_SECRET', JWT_SECRET);

let live: LiveTestDatabase;
let ownerToken = '';
let memberToken = '';

const ENV_KEYS = [
  'MAPLE_OPENAI_API_KEY',
  'MAPLE_ANTHROPIC_API_KEY',
  'MAPLE_GEMINI_API_KEY',
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  ownerToken = await signAccessToken(
    { sub: 'owner-1', email: 'owner@example.com', role: 'owner', file_access: true },
    JWT_SECRET,
  );
  memberToken = await signAccessToken(
    { sub: 'member-1', email: 'member@example.com', role: 'member', file_access: true },
    JWT_SECRET,
  );
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

beforeEach(async () => {
  // A fresh database per test, installed as the process-wide handle: the
  // route reads the enrichment settings document and the worker_config rows
  // through it with no override.
  live = await createLiveTestDatabase();
});

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  live.close();
});

function app() {
  return new Elysia().use(aiRoutes);
}

function req(path: string, options: RequestInit = {}, token?: string): Promise<Response> {
  const headers = new Headers(options.headers);
  if (token) {
    headers.set('authorization', `Bearer ${token}`);
  }
  return app().handle(
    new Request(`http://localhost${path}`, {
      ...options,
      headers,
    }),
  );
}

describe('/api/ai routes', () => {
  describe('authorization guards', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const getRes = await req('/api/ai/config');
      expect(getRes.status).toBe(401);

      const putRes = await req('/api/ai/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(putRes.status).toBe(401);

      const modelsRes = await req('/api/ai/models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'ollama' }),
      });
      expect(modelsRes.status).toBe(401);

      const testRes = await req('/api/ai/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'ollama' }),
      });
      expect(testRes.status).toBe(401);
    });

    it('rejects non-owner users from sensitive mutation and probe endpoints with 403', async () => {
      const putRes = await req(
        '/api/ai/config',
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        },
        memberToken,
      );
      expect(putRes.status).toBe(403);

      const modelsRes = await req(
        '/api/ai/models',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider: 'ollama' }),
        },
        memberToken,
      );
      expect(modelsRes.status).toBe(403);

      const testRes = await req(
        '/api/ai/test',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider: 'ollama' }),
        },
        memberToken,
      );
      expect(testRes.status).toBe(403);
    });

    it('allows members to read /api/ai/config', async () => {
      const res = await req('/api/ai/config', {}, memberToken);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { providers: unknown; workers: unknown };
      expect(data.providers).toBeDefined();
      expect(data.workers).toBeDefined();
    });
  });

  describe('GET & PUT /api/ai/config', () => {
    it('persists API keys without changing the process environment', async () => {
      const putRes = await req(
        '/api/ai/config',
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            providers: {
              openai: { api_key: 'sk-test-saved-key' },
            },
          }),
        },
        ownerToken,
      );
      expect(putRes.status).toBe(200);
      expect(process.env.MAPLE_OPENAI_API_KEY).toBeUndefined();

      const fromDb = await loadEnrichmentConfig();
      expect(fromDb?.openai_api_key).toBe('sk-test-saved-key');

      // Verify that after simulated restart (env cleared), key still resolves from DB
      delete process.env.MAPLE_OPENAI_API_KEY;
      const getRes = await req('/api/ai/config', {}, ownerToken);
      expect(getRes.status).toBe(200);
      const data = (await getRes.json()) as { providers: { openai: { has_key: boolean } } };
      expect(data.providers.openai.has_key).toBe(true);
    });

    it('updates describe_servers[0].url when updating Ollama URL and server list exists', async () => {
      await saveEnrichmentConfig({
        describe_servers: [
          { url: 'http://old-ollama:11434', concurrency: 2 },
          { url: 'http://worker-2:11434', concurrency: 2 },
        ],
      });

      const putRes = await req(
        '/api/ai/config',
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            providers: {
              ollama: { url: 'http://new-ollama:11434' },
            },
          }),
        },
        ownerToken,
      );
      expect(putRes.status).toBe(200);

      const fromDb = await loadEnrichmentConfig();
      expect(fromDb?.describe_provider_url).toBe('http://new-ollama:11434');
      expect(fromDb?.describe_servers?.[0]?.url).toBe('http://new-ollama:11434');
      expect(fromDb?.describe_servers?.[1]?.url).toBe('http://worker-2:11434');

      const getRes = await req('/api/ai/config', {}, ownerToken);
      const data = (await getRes.json()) as { providers: { ollama: { url: string } } };
      expect(data.providers.ollama.url).toBe('http://new-ollama:11434');
    });

    it('clears a saved key even when a deployment key exists', async () => {
      process.env.MAPLE_OPENAI_API_KEY = 'sk-existing-key';

      const clearRes = await req(
        '/api/ai/config',
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            providers: {
              openai: { api_key: '' },
            },
          }),
        },
        ownerToken,
      );
      expect(clearRes.status).toBe(200);
      expect(process.env.MAPLE_OPENAI_API_KEY).toBe('sk-existing-key');

      const getRes = await req('/api/ai/config', {}, ownerToken);
      const data = (await getRes.json()) as { providers: { openai: { has_key: boolean } } };
      expect(data.providers.openai.has_key).toBe(false);
    });

    it('updates worker assignments', async () => {
      const putRes = await req(
        '/api/ai/config',
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            workers: {
              describe: { provider: 'openai', model: 'gpt-4o' },
            },
          }),
        },
        ownerToken,
      );
      expect(putRes.status).toBe(200);

      const getRes = await req('/api/ai/config', {}, ownerToken);
      const data = (await getRes.json()) as {
        workers: { describe: { provider: string; model: string } };
      };
      expect(data.workers.describe.provider).toBe('openai');
      expect(data.workers.describe.model).toBe('gpt-4o');
      const status = await computeWorkersStatus();
      expect(status.stages.find((stage) => stage.name === 'describe')?.config?.ai_provider).toBe(
        'openai',
      );
      expect(status.stages.find((stage) => stage.name === 'describe')?.config?.ai_model).toBe(
        'gpt-4o',
      );
    });

    it('rejects invalid worker names with 400', async () => {
      const putRes = await req(
        '/api/ai/config',
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            workers: {
              'invalid-worker-name': { provider: 'openai', model: 'gpt-4o' },
            },
          }),
        },
        ownerToken,
      );
      expect(putRes.status).toBe(400);
      const data = (await putRes.json()) as { error: string };
      expect(data.error).toContain('Invalid worker assignment: invalid-worker-name');
    });
  });

  it('never exposes provider keys through the member enrichment response', async () => {
    await saveEnrichmentConfig({ openai_api_key: 'test-db-secret' });
    process.env.MAPLE_ANTHROPIC_API_KEY = 'test-env-secret';
    const res = await new Elysia().use(enrichmentRoutes).handle(
      new Request('http://localhost/api/enrichment/config', {
        headers: { authorization: `Bearer ${memberToken}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('test-db-secret');
    expect(body).not.toContain('test-env-secret');
    const config = JSON.parse(body);
    expect(config).not.toHaveProperty('openai_api_key');
    expect(config).not.toHaveProperty('anthropic_api_key');
    expect(config).not.toHaveProperty('gemini_api_key');
  });

  it('rejects a mixed valid/invalid assignment request before any settings change', async () => {
    const res = await req(
      '/api/ai/config',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          providers: { openai: { api_key: 'must-not-save' } },
          workers: {
            describe: { provider: 'openai', model: 'gpt-4o' },
            unknown: { provider: 'ollama', model: 'example' },
          },
        }),
      },
      ownerToken,
    );
    expect(res.status).toBe(400);
    expect((await loadEnrichmentConfig())?.openai_api_key).toBeUndefined();
    expect(
      live.db.query(`SELECT name FROM worker_config WHERE name = ?`).get('describe'),
    ).toBeNull();
  });

  it('rejects invalid Ollama servers without saving credentials', async () => {
    const res = await req(
      '/api/ai/config',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          providers: {
            openai: { api_key: 'must-not-save' },
            ollama: { servers: [{ url: 'http://ollama:11434', concurrency: -1 }] },
          },
        }),
      },
      ownerToken,
    );
    expect(res.status).toBe(400);
    expect((await loadEnrichmentConfig())?.openai_api_key).toBeUndefined();
  });

  it('uses a saved key for discovery after restart and honors an explicit clear', async () => {
    await saveEnrichmentConfig({ openai_api_key: 'test-persisted-key' });
    const fakeFetch = Object.assign(
      async (_input: URL | RequestInfo, init?: RequestInit) => {
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-persisted-key');
        return Response.json({ data: [{ id: 'gpt-4o' }] });
      },
      { preconnect: globalThis.fetch.preconnect },
    );
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(fakeFetch);
    try {
      const options = { method: 'POST', headers: { 'content-type': 'application/json' } };
      const res = await req(
        '/api/ai/models',
        {
          ...options,
          body: JSON.stringify({ provider: 'openai' }),
        },
        ownerToken,
      );
      expect((await res.json()).source).toBe('live');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const cleared = await req(
        '/api/ai/test',
        {
          ...options,
          body: JSON.stringify({ provider: 'openai', api_key: null }),
        },
        ownerToken,
      );
      expect(cleared.status).toBe(400);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  describe('POST /api/ai/models', () => {
    it('returns model list for owner', async () => {
      const res = await req(
        '/api/ai/models',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider: 'openai', api_key: 'sk-invalid-test' }),
        },
        ownerToken,
      );
      expect(res.status).toBe(200);
      const data = (await res.json()) as { models: string[]; source: string };
      expect(data.models.length).toBeGreaterThan(0);
    });

    it('returns 400 for unknown provider', async () => {
      const res = await req(
        '/api/ai/models',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider: 'unknown-provider' }),
        },
        ownerToken,
      );
      expect(res.status).toBe(400);
    });

    it('falls back to environment API key when api_key is omitted in payload', async () => {
      process.env.MAPLE_OPENAI_API_KEY = 'sk-env-test-key';
      const res = await req(
        '/api/ai/models',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider: 'openai' }),
        },
        ownerToken,
      );
      expect(res.status).toBe(200);
      const data = (await res.json()) as { models: string[]; source: string };
      expect(data.models.length).toBeGreaterThan(0);
      delete process.env.MAPLE_OPENAI_API_KEY;
    });
  });

  describe('POST /api/ai/test', () => {
    it('tests connection for owner and fails cleanly on bad config', async () => {
      const res = await req(
        '/api/ai/test',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider: 'ollama', url: 'http://127.0.0.1:59999' }),
        },
        ownerToken,
      );
      expect(res.status).toBe(400);
      const data = (await res.json()) as { ok: boolean; error: string };
      expect(data.ok).toBe(false);
      expect(data.error).toBeDefined();
    });

    it('returns 400 for invalid provider', async () => {
      const res = await req(
        '/api/ai/test',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider: 'invalid-provider' }),
        },
        ownerToken,
      );
      expect(res.status).toBe(400);
    });
  });
});
