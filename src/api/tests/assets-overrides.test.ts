/**
 * Tests for the manual-override + requeue routes added on top of
 * /api/assets/:id (PUT place / description, POST enrichment/requeue).
 *
 * Real SQLite, one database per test installed as the process-wide handle
 * (#3787) — these drive route handlers, which reach `sqliteDb()` with no
 * override. Nothing external to reach, so nothing to skip on.
 *
 * Where the Mongo document fanned out: the caption lives on `asset_detail`,
 * the synthesised search text on `asset_search`, the `stages.meili` re-arm on
 * `stage_state`, and the per-stage enrichment bookkeeping on
 * `enrichment_state`. Each assertion reads the table that now owns the field.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Elysia } from 'elysia';
import { assetsRoutes } from '../src/routes/assets.ts';
import { newObjectIdHex } from '../src/db/object-id.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import { insertDetail, insertEnrichmentState } from '../src/db/repos/assets.test-helpers.ts';
import { fakeAuth } from './helpers/test-auth.ts';
import {
  enrichmentStateRow,
  registerLibrary,
  searchBlob,
  seedRouteAsset,
  stageStateRow,
} from './helpers/assets-route-fixtures.ts';

const LIBRARY_ROOT = '/libraries/overrides';

/** The stage bookkeeping a re-armed `meili` row carries. */
const REARMED_MEILI = { version: 0, attempts: 0, dead: 0, processed_at: null, last_error: null };

let live: LiveTestDatabase;
let app: Elysia;
let assetId: string;

beforeEach(async () => {
  live = await createLiveTestDatabase();
  const libraryId = registerLibrary(live.db, LIBRARY_ROOT, 'overrides');
  assetId = seedRouteAsset(live.db, {
    libraryId,
    path: '',
    filename: 'DSC_1234.dng',
    size: 12345,
  });
  app = new Elysia().use(fakeAuth()).use(assetsRoutes) as unknown as Elysia;
});

afterEach(() => {
  live.close();
});

async function put(
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const res = await app.handle(
    new Request(`http://localhost${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

async function post(
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const res = await app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

/** The stored `place` JSON, decoded. */
function placeOf(id: string): { display_name?: string } | null {
  const row = live.db.query(`SELECT place FROM assets WHERE id = ?`).get(id) as {
    place: string | null;
  } | null;
  return row?.place == null ? null : (JSON.parse(row.place) as { display_name?: string });
}

/** The stored caption. */
function descriptionOf(id: string): string | null {
  const row = live.db.query(`SELECT description FROM asset_detail WHERE asset_id = ?`).get(id) as {
    description: string | null;
  } | null;
  return row?.description ?? null;
}

const BROOKLYN = {
  source: 'manual',
  geocoder_version: 0,
  geocoded_at: '2026-04-01T00:00:00Z',
  lat: 40.7128,
  lon: -74.006,
  display_name: 'Brooklyn, New York, USA',
  address: { city: 'Brooklyn', state: 'New York', country: 'USA' },
  pois: [],
  rollups: { locality: 'Brooklyn', region: 'New York', country_code: 'us' },
  search_blob: 'brooklyn new york usa',
};

describe('PUT /api/assets/:id/place', () => {
  it('400 on bad ObjectId', async () => {
    const r = await put('/api/assets/not-an-oid/place', { place: null });
    expect(r.status).toBe(400);
  });

  it('404 on unknown asset', async () => {
    const r = await put(`/api/assets/${newObjectIdHex()}/place`, { place: null });
    expect(r.status).toBe(404);
  });

  it('saves a place + recomputes search_blob', async () => {
    const r = await put(`/api/assets/${assetId}/place`, { place: BROOKLYN });
    expect(r.status).toBe(204);
    expect(placeOf(assetId)?.display_name).toBe('Brooklyn, New York, USA');
    // search_blob is the sorted-deduped tokenisation of the place's
    // search_blob (description and ocr_text are still null). Sort is
    // pure alphabetical — "york" lands after "usa".
    expect(searchBlob(live.db, assetId)).toBe('brooklyn new usa york');
    expect(stageStateRow(live.db, assetId, 'meili')).toMatchObject(REARMED_MEILI);
  });

  it('clears the place when null is sent', async () => {
    // Set a place first so there is something to clear — and so the blob
    // starts non-empty, which is the state the clearing has to undo.
    await put(`/api/assets/${assetId}/place`, { place: BROOKLYN });
    expect(searchBlob(live.db, assetId)).not.toBe('');

    const r = await put(`/api/assets/${assetId}/place`, { place: null });
    expect(r.status).toBe(204);
    expect(placeOf(assetId)).toBeNull();
    // Without a place, the unified blob falls back to description + ocr —
    // both null on this seed → empty, which `asset_search` stores as the
    // absence of a row.
    expect(searchBlob(live.db, assetId)).toBe('');
  });
});

describe('PUT /api/assets/:id/description', () => {
  it('saves description + recomputes search_blob', async () => {
    const r = await put(`/api/assets/${assetId}/description`, {
      text: 'A red barn at sunset',
    });
    expect(r.status).toBe(204);
    expect(descriptionOf(assetId)).toBe('A red barn at sunset');
    // search_blob = sorted lowercase token bag.
    expect(searchBlob(live.db, assetId)).toBe('a at barn red sunset');
    expect(stageStateRow(live.db, assetId, 'meili')).toMatchObject(REARMED_MEILI);
  });

  it('clears description when null is sent', async () => {
    insertDetail(live.db, assetId, { description: 'old caption' });
    const r = await put(`/api/assets/${assetId}/description`, { text: null });
    expect(r.status).toBe(204);
    expect(descriptionOf(assetId)).toBeNull();
  });

  it('422 when text is not a string or null (Elysia schema validation)', async () => {
    const r = await put(`/api/assets/${assetId}/description`, { text: 42 });
    expect(r.status).toBe(422);
  });
});

describe('POST /api/assets/:id/enrichment/requeue', () => {
  it('400 on unknown stage', async () => {
    const r = await post(`/api/assets/${assetId}/enrichment/requeue`, {
      stage: 'bogus',
    });
    expect(r.status).toBe(400);
  });

  it('clears done_at + bumps version on a fresh row', async () => {
    // Mark geocode as done — and claimed, and dead-lettered — so every
    // field the requeue is meant to reset starts out set.
    const stamped = '2026-04-01T00:00:00Z';
    insertEnrichmentState(live.db, assetId, 'geocode', {
      doneAt: stamped,
      version: 1,
      attempts: 3,
      lastError: 'boom',
      deadLetterAt: stamped,
      lockedBy: 'stale-worker',
      leaseExpiresAt: stamped,
    });

    const r = await post(`/api/assets/${assetId}/enrichment/requeue`, {
      stage: 'geocode',
    });
    expect(r.status).toBe(200);
    expect((r.body as { stage: string; version: number }).stage).toBe('geocode');
    expect((r.body as { stage: string; version: number }).version).toBe(2);

    expect(enrichmentStateRow(live.db, assetId, 'geocode')).toEqual({
      done_at: null,
      version: 2,
      attempts: 0,
      last_error: null,
      dead_letter_at: null,
      locked_by: null,
      lease_expires_at: null,
    });
  });

  it('works for every stage in the whitelist', async () => {
    for (const stage of ['geocode', 'face', 'describe']) {
      const r = await post(`/api/assets/${assetId}/enrichment/requeue`, { stage });
      expect(r.status).toBe(200);
      expect((r.body as { stage: string }).stage).toBe(stage);
    }
  });

  it('starts from version 1 when row had no prior version', async () => {
    const r = await post(`/api/assets/${assetId}/enrichment/requeue`, {
      stage: 'describe',
    });
    expect(r.status).toBe(200);
    expect((r.body as { version: number }).version).toBe(1);
  });
});

describe('GET /api/assets/:id (extended payload)', () => {
  it('includes ocr_text and ocr_meta in the response', async () => {
    insertDetail(live.db, assetId, {
      ocrText: 'hello',
      ocrMeta: JSON.stringify({
        engine: 'qwen2.5-vl',
        engine_version: 'qwen3-vl:8b',
        generated_at: '2026-04-01T00:00:00Z',
        mean_confidence: null,
      }),
    });
    const res = await app.handle(new Request(`http://localhost/api/assets/${assetId}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ocr_text: string | null;
      ocr_meta: { engine: string } | null;
    };
    expect(body.ocr_text).toBe('hello');
    expect(body.ocr_meta!.engine).toBe('qwen2.5-vl');
  });
});
