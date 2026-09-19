import { enrichmentRoutes } from './enrichment.ts';
import { workerRoutes } from '../workers/routes.ts';
import { generatedSearchConfigRoutes } from '../workers/generated-search/routes.ts';
import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Elysia } from 'elysia';
import { aiRoutes } from './ai.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { withTestEnv } from '../test-support/env.test-helpers.ts';
import { signAccessToken } from '../auth/tokens.ts';
import {
  loadEnrichmentConfig,
  saveEnrichmentConfig,
} from '../enrichment/enrichment-config.repo.ts';
import { resolveEnrichmentConfig } from '../enrichment/enrichment-config.resolve.ts';
import { assignedAi } from '../enrichment/ai-connections.ts';
import { assignedAiPool } from '../enrichment/ai-assigned-pool.ts';
import { workerEnrichmentFingerprint } from '../workers/enrichment-config-refresh.ts';
import { toPublicConfig } from './enrichment-public-config.ts';

withTestEnv('MAPLE_JWT_SECRET', 'x'.repeat(32));

// Every route here reads and writes the `enrichment` settings row and the
// `worker_config` table through the process-wide SQLite handle, so the database
// is installed as that handle rather than handed in. A fresh one per test is
// also what replaces the two `deleteMany({})` calls the MongoDB version needed.
let live: LiveTestDatabase;
let owner: string;
let member: string;

beforeAll(async () => {
  owner = await signAccessToken(
    { sub: 'ai-owner', email: 'owner@example.com', role: 'owner', file_access: true },
    'x'.repeat(32),
  );
  member = await signAccessToken(
    { sub: 'ai-member', email: 'member@example.com', role: 'member', file_access: true },
    'x'.repeat(32),
  );
});

beforeEach(async () => {
  live = await createLiveTestDatabase();
  await saveEnrichmentConfig({
    describe_provider: 'ollama',
    describe_model: 'vision-model',
    describe_servers: [
      { url: 'http://gpu1:11434', concurrency: 2 },
      { url: 'http://gpu2:11434', concurrency: 1 },
    ],
  });
});

afterEach(() => {
  live.close();
});

const app = new Elysia()
  .use(aiRoutes)
  .use(enrichmentRoutes)
  .use(workerRoutes())
  .use(generatedSearchConfigRoutes);
function request(method = 'GET', body?: unknown, token = owner, path = '/api/ai/connections/') {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  );
}
async function config() {
  return (await request()).json();
}

describe('central AI connections', () => {
  it('restricts reading, saving and probing to owners', async () => {
    expect((await request('GET', undefined, member)).status).toBe(403);
    expect((await request('GET', undefined, '')).status).toBe(401);
    expect((await request('PUT', { connections: [], assignments: {} }, member)).status).toBe(403);
    const c = await config();
    expect(
      (
        await request(
          'POST',
          { connection: c.connections[0], models: true },
          member,
          '/api/ai/connections/probe',
        )
      ).status,
    ).toBe(403);
  });
  it('imports every legacy server and models without writing on GET', async () => {
    const c = await config();
    expect(c.connections).toHaveLength(2);
    expect(c.needs_save).toBe(true);
    expect(c.assignments.describe.connection_ids).toEqual(['ollama-1', 'ollama-2']);
    expect(c.assignments['generated-search'].model).toBe('vision-model');
    expect((await loadEnrichmentConfig())?.ai_connections).toBeUndefined();
  });
  it('saves independent selections used by vision pools, generated search and embeddings', async () => {
    const c = await config();
    c.assignments['generated-search'] = { connection_ids: ['ollama-2'], model: 'text-model' };
    c.assignments['semantic-search'] = { connection_ids: ['ollama-2'], model: 'embedding-model' };
    expect((await request('PUT', c)).status).toBe(200);
    const resolved = resolveEnrichmentConfig(await loadEnrichmentConfig());
    expect(assignedAiPool(resolved.ai_connections, 'describe')?.pool.capacity).toBe(3);
    expect(assignedAi(resolved.ai_connections, 'generated-search')?.primary.url).toBe(
      'http://gpu2:11434',
    );
    expect(resolved.meilisearch_embedder_url).toBe('http://gpu2:11434');
    expect(resolved.meilisearch_embedder_model).toBe('embedding-model');
    const oldFingerprint = workerEnrichmentFingerprint(resolved);
    c.assignments['video-describe'].model = 'new-video-model';
    await request('PUT', c);
    expect(
      workerEnrichmentFingerprint(resolveEnrichmentConfig(await loadEnrichmentConfig())),
    ).not.toBe(oldFingerprint);
  });
  it('redacts keys, preserves omitted keys by connection identity, and uses per-account keys', async () => {
    const c = await config();
    c.connections.push({
      id: 'cloud',
      name: 'Cloud',
      provider: 'openai',
      url: '',
      concurrency: 4,
      api_key: 'secret-test-value',
    });
    c.assignments.describe = {
      connection_ids: ['ollama-1', 'cloud'],
      model: 'vision-model',
      connection_models: { 'ollama-1': 'vision-model', cloud: 'cloud-model' },
    };
    const fetchSpy = spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'gpt-4o' }] }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'gpt-4o' }] }));
    const invalid = await request('PUT', c);
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error).toContain('not available');
    c.assignments.describe.connection_models.cloud = 'gpt-4o';
    const saved = await request('PUT', c);
    fetchSpy.mockRestore();
    expect(saved.status).toBe(200);
    expect(await saved.text()).not.toContain('secret-test-value');
    const reloaded = await config();
    expect(reloaded.connections.find((v: { id: string }) => v.id === 'cloud').has_key).toBe(true);
    await request('PUT', reloaded);
    const resolved = resolveEnrichmentConfig(await loadEnrichmentConfig());
    expect(
      assignedAi(resolved.ai_connections, 'describe')?.connections.find(
        (connection) => connection.id === 'cloud',
      )?.api_key,
    ).toBe('secret-test-value');
    expect(JSON.stringify(await toPublicConfig(resolved))).not.toContain('secret-test-value');
    const pool = assignedAiPool(resolved.ai_connections, 'describe')!.pool;
    expect(pool.capacity).toBe(6);
    const picks = [];
    for (let i = 0; i < 4; i++)
      picks.push(await pool.run(async (provider, server) => [provider.name, server.model]));
    expect(picks).toEqual([
      ['ollama', 'vision-model'],
      ['openai', 'gpt-4o'],
      ['ollama', 'vision-model'],
      ['openai', 'gpt-4o'],
    ]);
  });
  it('rejects deleted references and incompatible assignments before any write', async () => {
    const c = await config();
    const before = await loadEnrichmentConfig();
    c.connections.pop();
    expect((await request('PUT', c)).status).toBe(400);
    expect(await loadEnrichmentConfig()).toEqual(before);
    const d = await config();
    d.connections.push({
      id: 'cloud',
      name: 'Cloud',
      provider: 'openai',
      url: '',
      concurrency: 1,
      api_key: 'secret',
    });
    d.assignments['semantic-search'].connection_ids = ['cloud'];
    expect((await request('PUT', d)).status).toBe(400);
    expect(await loadEnrichmentConfig()).toEqual(before);
  });
  it('rejects legacy model writes after migration while allowing runtime controls', async () => {
    await request('PUT', await config());
    const writes: Array<[string, string, object]> = [
      ['PUT', '/api/ai/config', { workers: { describe: { provider: 'ollama', model: 'old' } } }],
      [
        'PUT',
        '/api/enrichment/config',
        { describe_model: 'old', nominatim_url: null, geocode_worker_enabled: true },
      ],
      ['PATCH', '/api/workers/describe/config', { ai_model: 'old' }],
      ['PATCH', '/api/workers/generated-search/config', { model: 'old' }],
    ];
    for (const [method, path, body] of writes)
      expect((await request(method, body, owner, path)).status, path).toBe(409);
    expect(
      (await request('PATCH', { maxAttempts: 4 }, owner, '/api/workers/describe/config')).status,
    ).toBe(200);
    expect(
      (await request('PATCH', { min_results: 12 }, owner, '/api/workers/generated-search/config'))
        .status,
    ).toBe(200);
  });
});
