import { assetsDb, type SqliteDb } from './db-handle.ts';
import { encodeVector } from '../../enrichment/ollama-embed-client.ts';
import type { SqlStatement } from '../sqlite/protocol.ts';

import { EMBED_STAGE } from './assets.stage-rearm.ts';

export interface AssetVectorRecord {
  mapleId: string;
  version: number;
  model: string;
  endpoint: string;
  vector: Float32Array;
  embeddedAt: Date;
}

/**
 * With `claimedBy`, the write lands only while that asset's `embed` row still holds exactly this
 * claim token. A re-arm clears the claim and a re-claim stamps a new one, so a vector computed from
 * text that has since changed is dropped instead of overwriting the row the next run will fill.
 */
export function upsertAssetVectorStatement(
  record: AssetVectorRecord,
  claimedBy?: { assetId: string; lease: string },
): SqlStatement {
  const claimHeld = claimedBy
    ? `WHERE EXISTS (SELECT 1 FROM stage_claim_leases
                      WHERE asset_id = ? AND stage = '${EMBED_STAGE}' AND claim_token = ?)`
    : 'WHERE true';
  return {
    sql: `INSERT INTO asset_vectors (maple_id, version, model, endpoint, dims, vector, embedded_at)
          SELECT ?, ?, ?, ?, ?, ?, ? ${claimHeld}
          ON CONFLICT (maple_id) DO UPDATE SET
            version = excluded.version, model = excluded.model, endpoint = excluded.endpoint, dims = excluded.dims,
            vector = excluded.vector, embedded_at = excluded.embedded_at`,
    params: [
      record.mapleId,
      record.version,
      record.model,
      record.endpoint,
      record.vector.length,
      encodeVector(record.vector),
      record.embeddedAt.toISOString(),
      ...(claimedBy ? [claimedBy.assetId, claimedBy.lease] : []),
    ],
  };
}

/**
 * Re-arms `embed` for every asset whose stored vector came from a different model or endpoint, so a
 * model or endpoint change re-embeds the library. With `includeDead`, assets that exhausted their retries are
 * re-armed too, because they failed under the previous endpoint or model and have no vector to
 * compare. Returns how many assets were re-armed.
 */
export async function rearmEmbedForEmbedderChange(
  current: { model: string; url: string },
  options: { includeDead: boolean },
  dbOverride?: SqliteDb,
): Promise<number> {
  const result = await assetsDb(dbOverride).write(
    `UPDATE stage_state
        SET version = 0, attempts = 0, last_error = NULL, processed_at = NULL, dead = 0,
            next_attempt_at = NULL, claim_token = NULL
      WHERE stage = ?
        AND ((version > 0 AND asset_id IN (
              SELECT a.id FROM asset_vectors v JOIN assets a ON a.maple_id = v.maple_id
               WHERE v.model <> ? OR v.endpoint <> ?))
             OR (? = 1 AND dead = 1))`,
    [EMBED_STAGE, current.model, current.url, options.includeDead ? 1 : 0],
  );
  return result.changes;
}
