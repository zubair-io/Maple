/**
 * End-to-end coverage for GET /api/assets/:id — exercises the wire
 * contract of the metadata DTO produced by `routes/assets/metadata.ts`
 * + `db/sqlite/repos/assets.repo.ts:findDetailById`.
 *
 * Sibling assets endpoints already have e2e coverage
 * (assets-list.test.ts, assets-xmp-*.test.ts, assets-overrides.test.ts,
 * assets-restore.test.ts, assets-delete-trash.test.ts,
 * enrichment-route.test.ts, assets.thumb-etag.test.ts) — this file fills
 * the gap for the detail GET, which is the most field-heavy DTO in the
 * assets repo (vision, vision_meta, enrichment, description_meta).
 *
 * What the repository's own suite (`db/sqlite/repos/assets.repo.test.ts`)
 * cannot cover is everything on this side of the handler: the two status
 * codes for a malformed and an absent id, and that the DTO survives JSON
 * serialisation with its field names intact. Hence a real SQLite database
 * installed as the process-wide handle (#3787) rather than a `dbOverride`:
 * the route reaches `sqliteDb()` with nothing to hand it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { assetsRoutes } from '../src/routes/assets.ts';
import { newObjectIdHex } from '../src/db/sqlite/object-id.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertLocation,
  run,
  type LiveTestDatabase,
} from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import { insertDetail } from '../src/db/sqlite/repos/assets.test-helpers.ts';
import { fakeAuth } from './helpers/test-auth.ts';
import { registerLibrary } from './helpers/assets-route-fixtures.ts';

const LIBRARY_ROOT = '/libraries/detail-route';

let live: LiveTestDatabase;
let libraryId: string;

beforeEach(async () => {
  live = await createLiveTestDatabase();
  libraryId = registerLibrary(live.db, LIBRARY_ROOT, 'detail-route');
});

afterEach(() => {
  live.close();
});

function app() {
  return new Elysia().use(fakeAuth()).use(assetsRoutes);
}

describe('GET /api/assets/:id', () => {
  it('returns 400 for a malformed id', async () => {
    const res = await app().handle(new Request('http://localhost/api/assets/not-an-objectid'));
    expect(res.status).toBe(400);
  });

  it('returns 404 when the id is well-formed but absent', async () => {
    const res = await app().handle(new Request(`http://localhost/api/assets/${newObjectIdHex()}`));
    expect(res.status).toBe(404);
  });

  it('returns the full DTO shape for a populated asset', async () => {
    const describeMeta = {
      provider: 'ollama',
      model: 'qwen2.5vl:7b',
      prompt_version: 4,
      generated_at: '2026-05-01T00:00:00Z',
      cost_usd: 0,
    };
    const ocrMeta = {
      engine: 'qwen2.5-vl',
      engine_version: '2026.05',
      generated_at: '2026-05-01T00:00:00Z',
      mean_confidence: null,
    };
    const id = insertAsset(live.db);
    insertLocation(live.db, {
      assetId: id,
      libraryId,
      path: '',
      filename: 'a.dng',
    });
    run(
      live.db,
      `UPDATE assets
          SET size = 4096, mtime = 1700000000000, rating = 4, flag = 1, color_label = 'red',
              indexed_at = '2026-04-01T00:00:00Z', is_screenshot = 0
        WHERE id = ?`,
      id,
    );
    insertDetail(live.db, id, {
      description: 'a caption',
      descriptionMeta: JSON.stringify(describeMeta),
      ocrText: 'VISIBLE TEXT',
      ocrMeta: JSON.stringify(ocrMeta),
    });

    const res = await app().handle(new Request(`http://localhost/api/assets/${id}`));
    expect(res.status).toBe(200);
    const body = await res.json();

    // id + folder_id are hex strings on the wire (not ObjectId).
    expect(body.id).toBe(id);
    expect(body.folder_id).toBe(libraryId);
    // mtime stays in ms in the detail DTO (only the list endpoint
    // divides by 1000).
    expect(body.mtime).toBe(1_700_000_000_000);
    expect(body.size).toBe(4096);
    expect(body.rating).toBe(4);
    expect(body.flag).toBe(1);
    expect(body.color_label).toBe('red');
    expect(body.indexed_at).toBe('2026-04-01T00:00:00Z');
    expect(body.description).toBe('a caption');
    expect(body.ocr_text).toBe('VISIBLE TEXT');
    expect(body.is_screenshot).toBe(false);
    // description_meta is a passthrough JSON payload — verify it
    // round-trips verbatim through the repo's cast.
    expect(body.description_meta).toEqual(describeMeta);
    // ocr_meta passes through as-is.
    expect(body.ocr_meta?.engine).toBe('qwen2.5-vl');
    // Enrichment is normalised — every stage carries the pending-shape
    // fields even though no `enrichment_state` row exists.
    expect(body.enrichment.geocode.done_at).toBeNull();
    expect(body.enrichment.face.done_at).toBeNull();
    expect(body.enrichment.describe.done_at).toBeNull();
  });

  it('defaults vision + place + faces when absent on the row', async () => {
    const id = insertAsset(live.db);
    insertLocation(live.db, {
      assetId: id,
      libraryId,
      path: '',
      filename: 'minimal.dng',
    });
    run(live.db, `UPDATE assets SET size = 1, mtime = 1 WHERE id = ?`, id);

    const res = await app().handle(new Request(`http://localhost/api/assets/${id}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.place).toBeNull();
    expect(body.faces).toEqual([]);
    expect(body.description).toBeNull();
    expect(body.description_meta).toBeNull();
    expect(body.vision).toBeNull();
    expect(body.vision_meta).toBeNull();
    // Enrichment is normalised even when the asset has no detail row at all.
    expect(body.enrichment.geocode.done_at).toBeNull();
    expect(body.enrichment.face.done_at).toBeNull();
    expect(body.enrichment.describe.done_at).toBeNull();
  });
});
