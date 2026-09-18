/**
 * Row shapes for `people` and `faces`, and the conversions back to the
 * documents the people API already ships (#3749).
 *
 * `PersonDoc` is imported rather than redeclared, so "the ported repo returns
 * the same document" is a type error when it stops being true rather than
 * something a reviewer has to diff by eye. What changes is only where each
 * field comes from: a column, a flattened bbox, or a JSON payload.
 *
 * ## Absent is not the same as null
 *
 * Almost every field on `PersonDoc` is optional, and `JSON.stringify` drops an
 * absent key while it emits an explicit `null`. A client that tests for the
 * presence of `cover_asset_id` rather than its value would see a behaviour
 * change if this layer nulled everything it does not have, so optional fields
 * are omitted exactly where the Mongo documents omitted them. The columns are
 * nullable and the conversion adds a key only when the column has a value.
 *
 * The exceptions are the three fields the Mongo repo writes as an explicit
 * `null`: `merged_into`, `suggested_merge_person_id` and `suggested_merge_score`
 * are always present, because `createPerson` sets `merged_into: null` on insert
 * and the clustering pass clears the suggestion head to `null` rather than
 * unsetting it.
 *
 * ## There is no `face_count`
 *
 * The schema has no such column and this module produces no such field. A
 * person's live face count is derived from `faces` at read time — see
 * `people.face-count.ts` for why that is now cheap enough to do.
 */

import { ObjectId } from 'mongodb';
import type { AssetFaceDoc, Bbox, PersonDoc, PersonWithId } from '../../schema.ts';
import { bool, json } from './assets.rows.ts';

/** One `people` row, exactly as the columns come back. */
export interface PersonRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  cover_asset_id: string | null;
  cover_bbox_x: number | null;
  cover_bbox_y: number | null;
  cover_bbox_w: number | null;
  cover_bbox_h: number | null;
  merged_into: string | null;
  hidden: number;
  excluded: number;
  centroid: string | null;
  centroid_face_count: number | null;
  suggested_merge_person_id: string | null;
  suggested_merge_score: number | null;
  suggested_merges: string | null;
}

/** One `faces` row. Carries the asset it hangs off, which the array did not. */
export interface PersonFaceRow {
  asset_id: string;
  face_index: number;
  person_id: string | null;
  confidence: number;
  bbox_x: number;
  bbox_y: number;
  bbox_w: number;
  bbox_h: number;
  hidden: number;
  landmarks: string | null;
  embedding: string | null;
  embedding_version: string | null;
}

/** The stored form of one ranked merge candidate. */
interface SuggestedMergeJson {
  person_id: string;
  score: number;
}

/** The four flattened bbox columns as a `Bbox`, or null when unset. */
export function toBbox(
  x: number | null,
  y: number | null,
  w: number | null,
  h: number | null,
): Bbox | null {
  if (x === null || y === null || w === null || h === null) return null;
  return { x, y, w, h };
}

/**
 * One `people` row as the document the routes already serialise.
 *
 * Built as a single object literal with conditional spreads rather than a base
 * object mutated through successive `if`s: an optional field is present exactly
 * when its column is, and the rule is visible in one place instead of spread
 * across eight statements.
 */
export function toPerson(row: PersonRow): PersonWithId {
  const cover = toBbox(row.cover_bbox_x, row.cover_bbox_y, row.cover_bbox_w, row.cover_bbox_h);
  const centroid = json<number[]>(row.centroid);
  const ranked = json<SuggestedMergeJson[]>(row.suggested_merges);
  const doc: PersonDoc = {
    name: row.name,
    created_at: row.created_at,
    updated_at: row.updated_at,
    merged_into: row.merged_into === null ? null : new ObjectId(row.merged_into),
    suggested_merge_person_id:
      row.suggested_merge_person_id === null ? null : new ObjectId(row.suggested_merge_person_id),
    suggested_merge_score: row.suggested_merge_score,
    ...(row.cover_asset_id === null ? {} : { cover_asset_id: row.cover_asset_id }),
    ...(cover === null ? {} : { cover_bbox: cover }),
    ...(centroid === null ? {} : { centroid }),
    ...(row.centroid_face_count === null ? {} : { centroid_face_count: row.centroid_face_count }),
    ...(bool(row.hidden) ? { hidden: true } : {}),
    ...(bool(row.excluded) ? { excluded: true } : {}),
    ...(ranked === null
      ? {}
      : {
          suggested_merges: ranked.map((entry) => ({
            person_id: new ObjectId(entry.person_id),
            score: entry.score,
          })),
        }),
  };
  return { _id: new ObjectId(row.id), ...doc } as PersonWithId;
}

/**
 * One `faces` row as the subdocument `readFaces` used to return straight out of
 * the asset. Optional fields are omitted where the array entries omitted them.
 */
export function toAssetFace(row: PersonFaceRow): AssetFaceDoc {
  const landmarks = json<Array<{ x: number; y: number }>>(row.landmarks);
  const embedding = json<number[]>(row.embedding);
  return {
    bbox: { x: row.bbox_x, y: row.bbox_y, w: row.bbox_w, h: row.bbox_h },
    person_id: row.person_id,
    confidence: row.confidence,
    ...(landmarks === null ? {} : { landmarks }),
    ...(embedding === null ? {} : { embedding }),
    ...(row.embedding_version === null ? {} : { embedding_version: row.embedding_version }),
    ...(bool(row.hidden) ? { hidden: true } : {}),
  };
}

/**
 * The ranked merge candidates for a person, newest write first, as plain hex
 * strings.
 *
 * Falls back to a one-element list built from the denormalised head when the
 * ranked column was never written — rows predating the ranked list carry only
 * `suggested_merge_person_id` / `_score`, and both the banner and the dismiss
 * route have to keep working on them.
 */
export function rankedCandidates(person: PersonWithId): Array<{ hex: string; score: number }> {
  const ranked = person.suggested_merges;
  if (ranked && ranked.length > 0) {
    return ranked.map((entry) => ({ hex: entry.person_id.toHexString(), score: entry.score }));
  }
  const head = person.suggested_merge_person_id;
  const score = person.suggested_merge_score;
  if (!head || score === null || score === undefined) return [];
  return [{ hex: head.toHexString(), score }];
}

/** The JSON text for a `suggested_merges` column, or null for "no candidates". */
export function suggestedMergesJson(
  candidates: ReadonlyArray<{ hex: string; score: number }>,
): string | null {
  if (candidates.length === 0) return null;
  return JSON.stringify(
    candidates.map((candidate) => ({ person_id: candidate.hex, score: candidate.score })),
  );
}
