/**
 * What the two face stages write, as statements (#3787).
 *
 * The sibling of `./assets.stage-patches.ts`, split off because it writes a
 * different table. On MongoDB both stages patched one `faces[]` array on the
 * asset document — `face-detect` replaced it wholesale, `face-embed` reached
 * into it by index with `faces.<i>.embedding` paths. As rows, replacing is a
 * delete plus inserts and embedding is an ordinary keyed UPDATE, and the array
 * index survives as the `face_index` column because clients address a face by
 * it (see `db/sqlite/ddl/faces.ts`).
 *
 * Both builders degrade to a no-op when the asset is gone rather than failing a
 * foreign key, for the reason `transcriptStatement` spells out: the runner
 * commits one transaction for a whole tick, so one asset deleted between its
 * claim and its writeback must not take the tick's other assets down with it.
 */

import type { SqlStatement } from '../sqlite/protocol.ts';
import type { AssetFaceDoc } from '../schema.ts';

const DELETE_FACES_SQL = `DELETE FROM faces WHERE asset_id = ?`;

const INSERT_FACE_SQL = `
  INSERT INTO faces
    (asset_id, face_index, person_id, confidence, bbox_x, bbox_y, bbox_w, bbox_h, hidden, landmarks)
  SELECT id, ?, NULL, ?, ?, ?, ?, ?, 0, json(?) FROM assets WHERE id = ?`;

/**
 * The `face-detect` stage's output: this asset's detections, replacing whatever
 * was there.
 *
 * Wholesale replacement, not a merge, and that is the behaviour the Mongo array
 * write had: a re-detect writes new boxes and landmarks, so the old rows'
 * `person_id` assignments — which key off detection geometry — cannot be
 * carried over and are dropped with them. `face-detect`'s own version comment
 * says a re-detect requires a re-cluster for exactly this reason.
 *
 * `embedding` is left NULL rather than bound: it belongs to `face-embed`, which
 * runs after this stage and is gated on it. A detection with no embedding is
 * the normal intermediate state, not a missing value.
 */
export function faceDetectionStatements(
  assetId: string,
  faces: readonly AssetFaceDoc[],
): SqlStatement[] {
  return [
    { sql: DELETE_FACES_SQL, params: [assetId] },
    ...faces.map((face, index) => ({
      sql: INSERT_FACE_SQL,
      params: [
        index,
        face.confidence,
        face.bbox.x,
        face.bbox.y,
        face.bbox.w,
        face.bbox.h,
        JSON.stringify(face.landmarks ?? []),
        assetId,
      ],
    })),
  ];
}

const SET_EMBEDDING_SQL = `
  UPDATE faces SET embedding = json(?), embedding_version = ?
  WHERE asset_id = ? AND face_index = ?`;

/**
 * The `face-embed` stage's output: one recognizer vector per detection, keyed
 * by the position the detector wrote it at.
 *
 * Keyed by `(asset_id, face_index)` rather than by the `faces.id` surrogate,
 * because the handler works from the hydrated `image.faces` array and that pair
 * is the identity the array carries. A face deleted by a concurrent re-detect
 * matches nothing and the statement is a no-op, which is what the Mongo
 * positional `$set` did when the array had shrunk.
 */
export function faceEmbeddingStatements(
  assetId: string,
  embeddings: readonly { faceIndex: number; embedding: readonly number[] }[],
  embeddingVersion: string,
): SqlStatement[] {
  return embeddings.map((entry) => ({
    sql: SET_EMBEDDING_SQL,
    params: [JSON.stringify(entry.embedding), embeddingVersion, assetId, entry.faceIndex],
  }));
}
