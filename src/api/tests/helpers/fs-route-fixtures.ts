/**
 * Fixtures for the filesystem-addressed route suites, against SQLite (#3787).
 *
 * `/api/fs/dir`, `/api/folders/:id/file`, `/api/folders/:id/trash` and
 * `/api/xmp?path=` all answer questions about files that are really on disk,
 * so each of these suites writes into its own tmp directory and registers that
 * directory as a library root. What they need from the database is small and
 * identical: an asset row plus the one `asset_locations` row that says where
 * the file lives, so `assetAbsPath()` can rebuild the absolute path the
 * listing matched against.
 *
 * `db/sqlite/test-sqlite.test-helpers.ts` already has `insertFolder` (the
 * library root) and `insertAsset`/`insertLocation` as separate calls. This
 * wraps the pair, because every one of these suites wants them together, and
 * adds the three columns the trash list reads and `insertAsset` does not
 * expose: `size`, `mtime`, and the soft-delete trio
 * (`deleted_at` / `deleted_reason` / `original_path`).
 */

import type { Database } from 'bun:sqlite';
import { newObjectIdHex } from '../../src/db/sqlite/object-id.ts';
import { run } from '../../src/db/sqlite/test-sqlite.test-helpers.ts';

export interface IndexedAssetOptions {
  /** Hex id of the `folders` row this file lives under. */
  libraryId: string;
  /** Basename, as it appears on disk. */
  filename: string;
  /** Directory relative to the library root, POSIX-separated. `''` at the root. */
  path?: string;
  /** Pin the asset id, when an assertion has to name it up front. */
  id?: string;
  size?: number;
  /** Epoch milliseconds, matching `fs.stat().mtimeMs`. */
  mtime?: number;
  /** Serialised `AssetExif`; the column is `CHECK (json_valid(exif))`. */
  exif?: string | null;
  /** ISO-8601 timestamp for a soft-deleted asset. */
  deletedAt?: string | null;
  /** `'reaped'` for a watcher-removed row, which has no restorable copy. */
  deletedReason?: 'reaped' | null;
  /** Absolute path the file was trashed from — what Trash restores to. */
  originalPath?: string | null;
}

/**
 * One indexed asset with a single live location, and its id.
 *
 * `live_location_count` is left alone: the `asset_locations` triggers maintain
 * it, exactly as they do in production.
 */
export function seedIndexedAsset(db: Database, options: IndexedAssetOptions): string {
  const id = options.id ?? newObjectIdHex();
  run(
    db,
    `INSERT INTO assets
       (id, size, mtime, indexed_at, exif, deleted_at, deleted_reason, original_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    options.size ?? 3,
    options.mtime ?? Date.now(),
    new Date().toISOString(),
    options.exif ?? null,
    options.deletedAt ?? null,
    options.deletedReason ?? null,
    options.originalPath ?? null,
  );
  run(
    db,
    `INSERT INTO asset_locations (asset_id, ordinal, library_id, path, filename)
     VALUES (?, 0, ?, ?, ?)`,
    id,
    options.libraryId,
    options.path ?? '',
    options.filename,
  );
  return id;
}
