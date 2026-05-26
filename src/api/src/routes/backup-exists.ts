/**
 * POST /api/libraries/:libraryId/backup/exists
 *
 * Batch deduplication probe for the PhotoKit backup client. The device
 * computes a content-derived `maple_id` for each local photo, then asks the
 * server — in batches of at most 1000 — which of those ids the server does
 * NOT already have in this library, so it can skip re-uploading duplicates.
 *
 * Request body:
 *   { maple_ids: string[] }   — at most 1000 ids per request
 *
 * Response 200:
 *   { missing: string[] }     — the subset of the (de-duplicated) input ids
 *                               that are NOT present in this library, in input
 *                               order, no duplicates.
 *
 * Response 400:
 *   - invalid :libraryId ObjectId          → { error: "invalid library id" }
 *   - missing / non-array maple_ids         → { error: "maple_ids must be an array" }
 *   - more than 1000 ids                    → { error: "too many ids (max 1000)" }
 * Response 404:
 *   - library (folder) not found            → { error: "library not found" }
 *
 * No auth gate — same rationale as the sibling backup-* routes (the passkey
 * auth design hasn't landed yet; see how these are mounted in `index.ts`).
 *
 * An id is "present" when an asset in this library carries that `maple_id`.
 * The library link lives on `fileinfo[].library_id` (there is no top-level
 * `folder_id` on AssetDoc — the dedup key is `maple_id` and the library
 * association is `fileinfo.library_id`, matching `backup-ingest.ts`'s insert
 * and `backup-state.ts`'s query).
 *
 * Spec: .archived-plans/specs/2026-05-09-photokit-backup-design.md §20.
 */
import { Elysia, t } from 'elysia';
import { ObjectId } from 'mongodb';
import { assetsCollection, foldersCollection } from '../db/client.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('backup-exists');

const MAX_IDS = 1000;

export const backupExistsRoutes = new Elysia().post(
  '/api/libraries/:libraryId/backup/exists',
  async ({ params, body, set }) => {
    // Validate library id.
    let libraryId: ObjectId;
    try {
      libraryId = new ObjectId(params.libraryId);
    } catch {
      set.status = 400;
      return { error: 'invalid library id' };
    }

    // Validate body shape — maple_ids must be an array of strings.
    const rawIds = (body as { maple_ids?: unknown } | null)?.maple_ids;
    if (!Array.isArray(rawIds)) {
      set.status = 400;
      return { error: 'maple_ids must be an array' };
    }
    if (rawIds.length > MAX_IDS) {
      set.status = 400;
      return { error: `too many ids (max ${MAX_IDS})` };
    }

    // Check library exists.
    const folder = await (await foldersCollection()).findOne({ _id: libraryId });
    if (!folder) {
      set.status = 404;
      return { error: 'library not found' };
    }

    // De-duplicate the input while preserving first-seen order. `missing` is
    // computed against this de-duped list so the response never repeats an id.
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const id of rawIds) {
      if (typeof id !== 'string') continue;
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }

    if (ids.length === 0) {
      return { missing: [] };
    }

    // Single Mongo query: which of the requested ids are already present in
    // this library. Scoped to fileinfo.library_id (the library link) AND
    // maple_id in the requested set; project only maple_id.
    const a = await assetsCollection();
    const rows = await a
      .find(
        { 'fileinfo.library_id': libraryId, maple_id: { $in: ids } },
        { projection: { maple_id: 1, _id: 0 } },
      )
      .toArray();

    const present = new Set<string>();
    for (const r of rows) {
      if (typeof r.maple_id === 'string') present.add(r.maple_id);
    }

    const missing = ids.filter((id) => !present.has(id));

    log.debug(
      {
        libraryId: libraryId.toHexString(),
        requested: ids.length,
        missing: missing.length,
      },
      'backup exists probe',
    );

    return { missing };
  },
  {
    params: t.Object({ libraryId: t.String() }),
    body: t.Any(),
  },
);
