/**
 * Durable search work for a person mutation (#3969).
 *
 * The reset belongs in the same transaction as the rename, visibility change
 * or face merge. A failed local write must roll back both, because an already
 * renamed person has no later change that would retry a lost work request.
 * Meilisearch itself is contacted later by the worker, never by this mutation.
 *
 * Keep this set-based: renaming somebody with 4,000 photos is one statement,
 * not one writer message per asset. The upsert also creates missing stage rows.
 */

import type { SqlStatement } from '../sqlite/protocol.ts';
import { MEILI_STAGE } from './assets.stage-rearm.ts';
import { placeholders } from './values.ts';

/** Re-arm every asset carrying a face assigned to one of these people. */
export function peopleMeiliRearmStatement(personIds: readonly string[]): SqlStatement {
  return {
    sql: `INSERT INTO stage_state
            (asset_id, stage, version, attempts, last_error, processed_at, dead)
          SELECT DISTINCT asset_id, ?, 0, 0, NULL, NULL, 0
            FROM faces WHERE person_id IN (${placeholders(personIds.length)})
          ON CONFLICT (asset_id, stage) DO UPDATE SET
            version = 0, attempts = 0, last_error = NULL, processed_at = NULL, dead = 0`,
    params: [MEILI_STAGE, ...personIds],
  };
}
