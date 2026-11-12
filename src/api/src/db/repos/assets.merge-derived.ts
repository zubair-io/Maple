/**
 * What a merge hands the survivor beyond its locations (#5090).
 *
 * `mergeIntoSurvivor` deletes the condemned row, and every table that
 * references `assets (id)` with `ON DELETE CASCADE` goes with it. Left alone,
 * that discards the condemned row's Apple Photos links and every piece of
 * derived data the pipeline had already paid for. These statements run inside
 * the merge transaction, before the delete.
 *
 * ## The rule
 *
 * - **Photos links** move to the survivor. A link the survivor already holds
 *   (same device and local id) stays and the duplicate is dropped.
 * - **Derived data** is per group. The survivor keeps whatever it already has;
 *   the condemned row's value is copied only where the survivor has none:
 *   description / OCR / vision (`describe`), transcript and video description,
 *   place (`geocode`), the faces with their embeddings (`face-detect`,
 *   `face-embed`), and the person segmentation. Fields inside `asset_detail`
 *   are filled one group at a time, so a description and its provenance always
 *   come from the same row.
 * - **Stage bookkeeping** follows the data. A group the survivor inherits takes
 *   the condemned row's stage state when that is further along, so the survivor
 *   is not re-queued for work already done; a group it did not inherit is left
 *   untouched, so its own stage run still fills it. When anything was
 *   inherited, `search-blob` is re-armed, because the blob is composed from
 *   that text. (`embed` is re-armed by the `maple_id` change itself.)
 *
 * Not carried: `derivative_audit` (a per-location cooldown), and the condemned
 * row's `asset_search` blob, which the re-armed stage recomposes.
 */

import type { SqlStatement } from '../sqlite/protocol.ts';

type Param = string | number | null;

/** The survivor's `asset_detail` has nothing for any `describe` output. */
const SURVIVOR_LACKS_DESCRIBE = `NOT EXISTS (SELECT 1 FROM asset_detail s WHERE s.asset_id = :survivor
    AND (s.description IS NOT NULL OR s.vision IS NOT NULL OR s.ocr_text IS NOT NULL))`;
const SURVIVOR_LACKS_SPEECH = `NOT EXISTS (SELECT 1 FROM asset_detail s WHERE s.asset_id = :survivor
    AND (s.transcript IS NOT NULL OR s.video_description IS NOT NULL))`;
const SURVIVOR_LACKS_FACES = `NOT EXISTS (SELECT 1 FROM faces WHERE asset_id = :survivor)`;
const SURVIVOR_LACKS_PLACE = `(SELECT place FROM assets WHERE id = :survivor) IS NULL`;
const SURVIVOR_LACKS_SEGMENTATION = `NOT EXISTS (SELECT 1 FROM person_segmentations WHERE asset_id = :survivor)`;

const CONDEMNED_HAS_DESCRIBE = `EXISTS (SELECT 1 FROM asset_detail c WHERE c.asset_id = :condemned
    AND (c.description IS NOT NULL OR c.vision IS NOT NULL OR c.ocr_text IS NOT NULL))`;
const CONDEMNED_HAS_SPEECH = `EXISTS (SELECT 1 FROM asset_detail c WHERE c.asset_id = :condemned
    AND (c.transcript IS NOT NULL OR c.video_description IS NOT NULL))`;
const CONDEMNED_HAS_FACES = `EXISTS (SELECT 1 FROM faces WHERE asset_id = :condemned)`;
const CONDEMNED_HAS_PLACE = `(SELECT place FROM assets WHERE id = :condemned) IS NOT NULL`;
const CONDEMNED_HAS_SEGMENTATION = `EXISTS (SELECT 1 FROM person_segmentations WHERE asset_id = :condemned)`;

/** One inherited group: when it applies, and the stages whose state it carries. */
interface Group {
  when: string;
  stages: readonly string[];
}

const GROUPS: readonly Group[] = [
  {
    when: `${SURVIVOR_LACKS_DESCRIBE} AND ${CONDEMNED_HAS_DESCRIBE}`,
    stages: ['describe'],
  },
  {
    when: `${SURVIVOR_LACKS_SPEECH} AND ${CONDEMNED_HAS_SPEECH}`,
    stages: ['transcribe', 'video-describe'],
  },
  {
    when: `${SURVIVOR_LACKS_FACES} AND ${CONDEMNED_HAS_FACES}`,
    stages: ['face-detect', 'face-embed'],
  },
  {
    when: `${SURVIVOR_LACKS_PLACE} AND ${CONDEMNED_HAS_PLACE}`,
    stages: ['geocode'],
  },
  {
    when: `${SURVIVOR_LACKS_SEGMENTATION} AND ${CONDEMNED_HAS_SEGMENTATION}`,
    stages: ['person-segmentation'],
  },
];

/** `:survivor` / `:condemned` bound positionally, in order of appearance. */
function bind(sql: string, survivorId: string, condemnedId: string): SqlStatement {
  const params: Param[] = [];
  const positional = sql.replace(/:(survivor|condemned)\b/g, (_, name: string) => {
    params.push(name === 'survivor' ? survivorId : condemnedId);
    return '?';
  });
  return { sql: positional, params };
}

/** The columns of `asset_detail` that carry derived data, grouped so a value and its provenance travel together. */
const DETAIL_GROUPS: readonly (readonly string[])[] = [
  ['description', 'description_meta'],
  ['ocr_text', 'ocr_meta'],
  ['vision', 'vision_meta'],
  ['transcript'],
  ['video_description', 'video_description_meta'],
  ['metadata_override'],
  ['geo_inferred'],
];

const DETAIL_COLUMNS = DETAIL_GROUPS.flat();

/**
 * Statements that move the condemned row's links and derived data onto the
 * survivor. Order matters: the stage-state and re-arm statements read the
 * survivor's state as it was before the data below is copied.
 */
export function inheritDerivedStatements(survivorId: string, condemnedId: string): SqlStatement[] {
  const statements: SqlStatement[] = [];
  const add = (sql: string): void => {
    statements.push(bind(sql, survivorId, condemnedId));
  };

  add(`UPDATE OR IGNORE asset_phasset_links SET asset_id = :survivor WHERE asset_id = :condemned`);

  for (const group of GROUPS) {
    for (const stage of group.stages) {
      const quoted = `'${stage}'`;
      add(`UPDATE stage_state SET
          version = (SELECT c.version FROM stage_state c WHERE c.asset_id = :condemned AND c.stage = ${quoted}),
          attempts = 0, last_error = NULL, failed_at = NULL, dead = 0, next_attempt_at = NULL,
          processed_at = (SELECT c.processed_at FROM stage_state c WHERE c.asset_id = :condemned AND c.stage = ${quoted})
        WHERE asset_id = :survivor AND stage = ${quoted} AND ${group.when}
          AND version < COALESCE((SELECT c.version FROM stage_state c
                                   WHERE c.asset_id = :condemned AND c.stage = ${quoted}), 0)`);
    }
  }

  const anyInherited = GROUPS.map((group) => `(${group.when})`).join(' OR ');
  add(`UPDATE stage_state SET version = 0, attempts = 0, last_error = NULL, failed_at = NULL,
        dead = 0, next_attempt_at = NULL
      WHERE asset_id = :survivor AND stage = 'search-blob' AND (${anyInherited})`);

  add(`UPDATE assets SET place = (SELECT place FROM assets WHERE id = :condemned)
      WHERE id = :survivor AND ${SURVIVOR_LACKS_PLACE} AND ${CONDEMNED_HAS_PLACE}`);

  add(`INSERT INTO asset_detail (asset_id, ${DETAIL_COLUMNS.join(', ')})
      SELECT :survivor, ${DETAIL_COLUMNS.join(', ')} FROM asset_detail
       WHERE asset_id = :condemned
         AND NOT EXISTS (SELECT 1 FROM asset_detail WHERE asset_id = :survivor)`);

  const fills = DETAIL_GROUPS.flatMap((columns) =>
    columns.map(
      (column) =>
        `${column} = CASE WHEN ${columns[0]} IS NULL THEN (SELECT c.${column} FROM asset_detail c WHERE c.asset_id = :condemned) ELSE ${column} END`,
    ),
  );
  add(`UPDATE asset_detail SET ${fills.join(', ')} WHERE asset_id = :survivor
      AND EXISTS (SELECT 1 FROM asset_detail WHERE asset_id = :condemned)`);

  add(`INSERT INTO faces (asset_id, face_index, person_id, confidence, bbox_x, bbox_y, bbox_w,
        bbox_h, hidden, landmarks, embedding, embedding_version)
      SELECT :survivor, face_index, person_id, confidence, bbox_x, bbox_y, bbox_w, bbox_h,
             hidden, landmarks, embedding, embedding_version
        FROM faces WHERE asset_id = :condemned AND ${SURVIVOR_LACKS_FACES}`);

  add(`INSERT INTO person_segmentations (asset_id, model, persons, created_at)
      SELECT :survivor, model, persons, created_at FROM person_segmentations
       WHERE asset_id = :condemned AND ${SURVIVOR_LACKS_SEGMENTATION}`);

  return statements;
}
