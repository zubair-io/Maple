/**
 * POST /api/admin/enrichment/backfill-meilisearch — bulk re-push every asset
 * with a non-empty `place.search_blob` to the Meilisearch sidecar.
 *
 * Use cases:
 *   - Fresh Meilisearch instance: seed the index from the existing Mongo
 *     population without rerunning the geocode worker.
 *   - Meilisearch data loss / version upgrade: re-seed without touching
 *     the canonical Mongo rows.
 *
 * Idempotent — Meilisearch upserts on the primary key (`maple_id`). Running
 * the route twice on the same population produces the same index state.
 *
 * Surface area is operator-only: behind `requireAuth` (mounted alongside
 * `enrichmentAdminRoutes` in `src/index.ts`). Errors surface with the
 * route response so the operator can see what failed; this is the ONE
 * place we let Meilisearch errors bubble (the geocode worker and
 * soft-delete paths are fire-and-forget).
 */

import { Elysia } from 'elysia';
import type { ObjectId } from 'mongodb';
import { assetsCollection } from '../db/client.ts';
import { meilisearchClient } from '../enrichment/meilisearch-client.ts';
import { composeSearchBlob } from '../enrichment/search-blob.ts';
import { resolveAssetPeopleNames } from '../workers/stages/meili.ts';
import type { AssetFaceDoc, Place, VisionDoc } from '../db/schema.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('enrichment:meilisearch-backfill');

const BATCH_SIZE = 1000;

interface BackfillRow {
  _id: ObjectId;
  maple_id?: string;
  folder_id: ObjectId;
  exif?: { captured_at?: string | null } | null;
  place?: Place | null;
  description?: string | null;
  ocr_text?: string | null;
  vision?: VisionDoc | null;
  is_screenshot?: boolean | null;
  faces?: AssetFaceDoc[] | null;
  deleted_at?: string | null;
}

export const meilisearchBackfillRoutes = new Elysia({
  prefix: '/api/admin/enrichment',
}).post('/backfill-meilisearch', async ({ set }) => {
  const meili = meilisearchClient();
  if (!meili.isConfigured()) {
    set.status = 400;
    return {
      error:
        'Meilisearch is not configured (MAPLE_MEILISEARCH_URL unset). Set the env var and restart, then retry the backfill.',
    };
  }

  // Make sure the index + settings exist before we start pushing docs.
  await meili.ensureIndex();

  const coll = await assetsCollection();
  // Gate on the unified top-level `search_blob` — the meili stage folds
  // place + description + OCR + vision + people into it. Gating on
  // `place.search_blob` (as before) skipped assets that are searchable via
  // description/vision/people but have no GPS/place.
  const cursor = coll
    .find(
      {
        search_blob: { $exists: true, $ne: '' },
      } as unknown as Parameters<typeof coll.find>[0],
      {
        projection: {
          _id: 1,
          maple_id: 1,
          folder_id: 1,
          'exif.captured_at': 1,
          place: 1,
          description: 1,
          ocr_text: 1,
          vision: 1,
          is_screenshot: 1,
          faces: 1,
          deleted_at: 1,
        },
      },
    )
    .batchSize(BATCH_SIZE);

  let upserted = 0;
  let skipped = 0;
  let errors = 0;
  let scanned = 0;

  // Drain the cursor in batches. We awaited each upsert serially to keep
  // the implementation small; Meilisearch coalesces these into a single
  // task via the documents endpoint, so latency comes from the loop, not
  // the wire.
  for await (const raw of cursor) {
    scanned += 1;
    const row = raw as unknown as BackfillRow;
    const mapleId = row.maple_id;
    if (typeof mapleId !== 'string' || mapleId.length === 0) {
      skipped += 1;
      continue;
    }
    try {
      // Resolve named people for the people attribute + blob token bag,
      // then recompose the FULL searchBlob so the index matches what the
      // meili stage produces (place + description + vision + people).
      const peopleNames = await resolveAssetPeopleNames(row.faces ?? null);
      const vision = row.vision ?? null;
      const searchBlob = composeSearchBlob({
        place: row.place ?? null,
        description: row.description ?? null,
        ocrText: row.ocr_text ?? null,
        visionSubjects: vision?.subjects ?? null,
        visionSetting: vision?.setting ?? null,
        visionActivity: vision?.activity ?? null,
        visionNotableObjects: vision?.notable_objects ?? null,
        people: peopleNames,
      });
      // Nothing indexable for this row (no place/description/OCR/vision and
      // no named people) — skip rather than push an empty document.
      if (searchBlob.length === 0 && peopleNames.length === 0) {
        skipped += 1;
        continue;
      }
      // `upsertOrThrow` (not `upsert`) so a Meili transport failure lands in
      // the catch and bumps `errors` — this operator endpoint must report
      // real failures rather than silently swallowing them.
      await meili.upsertOrThrow({
        id: mapleId,
        searchBlob,
        description: row.description ?? null,
        ocrText: row.ocr_text ?? null,
        folderId: row.folder_id.toHexString(),
        capturedAt: row.exif?.captured_at ?? null,
        deletedAt: row.deleted_at ?? null,
        visionSceneType: vision?.scene_type ?? null,
        visionActivity: vision?.activity ?? null,
        visionSubjects: vision?.subjects ?? null,
        isScreenshot: row.is_screenshot ?? null,
        people: peopleNames.length > 0 ? peopleNames : null,
      });
      upserted += 1;
    } catch (err) {
      // `upsertOrThrow` (and any people-resolution failure) lands here —
      // log and bump `errors` so the operator sees a non-zero count.
      log.warn(
        {
          mapleId,
          err: err instanceof Error ? err.message : String(err),
        },
        'backfill upsert error',
      );
      errors += 1;
    }
  }

  log.info({ scanned, upserted, skipped, errors }, 'meilisearch backfill complete');
  return { scanned, upserted, skipped, errors };
});
