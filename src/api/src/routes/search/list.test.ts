/**
 * #2358 — the Meilisearch-backed `placeQuery` path in `list.ts` didn't
 * thread the caller's `hidden` mode into `meili.search`, so Meili always
 * excluded hidden docs from its candidate id set (its own default). The
 * Mongo re-fetch's `hidden: true` predicate for `hidden=only` then
 * intersected against an already hidden-free id set and always came back
 * empty; `hidden=all` had the same problem in the other direction — a
 * hidden asset could never surface even though the Mongo filter placed no
 * constraint on it.
 *
 * Uses the `setMeilisearchClientForTests` seam (same pattern as
 * `workers/stages/meili.test.ts`) with a fake client that reproduces
 * `buildFilter`'s hidden handling (default exclusion, `includeHidden`,
 * and the `onlyHidden` pushdown). That makes this test actually exercise
 * the Mongo-side intersection, not just assert on the options object
 * passed to `search`.
 *
 * Real Mongo required (localhost:27017 by default, override via
 * `MAPLE_MONGO_URI`) — soft-skips when unreachable, matching
 * `assets-list.test.ts`.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { ObjectId, type Db } from 'mongodb';
import { listRoute } from './list.ts';
import { getDb, isDbConnected } from '../../db/client.ts';
import {
  setMeilisearchClientForTests,
  type MeilisearchClient,
  type MeilisearchSearchOptions,
} from '../../enrichment/meilisearch-client.ts';

let db: Db | null = null;
let mongoReachable = false;

const VISIBLE_ID = 'maple-visible-1';
const HIDDEN_ID = 'maple-hidden-1';

beforeEach(async () => {
  try {
    db = await getDb();
    mongoReachable = isDbConnected();
  } catch {
    mongoReachable = false;
    return;
  }
  if (!mongoReachable || !db) return;
  await db.collection('assets').deleteMany({});
});

afterEach(() => {
  setMeilisearchClientForTests(null);
});

afterAll(async () => {
  if (db) await db.collection('assets').deleteMany({});
});

async function seed(d: Db): Promise<void> {
  const folder = new ObjectId();
  const now = new Date('2026-05-10T00:00:00Z');
  await d.collection('assets').insertMany([
    {
      maple_id: VISIBLE_ID,
      fileinfo: [{ path: '', filename: 'visible.dng', library_id: folder, deleted_at: null }],
      size: 1,
      mtime: 1,
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: 'now',
      deleted_at: null,
      hidden: false,
      exif: { captured_at: now.toISOString() },
    },
    {
      maple_id: HIDDEN_ID,
      fileinfo: [{ path: '', filename: 'hidden.dng', library_id: folder, deleted_at: null }],
      size: 1,
      mtime: 1,
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: 'now',
      deleted_at: null,
      hidden: true,
      exif: { captured_at: now.toISOString() },
    },
  ] as never);
}

/** Reproduces `buildFilter`'s hidden handling against the live index:
 * `onlyHidden` narrows the candidate set to the hidden doc alone
 * (`hidden = true`), `includeHidden` returns both, and the default
 * excludes the hidden candidate entirely. */
function fakeMeiliClient(): {
  client: MeilisearchClient;
  calls: MeilisearchSearchOptions[];
} {
  const calls: MeilisearchSearchOptions[] = [];
  const client: MeilisearchClient = {
    isConfigured: () => true,
    semanticConfigured: () => false,
    health: async () => true,
    ensureIndex: async () => {},
    upsert: async () => {},
    upsertOrThrow: async () => {},
    tombstone: async () => {},
    search: async (_q, opts = {}) => {
      calls.push(opts);
      const ids =
        opts.onlyHidden === true
          ? [HIDDEN_ID]
          : opts.includeHidden === true
            ? [VISIBLE_ID, HIDDEN_ID]
            : [VISIBLE_ID];
      return { ids, estimatedTotal: ids.length };
    },
  };
  return { client, calls };
}

describe('GET /api/search — placeQuery hidden mode (#2358)', () => {
  it('hidden=only returns the hidden match via the Meili path', async () => {
    if (!mongoReachable || !db) return;
    await seed(db);
    const { client, calls } = fakeMeiliClient();
    setMeilisearchClientForTests(client);

    const app = new Elysia().use(listRoute);
    const res = await app.handle(new Request('http://localhost/?placeQuery=museum&hidden=only'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.map((r: { filename: string }) => r.filename)).toEqual(['hidden.dng']);
    expect(calls[0]?.onlyHidden).toBe(true);
  });

  it('hidden=all includes both the visible and hidden match', async () => {
    if (!mongoReachable || !db) return;
    await seed(db);
    const { client, calls } = fakeMeiliClient();
    setMeilisearchClientForTests(client);

    const app = new Elysia().use(listRoute);
    const res = await app.handle(new Request('http://localhost/?placeQuery=museum&hidden=all'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.map((r: { filename: string }) => r.filename).sort()).toEqual([
      'hidden.dng',
      'visible.dng',
    ]);
    expect(calls[0]?.includeHidden).toBe(true);
  });

  it('default hidden mode still excludes the hidden match', async () => {
    if (!mongoReachable || !db) return;
    await seed(db);
    const { client, calls } = fakeMeiliClient();
    setMeilisearchClientForTests(client);

    const app = new Elysia().use(listRoute);
    const res = await app.handle(new Request('http://localhost/?placeQuery=museum'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.map((r: { filename: string }) => r.filename)).toEqual(['visible.dng']);
    expect(calls[0]?.includeHidden).toBe(false);
    expect(calls[0]?.onlyHidden).toBe(false);
  });
});
