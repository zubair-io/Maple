import { assetsDb, type SqliteDb } from './db-handle.ts';
import { encodeVector } from '../../enrichment/ollama-embed-client.ts';
import type { SqlStatement } from '../sqlite/protocol.ts';

export const EMBED_STAGE = 'embed';

export interface AssetVectorRecord {
  mapleId: string;
  version: number;
  model: string;
  vector: Float32Array;
  embeddedAt: Date;
}

export function upsertAssetVectorStatement(record: AssetVectorRecord): SqlStatement {
  return {
    sql: `INSERT INTO asset_vectors (maple_id, version, model, dims, vector, embedded_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (maple_id) DO UPDATE SET
            version = excluded.version, model = excluded.model, dims = excluded.dims,
            vector = excluded.vector, embedded_at = excluded.embedded_at`,
    params: [
      record.mapleId,
      record.version,
      record.model,
      record.vector.length,
      encodeVector(record.vector),
      record.embeddedAt.toISOString(),
    ],
  };
}

/**
 * Re-arms `embed` for every asset whose stored vector came from a different model, so a model
 * change re-embeds the library. Returns how many assets were re-armed.
 */
export async function rearmEmbedForModelChange(
  currentModel: string,
  dbOverride?: SqliteDb,
): Promise<number> {
  const result = await assetsDb(dbOverride).write(
    `UPDATE stage_state
        SET version = 0, attempts = 0, last_error = NULL, processed_at = NULL, dead = 0
      WHERE stage = ?
        AND version > 0
        AND asset_id IN (
          SELECT a.id FROM asset_vectors v JOIN assets a ON a.maple_id = v.maple_id
           WHERE v.model <> ?
        )`,
    [EMBED_STAGE, currentModel],
  );
  return result.changes;
}
