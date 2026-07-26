/**
 * POST /api/admin/enrichment/backfill-meilisearch — bulk re-push every asset
 * with a stable `maple_id` to the Meilisearch sidecar.
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
import { assetsCollection, getDb } from '../db/client.ts';
import { meilisearchClient, type MeilisearchAssetDoc } from '../enrichment/meilisearch-client.ts';
import { composeSearchBlob } from '../enrichment/search-blob.ts';
import { resolveAssetPeopleNames } from '../workers/stages/meili.ts';
import type { AssetFaceDoc, FileInfo, Place, TranscriptDoc, VisionDoc } from '../db/schema.ts';
import { child as childLogger } from '../log.ts';
import { classifyMediaType } from '../indexer/media-types.ts';

const log = childLogger('enrichment:meilisearch-backfill');

const DEFAULT_BATCH_SIZE = 250;
const MAX_BATCH_SIZE = 1000;
const STATE_ID = 'assets';

interface BackfillState {
  _id: string;
  cursor: ObjectId | null;
  scanned: number;
  upserted: number;
  skipped: number;
  errors: number;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface BackfillRow {
  _id: ObjectId;
  maple_id?: string;
  folder_id?: ObjectId;
  filename?: string;
  fileinfo?: FileInfo[];
  exif?: { captured_at?: string | null } | null;
  place?: Place | null;
  description?: string | null;
  ocr_text?: string | null;
  transcript?: TranscriptDoc | null;
  vision?: VisionDoc | null;
  is_screenshot?: boolean | null;
  faces?: AssetFaceDoc[] | null;
  deleted_at?: string | null;
  hidden?: boolean;
}

export const meilisearchBackfillRoutes = new Elysia({
  prefix: '/api/admin/enrichment',
}).post('/backfill-meilisearch', async ({ set, query }) => {
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
  const states = (await getDb()).collection<BackfillState>('meilisearch_backfill_state');
  const requestedBatchSize = Number(query.batchSize ?? DEFAULT_BATCH_SIZE);
  const batchSize = Number.isFinite(requestedBatchSize)
    ? Math.min(MAX_BATCH_SIZE, Math.max(1, Math.trunc(requestedBatchSize)))
    : DEFAULT_BATCH_SIZE;
  const reset = query.reset === 'true';
  if (reset) await states.deleteOne({ _id: STATE_ID });

  let state = await states.findOne({ _id: STATE_ID });
  // A completed run is idempotently restartable. This keeps the operator's
  // "run again after data loss" workflow simple while incomplete runs resume.
  if (state?.completed_at) {
    await states.deleteOne({ _id: STATE_ID });
    state = null;
  }
  const now = new Date().toISOString();
  if (!state) {
    state = {
      _id: STATE_ID,
      cursor: null,
      scanned: 0,
      upserted: 0,
      skipped: 0,
      errors: 0,
      started_at: now,
      updated_at: now,
      completed_at: null,
    };
    await states.insertOne(state);
  }

  // Include filename-only assets too. Exact camera identifiers are part of
  // the lexical contract even before enrichment has produced search text.
  const filter: Record<string, unknown> = {
    maple_id: { $type: 'string', $ne: '' },
  };
  if (state.cursor) filter._id = { $gt: state.cursor };
  const rows = await coll
    .find(filter as Parameters<typeof coll.find>[0], {
      projection: {
        _id: 1,
        maple_id: 1,
        folder_id: 1,
        filename: 1,
        fileinfo: 1,
        'exif.captured_at': 1,
        place: 1,
        description: 1,
        ocr_text: 1,
        transcript: 1,
        vision: 1,
        is_screenshot: 1,
        faces: 1,
        deleted_at: 1,
        hidden: 1,
      },
    })
    .sort({ _id: 1 })
    .limit(batchSize)
    .toArray();

  let upserted = 0;
  let skipped = 0;
  let errors = 0;
  let scanned = 0;
  const docs: MeilisearchAssetDoc[] = [];
  let lastCursor = state.cursor;

  for (const raw of rows) {
    scanned += 1;
    const row = raw as unknown as BackfillRow;
    lastCursor = row._id;
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
        transcript: row.transcript?.text ?? null,
        visionSubjects: vision?.subjects ?? null,
        visionSetting: vision?.setting ?? null,
        visionActivity: vision?.activity ?? null,
        visionNotableObjects: vision?.notable_objects ?? null,
        people: peopleNames,
      });
      const primary =
        row.fileinfo?.find((entry) => entry.deleted_at == null && entry.missing_since == null) ??
        row.fileinfo?.[0];
      const folderId = primary?.library_id ?? row.folder_id;
      const filename = primary?.filename ?? row.filename;
      if (!folderId || !filename) {
        skipped += 1;
        continue;
      }
      docs.push({
        id: mapleId,
        filename,
        searchBlob,
        description: row.description ?? null,
        ocrText: row.ocr_text ?? null,
        folderId: folderId.toHexString(),
        capturedAt: row.exif?.captured_at ?? null,
        deletedAt: row.deleted_at ?? null,
        visionSceneType: vision?.scene_type ?? null,
        visionActivity: vision?.activity ?? null,
        visionSubjects: vision?.subjects ?? null,
        isScreenshot: row.is_screenshot ?? null,
        people: peopleNames.length > 0 ? peopleNames : null,
        mediaType: classifyMediaType(filename),
        hidden: row.hidden === true,
      });
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
      // Retry the entire idempotent batch next time rather than advancing
      // past a row whose document could not be composed.
      lastCursor = state.cursor;
      break;
    }
  }

  // Production enqueues one task for the whole batch. Test doubles and older
  // client implementations fall back to the per-document method.
  try {
    if (meili.upsertBatchOrThrow) {
      await meili.upsertBatchOrThrow(docs);
      upserted = docs.length;
    } else {
      for (const doc of docs) {
        try {
          await meili.upsertOrThrow(doc);
          upserted += 1;
        } catch (err) {
          errors += 1;
          lastCursor = state.cursor;
          log.warn(
            { mapleId: doc.id, err: err instanceof Error ? err.message : String(err) },
            'backfill upsert error',
          );
        }
      }
    }
  } catch (err) {
    errors += docs.length;
    // Do not advance the cursor on a batch transport/indexing failure: the
    // next request retries the same bounded batch.
    lastCursor = state.cursor;
    log.warn(
      { err: err instanceof Error ? err.message : String(err), batchSize: docs.length },
      'backfill batch failed; cursor retained for retry',
    );
  }

  const complete = rows.length < batchSize && errors === 0;
  const updatedAt = new Date().toISOString();
  await states.updateOne(
    { _id: STATE_ID },
    {
      $set: {
        cursor: lastCursor,
        updated_at: updatedAt,
        completed_at: complete ? updatedAt : null,
      },
      $inc: { scanned, upserted, skipped, errors },
    },
  );
  const cumulative = await states.findOne({ _id: STATE_ID });
  log.info(
    { scanned, upserted, skipped, errors, complete, nextCursor: lastCursor?.toHexString() ?? null },
    'meilisearch backfill batch complete',
  );
  return {
    scanned,
    upserted,
    skipped,
    errors,
    complete,
    nextCursor: complete ? null : (lastCursor?.toHexString() ?? null),
    cumulative: cumulative
      ? {
          scanned: cumulative.scanned,
          upserted: cumulative.upserted,
          skipped: cumulative.skipped,
          errors: cumulative.errors,
          startedAt: cumulative.started_at,
          updatedAt: cumulative.updated_at,
        }
      : null,
  };
});
