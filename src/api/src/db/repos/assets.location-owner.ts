/**
 * Whether a library-relative path is some asset's location (#4695).
 *
 * Compared without case: on a case-insensitive volume `IMG_0001.mov` and an
 * indexed `IMG_0001.MOV` are one file, and a false "owned" only ever means a
 * write picks a suffixed name or a purge leaves a file behind — never that an
 * original is claimed or deleted. Every location state counts; a trashed or
 * missing original is still somebody's file.
 */
import path from 'node:path';
import type { ObjectId } from '../object-id.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { toHex } from './values.ts';

export async function assetOwnsRelPath(
  libraryId: ObjectId,
  relPath: string,
  dbOverride?: SqliteDb,
): Promise<boolean> {
  const posix = relPath.split(path.sep).join('/');
  const dir = path.posix.dirname(posix);
  const rows = await sqliteDb(dbOverride).read<{ found: number }>(
    `SELECT 1 AS found FROM asset_locations
      WHERE library_id = ? AND path = ? COLLATE NOCASE AND filename = ? COLLATE NOCASE
      LIMIT 1`,
    [toHex(libraryId), dir === '.' ? '' : dir, path.posix.basename(posix)],
  );
  return rows.length > 0;
}
