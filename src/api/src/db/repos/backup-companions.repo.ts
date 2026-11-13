/**
 * The companion slots a PhotoKit backup records beside an original: where the
 * Apple-rendered edit and a Live Photo's `.mov` landed (#5243). Split from
 * `backup.repo.ts`, which owns the device link and location writes.
 */

import type { AppleCompanionSlot } from '../apple-companions.ts';
import type { ObjectId } from '../object-id.ts';
import {
  matchedOne,
  sqliteDb,
  updateOutcome,
  type SqliteDb,
  type UpdateOutcome,
} from './db-handle.ts';
import { toHex } from './values.ts';

/**
 * Point an asset's `slot` at the companion that was just uploaded beside it.
 *
 * One row, chosen by the same `(maple_id, this library)` pair the Mongo
 * `updateOne` matched on. The inner `LIMIT 1` is what keeps it `updateOne`
 * rather than `updateMany`: two libraries can hold the same content, and only
 * the one the companion was uploaded to should learn about it.
 */
export async function setAppleCompanionPath(
  libraryId: ObjectId,
  mapleId: string,
  slot: AppleCompanionSlot,
  relPath: string,
  dbOverride?: SqliteDb,
): Promise<UpdateOutcome> {
  return await writeAppleCompanionPath(libraryId, mapleId, slot, relPath, '', dbOverride);
}

/**
 * {@link setAppleCompanionPath}, but only when the slot is empty.
 *
 * For a companion upload whose session had already finished: its bytes are on
 * disk, yet the slot may never have been written, and a newer companion
 * recorded since must not be pointed back at the old file.
 */
export async function fillAppleCompanionPath(
  libraryId: ObjectId,
  mapleId: string,
  slot: AppleCompanionSlot,
  relPath: string,
  dbOverride?: SqliteDb,
): Promise<UpdateOutcome> {
  return await writeAppleCompanionPath(
    libraryId,
    mapleId,
    slot,
    relPath,
    `AND a.${slot} IS NULL`,
    dbOverride,
  );
}

async function writeAppleCompanionPath(
  libraryId: ObjectId,
  mapleId: string,
  slot: AppleCompanionSlot,
  relPath: string,
  slotCondition: string,
  dbOverride?: SqliteDb,
): Promise<UpdateOutcome> {
  const result = await sqliteDb(dbOverride).write(
    `UPDATE assets SET ${slot} = ?
      WHERE id = (SELECT a.id FROM assets a
                   WHERE a.maple_id = ? ${slotCondition}
                     AND EXISTS (SELECT 1 FROM asset_locations l
                                  WHERE l.asset_id = a.id AND l.library_id = ?)
                   LIMIT 1)`,
    [relPath, mapleId, toHex(libraryId)],
  );
  return updateOutcome(matchedOne(result.changes));
}
