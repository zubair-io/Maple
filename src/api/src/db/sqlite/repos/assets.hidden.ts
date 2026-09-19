/**
 * The hidden-asset review queue behind `/api/photos/hidden` and the
 * acknowledgement that clears it (#3787).
 *
 * Two operations that only this surface performs, kept out of `assets.repo.ts`
 * because they are a Settings alert list rather than part of the grid's read
 * path — and because the write below is the one place in the repository that
 * narrows an update by `hidden_reason`.
 *
 * ## `hidden_ack` is meaningful only for an AI-driven hide
 *
 * A manual hide never sets the flag, so "acknowledged" has no meaning for one,
 * and the ack write says so in its `WHERE` rather than relying on the caller.
 * That is also what makes the route's 404 honest: the update matching no row
 * means "no such asset, or not something the reviewer can acknowledge", which
 * are the same answer from the client's side.
 */

import type { ObjectId } from 'mongodb';
import { findDetailsByIds } from './assets.repo.ts';
import { sqliteDb, updateOutcome, type SqliteDb, type UpdateOutcome } from './db-handle.ts';
import type { AssetDetailDto } from '../../assets.transform.ts';
import { toObjectId } from './values.ts';

export type { SqliteDb } from './db-handle.ts';

/** The two `hidden_reason` values the nudity classifier writes. */
const AI_HIDDEN_REASONS = `('nudity', 'nudity-burst')`;

/**
 * The hidden assets a reviewer sees, newest first, capped.
 *
 * `onlyNew` narrows to the unacknowledged AI-driven hides — the badge count's
 * backing set. Without it the list is every hidden asset, manual ones included,
 * which is what the Settings page shows when the reviewer asks to see them all.
 *
 * Ordered by id descending, which is capture-agnostic and deliberately so: an
 * ObjectId's leading bytes are its mint time, so this is "most recently added to
 * the library", and the cap is meant to surface the newest alerts rather than a
 * sample of the whole backlog.
 */
export async function findHiddenAssets(
  options: { onlyNew: boolean; limit: number },
  dbOverride?: SqliteDb,
): Promise<AssetDetailDto[]> {
  const db = sqliteDb(dbOverride);
  const narrowed = options.onlyNew
    ? ` AND hidden_ack = 0 AND hidden_reason IN ${AI_HIDDEN_REASONS}`
    : '';
  const rows = await db.read<{ id: string }>(
    `SELECT id FROM assets WHERE hidden = 1${narrowed} ORDER BY id DESC LIMIT ?`,
    [options.limit],
  );
  if (rows.length === 0) return [];

  // `findDetailsByIds` returns its rows id-ordered ascending, so the page order
  // is restored here rather than left to the caller — the cap above only makes
  // sense together with the order that decided what it kept.
  const details = await findDetailsByIds(
    rows.map((row) => toObjectId(row.id)),
    db,
  );
  const byId = new Map(details.map((dto) => [dto.id, dto] as const));
  return rows.flatMap((row) => {
    const dto = byId.get(row.id);
    return dto === undefined ? [] : [dto];
  });
}

/**
 * Acknowledge one AI-driven hide. `matchedCount` of 0 is the route's 404.
 *
 * Scoped to the two classifier reasons for the same reason the Mongo filter was:
 * a manual hide's flag is documented as meaningless, and flipping it would make
 * the review list disagree with itself.
 */
export async function acknowledgeHiddenAsset(
  id: ObjectId,
  dbOverride?: SqliteDb,
): Promise<UpdateOutcome> {
  const result = await sqliteDb(dbOverride).write(
    `UPDATE assets SET hidden_ack = 1
      WHERE id = ? AND hidden_reason IN ${AI_HIDDEN_REASONS}`,
    [id.toHexString()],
  );
  return updateOutcome(result.changes);
}
