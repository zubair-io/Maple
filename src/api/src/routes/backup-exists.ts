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
import { fromHex, isMapleId } from '../indexer/id.ts';
import { Elysia, t } from 'elysia';
import { ObjectId } from '../db/object-id.ts';
import { findMapleIdsPresentInLibrary } from '../db/repos/backup.repo.ts';
import { findFolderById } from '../db/repos/folders.repo.ts';
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
    // Reject non-string entries rather than silently dropping them — the
    // documented contract is an array of strings, and masking a client bug
    // would let it skip uploads it never actually checked.
    if (rawIds.some((id) => typeof id !== 'string')) {
      set.status = 400;
      return { error: 'maple_ids must be an array of strings' };
    }

    if (rawIds.some((id) => !isMapleId(id))) {
      set.status = 400;
      return { error: 'invalid maple_id' };
    }

    // Check library exists.
    const folder = await findFolderById(libraryId);
    if (!folder) {
      set.status = 404;
      return { error: 'library not found' };
    }

    // De-duplicate the input while preserving first-seen order. `missing` is
    // computed against this de-duped list so the response never repeats an id.
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const rawId of rawIds as string[]) {
      const id = fromHex(rawId).hex;
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }

    if (ids.length === 0) {
      return { missing: [] };
    }

    // Single query: which of the requested ids are already present in this
    // library. Scoped to a LIVE location for this library (`deleted_at` unset)
    // so soft-deleted content isn't reported present — otherwise the client
    // would skip re-uploading a photo the user deleted. Matches the live-entry
    // filter in backup-state.ts.
    const present = await findMapleIdsPresentInLibrary(ids, libraryId);
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
