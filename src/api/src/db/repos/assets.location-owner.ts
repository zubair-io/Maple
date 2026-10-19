/**
 * Whether a library-relative path is some asset's location (#4695).
 *
 * The folder is matched exactly, which lets the lookup seek the
 * `(library_id, path, filename)` index instead of scanning the library. The
 * filename is compared in TypeScript with Unicode normalisation and case
 * folding: SQLite's NOCASE folds ASCII only, so on a case-insensitive volume
 * `Ünterwegs.MOV` and `ünterwegs.mov` (or its decomposed spelling) are one
 * file it would call different. A false "owned" only ever means a write picks
 * a suffixed name or a purge leaves a file behind, never that an original is
 * claimed or deleted. Every location state counts; a trashed or missing
 * original is still somebody's file.
 */
import path from 'node:path';
import type { ObjectId } from '../object-id.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { toHex } from './values.ts';

function sameName(a: string, b: string): boolean {
  const left = a.normalize('NFC');
  const right = b.normalize('NFC');
  return left.toLowerCase() === right.toLowerCase() || left.toUpperCase() === right.toUpperCase();
}

export async function assetOwnsRelPath(
  libraryId: ObjectId,
  relPath: string,
  dbOverride?: SqliteDb,
): Promise<boolean> {
  const posix = relPath.split(path.sep).join('/');
  const dir = path.posix.dirname(posix);
  const filename = path.posix.basename(posix);
  const rows = await sqliteDb(dbOverride).read<{ filename: string }>(
    `SELECT filename FROM asset_locations WHERE library_id = ? AND path = ?`,
    [toHex(libraryId), dir === '.' ? '' : dir],
  );
  return rows.some((row) => sameName(row.filename, filename));
}
