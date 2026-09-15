import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { type Db } from 'mongodb';
import { aiRoutes } from './ai.ts';
import { closeDb, getDb, isDbConnected } from '../db/client.ts';
import { withTestDb, withTestEnv } from '../db/test-db.test-helpers.ts';
import { signAccessToken } from '../auth/tokens.ts';

const JWT_SECRET = 'x'.repeat(32);
withTestEnv('MAPLE_JWT_SECRET', JWT_SECRET);
withTestDb(`maple_test_ai_routes_${process.pid}`);

let db: Db | null = null;
let ownerToken = '';
let memberToken = '';

const ENV_KEYS = [
  'MAPLE_OPENAI_API_KEY',
  'MAPLE_ANTHROPIC_API_KEY',
  'MAPLE_GEMINI_API_KEY',
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  await closeDb();
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

afterAll(async () => {
  if (db) await db.dropDatabase();
  await closeDb();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

beforeEach(async () => {
  try {
    db = await getDb();
    if (isDbConnected()) {
      await db.collection('app_settings').deleteMany({ _id: 'enrichment' as never });
      await db.collection('worker_config').deleteMany({});
    }
  } catch {
    // DB offline fallback
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

function app(): Elysia {
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
    it('sets and updates API keys in process.env and enrichment config', async () => {
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
      expect(process.env.MAPLE_OPENAI_API_KEY).toBe('sk-test-saved-key');

      const getRes = await req('/api/ai/config', {}, ownerToken);
      expect(getRes.status).toBe(200);
      const data = (await getRes.json()) as { providers: { openai: { has_key: boolean } } };
      expect(data.providers.openai.has_key).toBe(true);
    });

    it('clears API key and removes env var when passed empty string', async () => {
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
      expect(process.env.MAPLE_OPENAI_API_KEY).toBeUndefined();

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
    });
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
