/**
 * What a pipeline stage's handler writes, as statements (#3787).
 *
 * On MongoDB a stage handler returned `{ patch }` as a map of document fields
 * and the runner folded it into its own `$set`, so one document write carried
 * both the handler's output and the runner's bookkeeping. The fields now live in
 * three tables — `assets` for the EXIF payload, `asset_detail` for the
 * transcript, `asset_search` for the synthesised blob — so the equivalent is a
 * short list of statements the runner commits in the same transaction as the
 * `stage_state` row (`./stage-writeback.ts`). The atomicity the `$set` gave is
 * preserved; what changes is that the handler has to name its table.
 *
 * They live here, beside the tables, rather than inline in each stage module,
 * for the rule the cutover exists to enforce: SQL belongs to a repository. A
 * stage file is filesystem and decode logic, and the moment one of them spells
 * an `UPDATE assets` inline the schema has two owners.
 *
 * Every statement here is deliberately *not* about `stage_state`. The runner
 * owns that row and writes it in the same transaction; `stageSuccessStatements`
 * rejects a handler that tries (`assertNoStageState`).
 */

import type { SqlStatement } from '../protocol.ts';
import type { AssetExif, TranscriptDoc } from '../../schema.ts';

/**
 * The EXIF stage's output: the parsed payload, the screenshot heuristic, and —
 * when a capture date let it derive the primary-form id — the upgraded
 * `maple_id`.
 *
 * `maple_id` is bound conditionally rather than written as NULL when absent,
 * because the fallback id already on the row is a real value the discover
 * watcher wrote; blanking it would lose the dedup key for every asset whose
 * EXIF carries no `DateTimeOriginal`.
 */
export function exifPatchStatements(
  assetId: string,
  patch: { exif: AssetExif | null; isScreenshot: boolean; mapleId?: string },
): SqlStatement[] {
  const columns = ['exif = ?', 'is_screenshot = ?'];
  const params: (string | number | null)[] = [
    patch.exif === null ? null : JSON.stringify(patch.exif),
    patch.isScreenshot ? 1 : 0,
  ];
  if (patch.mapleId !== undefined) {
    columns.push('maple_id = ?');
    params.push(patch.mapleId);
  }
  return [
    { sql: `UPDATE assets SET ${columns.join(', ')} WHERE id = ?`, params: [...params, assetId] },
  ];
}

const SEARCH_BLOB_UPSERT_SQL = `
  INSERT INTO asset_search (asset_id, search_blob) VALUES (?, ?)
  ON CONFLICT (asset_id) DO UPDATE SET search_blob = excluded.search_blob`;

const SEARCH_BLOB_DELETE_SQL = `DELETE FROM asset_search WHERE asset_id = ?`;

/**
 * The search stage's output: the recomposed blob, and the fingerprint recording
 * which embedder produced the vectors now in Meilisearch.
 *
 * An empty blob is a delete rather than an update to `''`. `asset_search` holds
 * a row only for an asset with something to match — the `CHECK (search_blob <>
 * '')` in the DDL is the partial filter the Mongo text index spelled out — and
 * the FTS5 index is external-content over this table, so a blank row would be a
 * posting list entry for nothing.
 */
export function searchBlobStatements(
  assetId: string,
  blob: string,
  semanticFingerprint: string | null,
): SqlStatement[] {
  const blobStatement: SqlStatement =
    blob === ''
      ? { sql: SEARCH_BLOB_DELETE_SQL, params: [assetId] }
      : { sql: SEARCH_BLOB_UPSERT_SQL, params: [assetId, blob] };
  if (semanticFingerprint === null) return [blobStatement];
  return [
    blobStatement,
    {
      sql: `UPDATE assets SET semantic_vector_fingerprint = ? WHERE id = ?`,
      params: [semanticFingerprint, assetId],
    },
  ];
}

/**
 * The transcribe stage's output.
 *
 * `SELECT … FROM assets WHERE id = ?` as the insert's source rather than a bare
 * `VALUES`: an asset deleted between the claim and the writeback would otherwise
 * fail the foreign key and roll back the runner's whole batch, where the Mongo
 * `updateOne` on a missing `_id` was a no-op. Every statement a handler hands
 * the runner has to degrade that way, because one asset's writeback must not
 * take the tick's other assets down with it.
 */
export function transcriptStatement(assetId: string, transcript: TranscriptDoc): SqlStatement {
  return {
    sql: `INSERT INTO asset_detail (asset_id, transcript)
          SELECT id, json(?) FROM assets WHERE id = ?
          ON CONFLICT (asset_id) DO UPDATE SET transcript = excluded.transcript`,
    params: [JSON.stringify(transcript), assetId],
  };
}
