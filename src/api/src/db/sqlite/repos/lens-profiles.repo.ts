/**
 * `lens_profiles` — the SQLite port of the GridFS bucket behind
 * `lens-profiles/cache.ts` (#3787).
 *
 * One row per imported .lcp, keyed by the BLAKE3 digest of its own bytes. The
 * digest is what an XMP sidecar's `lcp1:<hex>` reference names, so the content
 * addressing is the caller's, not this module's invention — which is why there
 * is no update verb here. A profile with a given digest either exists or does
 * not; its bytes can never legitimately change.
 *
 * ## What stayed in the caller
 *
 * Digest verification, the 32 MiB bound and the in-process byte cache all live
 * in `lens-profiles/cache.ts`. None of them is a property of the table: the
 * first two are the integrity contract the FFI core imposes on a profile, and
 * the third is a decision about the render hot path. This module stores bytes
 * and hands them back.
 */

import type { SqliteDb } from './db-handle.ts';
import { sqliteDb } from './db-handle.ts';

export type { SqliteDb } from './db-handle.ts';

/**
 * Store a profile, or do nothing when one with this digest is already held.
 *
 * `DO NOTHING` rather than an existence check followed by an insert: two
 * operators importing the same .lcp at the same moment both find nothing and
 * both insert, and on MongoDB that race was open between the `find` and the
 * upload stream. Here the conflict is resolved inside the statement, and since
 * the digest addresses the content the loser's bytes were identical anyway.
 *
 * Returns whether this call was the one that stored it, which the caller uses
 * only to keep its own cache honest.
 */
export async function saveLensProfileBytes(
  digest: string,
  bytes: Uint8Array,
  inventory: unknown,
  dbOverride?: SqliteDb,
): Promise<boolean> {
  const result = await sqliteDb(dbOverride).write(
    `INSERT INTO lens_profiles (digest, bytes, inventory) VALUES (?, ?, ?)
     ON CONFLICT (digest) DO NOTHING`,
    [digest, bytes, JSON.stringify(inventory)],
  );
  return result.changes === 1;
}

/**
 * A stored profile's bytes, or `null` when this server holds no such profile.
 *
 * `null` is an ordinary answer rather than an error: an XMP can reference a
 * profile imported on a different install, and the route turns that into a 404
 * telling the user to import the original.
 *
 * `bun:sqlite` hands a BLOB column back as a `Uint8Array`, and the pool's
 * structured clone preserves it, so no encoding step sits between the column
 * and the FFI call that consumes it.
 */
export async function readLensProfileBytes(
  digest: string,
  dbOverride?: SqliteDb,
): Promise<Uint8Array | null> {
  const rows = await sqliteDb(dbOverride).read<{ bytes: Uint8Array }>(
    `SELECT bytes FROM lens_profiles WHERE digest = ?`,
    [digest],
  );
  return rows[0]?.bytes ?? null;
}
