/**
 * `GET /api/admin/enrichment/meilisearch-embedder` and
 * `POST …/meilisearch-embedder/apply` (#4432): the settings page's view of a
 * drifted index embedder, and the explicit action that re-embeds the library.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import {
  createMeilisearchClient,
  setMeilisearchClientForTests,
} from '../src/enrichment/meilisearch-client.ts';
import { assetsIndexSettings } from '../src/enrichment/meilisearch-index-settings.ts';
import {
  fakeMeilisearchIndex,
  type FakeMeilisearchIndex,
} from '../src/enrichment/meilisearch-test-harness.ts';
import { signAccessToken } from '../src/auth/tokens.ts';
import {
  _resetAdminMeilisearchStatusCacheForTests,
  adminMeilisearchStatusRoutes,
} from '../src/routes/admin-meilisearch-status.ts';
import { newObjectIdHex } from '../src/db/object-id.ts';

process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);

const ownerJwt = await signAccessToken(
  { file_access: true, sub: newObjectIdHex(), email: 'o@m.c', role: 'owner' },
  'x'.repeat(32),
);
const memberJwt = await signAccessToken(
  { file_access: true, sub: newObjectIdHex(), email: 'm@m.c', role: 'member' },
  'x'.repeat(32),
);

const OLD_OLLAMA = 'http://192.168.0.250:11434';
const NEW_OLLAMA = 'http://192.168.0.201:11434';

afterEach(() => {
  setMeilisearchClientForTests(null);
  _resetAdminMeilisearchStatusCacheForTests();
});

function installDriftedIndex(): FakeMeilisearchIndex {
  const meili = fakeMeilisearchIndex(
    assetsIndexSettings(
      { semantic: true, embedderUrl: OLD_OLLAMA, embedderModel: 'bge-m3' },
      'caption',
    ),
    { documents: 335_000 },
  );
  setMeilisearchClientForTests(
    createMeilisearchClient({
      url: 'http://meili.local:7700',
      fetchImpl: meili.fetchImpl,
      taskPollIntervalMs: 0,
      semantic: true,
      embedderUrl: NEW_OLLAMA,
      embedderModel: 'bge-m3',
    }),
  );
  return meili;
}

const call = (method: 'GET' | 'POST', path: string, jwt: string): Promise<Response> =>
  new Elysia().use(adminMeilisearchStatusRoutes).handle(
    new Request(`http://localhost/api/admin/enrichment/${path}`, {
      method,
      headers: { authorization: `Bearer ${jwt}` },
    }),
  );

describe('Meilisearch embedder drift routes (#4432)', () => {
  it('reports the drifted embedder without touching the index', async () => {
    const meili = installDriftedIndex();
    const response = await call('GET', 'meilisearch-embedder', ownerJwt);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      state: 'drift',
      live: { url: `${OLD_OLLAMA}/api/embed` },
      configured: { url: `${NEW_OLLAMA}/api/embed` },
      documentCount: 335_000,
      reembedsAllDocuments: true,
    });
    expect(meili.patches).toHaveLength(0);
  });

  it('applies the change with exactly one PATCH of the changed field', async () => {
    const meili = installDriftedIndex();
    const response = await call('POST', 'meilisearch-embedder/apply', ownerJwt);
    expect(response.status).toBe(202);
    expect(meili.patches).toEqual([{ embedders: { caption: { url: `${NEW_OLLAMA}/api/embed` } } }]);

    const again = await call('POST', 'meilisearch-embedder/apply', ownerJwt);
    expect(again.status).toBe(409);
    expect(meili.patches).toHaveLength(1);
  });

  it('keeps both routes owner-only, like the rest of /api/admin/enrichment', async () => {
    const meili = installDriftedIndex();
    expect((await call('GET', 'meilisearch-embedder', memberJwt)).status).toBe(403);
    expect((await call('POST', 'meilisearch-embedder/apply', memberJwt)).status).toBe(403);
    expect(meili.patches).toHaveLength(0);
  });
});
