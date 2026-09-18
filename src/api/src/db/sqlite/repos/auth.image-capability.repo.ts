/**
 * `image_access_tokens` — the SQLite port of the storage half of
 * `auth/image-capability.ts` (#3751).
 *
 * An image capability is a short-lived bearer substitute that authorises one
 * exact URL rather than one principal: a 43-character opaque token in
 * `?token=`, good for a GET, on one path, under `/api/thumb/` or
 * `/api/preview/`. It exists so an `<img src>` can carry its own authorisation
 * without a cookie or a header.
 *
 * The row stores `sha256(token)` as its key and never the token, so a database
 * read cannot mint one.
 *
 * ## Two things a reviewer should know rather than discover
 *
 * **The table's shape changed.** The initial schema (#3743) modelled this
 * table from its name — a 24-character hex id, a `token_hash` column and a
 * `user_id` foreign key. The document the code writes has none of those: the
 * `_id` *is* the 64-character hash, and it carries the bound `path` and a
 * `purpose` discriminator instead of naming a user. Migration `0002` rebuilds
 * the table to match; see `../ddl/settings.ts`.
 *
 * **Nothing issues one.** `verifyImageCapability` is the only code in the
 * repository that touches this collection — there is no route, worker or
 * helper that writes a row, so the check can only ever fail. The verification
 * path is ported here faithfully rather than quietly dropped, because deciding
 * whether the feature should be finished or removed is a product question and
 * not this port's to answer. {@link issueImageCapability} exists because the
 * table needs a writer for its own tests, and it is the exact write the
 * document shape implies.
 */

import { createHash } from 'node:crypto';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { nowIso } from './values.ts';

export type { SqliteDb } from './db-handle.ts';

/** The only purpose the schema admits today. */
const PURPOSE = 'image-read';

/** What a capability authorises: one path, until one instant. */
export interface ImageCapability {
  path: string;
  created_at: string;
  expires_at: string;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Whether a live capability exists for this token on this exact path.
 *
 * All four conditions are in the `WHERE` clause, the same way they were in the
 * Mongo filter, so an expired grant is not merely rejected afterwards — it is
 * never selected. The path match is exact: a capability minted for one
 * thumbnail cannot read another.
 */
export async function imageCapabilityIsValid(
  token: string,
  path: string,
  dbOverride?: SqliteDb,
): Promise<boolean> {
  const rows = await sqliteDb(dbOverride).read<{ present: number }>(
    `SELECT 1 AS present FROM image_access_tokens
      WHERE id = ? AND path = ? AND purpose = ? AND expires_at > ?
      LIMIT 1`,
    [hashToken(token), path, PURPOSE, nowIso()],
  );
  return rows.length > 0;
}

/**
 * Store a capability for one path, expiring at `expiresAt`.
 *
 * Only the token's hash is persisted, so the caller keeps the single copy of
 * the token it hands out. A re-grant for the same token replaces the row
 * rather than failing, which is what the Mongo primary key would have done for
 * an upsert on the same `_id`.
 */
export async function issueImageCapability(
  token: string,
  path: string,
  expiresAt: Date,
  dbOverride?: SqliteDb,
): Promise<void> {
  await sqliteDb(dbOverride).write(
    `INSERT INTO image_access_tokens (id, path, purpose, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE
        SET path = excluded.path, expires_at = excluded.expires_at`,
    [hashToken(token), path, PURPOSE, nowIso(), expiresAt.toISOString()],
  );
}
