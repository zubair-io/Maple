/**
 * `faces`, `people`, `person_merge_dismissals` — face detections and the
 * cluster identities they are assigned to.
 *
 * `faces[]` is an array of subdocuments on the asset today, so every person
 * query is `$match` → `$unwind` → `$match` again: once to pick the assets with
 * a matching face, once more after unwinding to throw away the OTHER faces on
 * those assets. As rows, "the photos this person is in" is an ordinary join,
 * and "how many faces does this person have" is a count over one index.
 *
 * `face_index` preserves the array position because it is on the wire: the
 * person detail page projects it out of `$unwind … includeArrayIndex:
 * 'face_index'` and clients address a face by it.
 *
 * `embedding` stays JSON. It is a 512-float vector read only by the clustering
 * job, which loads it whole; there is nothing to index and splitting it into
 * rows would be worse in every dimension.
 */

export const FACES_TABLE_DDL = `
CREATE TABLE faces (
  -- Internal identity. Clients address a face as (asset_id, face_index), which
  -- is what the array gave them, so this id never leaves the server.
  id INTEGER PRIMARY KEY,

  asset_id   TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  -- Position in the former faces[] array; on the wire as 'face_index'.
  face_index INTEGER NOT NULL,

  -- Assigned cluster identity, as the 24-character hex of a people row.
  -- Nulled when a face is hidden — the two are written together.
  person_id  TEXT REFERENCES people (id) ON DELETE SET NULL,
  confidence REAL NOT NULL,

  -- Normalised [0,1] proportions of the source image.
  bbox_x REAL NOT NULL,
  bbox_y REAL NOT NULL,
  bbox_w REAL NOT NULL,
  bbox_h REAL NOT NULL,

  -- Operator hid this face: excluded from clustering and from every person
  -- panel.
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),

  -- Five identity-preserving landmarks, and the recognizer's output vector.
  -- Both are read whole by the clustering job and never filtered on.
  landmarks         TEXT CHECK (landmarks IS NULL OR json_valid(landmarks)),
  embedding         TEXT CHECK (embedding IS NULL OR json_valid(embedding)),
  embedding_version TEXT,

  UNIQUE (asset_id, face_index)
);
`;

export const FACES_INDEX_DDL = `
-- "Which assets is this person in", the person detail page, the per-person
-- face count, and the clustering job's dirty-centroid reload. Replaces the
-- multikey assets_face_person_id index, with the hidden filter folded in so
-- the common read is index-only.
CREATE INDEX faces_person
  ON faces (person_id, asset_id)
  WHERE person_id IS NOT NULL AND hidden = 0;

-- The clustering job's unassigned-face sweep, which today leads with an
-- unindexable { faces: { $exists: true, $ne: [] } } scan of the whole
-- collection.
CREATE INDEX faces_unassigned
  ON faces (asset_id)
  WHERE person_id IS NULL AND hidden = 0;
`;

export const PEOPLE_TABLE_DDL = `
CREATE TABLE people (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 24),

  name       TEXT NOT NULL,
  -- The case-insensitive identity of the name, and the only thing uniqueness
  -- is ever checked against. NOT NULL with no default on purpose: a write path
  -- that sets the name without it fails loudly instead of quietly creating a
  -- second person the lookup cannot find. caseFoldKey in db/sqlite mints it.
  name_key   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  -- Cover tile: an ASSET id plus the bbox of the face to crop to.
  cover_asset_id TEXT REFERENCES assets (id) ON DELETE SET NULL,
  cover_bbox_x   REAL,
  cover_bbox_y   REAL,
  cover_bbox_w   REAL,
  cover_bbox_h   REAL,

  -- Survivor of a name-collision merge. Doubles as the soft-delete marker:
  -- a row with this set is excluded from every listing.
  merged_into TEXT REFERENCES people (id) ON DELETE SET NULL,

  -- Operator markers. 'excluded' is strictly stronger than 'hidden' (#2894).
  hidden   INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1)),

  -- No face_count column, by design (#3749). On Mongo the live-face count is a
  -- denormalised field maintained by hand at every membership change — assign,
  -- unassign, hide, merge — plus an authoritative rewrite each clustering pass
  -- whose comment says it exists to heal the drift the incremental sites cause.
  -- The reason it had to be denormalised is that counting meant unwinding the
  -- faces array of every asset. As rows it is one COUNT(*) over faces_person,
  -- joined to assets for liveness, so the count is derived at read time and
  -- there is nothing left to drift. See repos/people.face-count.ts.

  -- Mean of assigned face embeddings, and the count it was computed at.
  centroid            TEXT CHECK (centroid IS NULL OR json_valid(centroid)),
  centroid_face_count INTEGER,

  -- Head of the ranked merge-candidate list, kept denormalised so the badge
  -- and the dismiss route stay O(1).
  suggested_merge_person_id TEXT REFERENCES people (id) ON DELETE SET NULL,
  suggested_merge_score     REAL,
  suggested_merges          TEXT CHECK (suggested_merges IS NULL OR json_valid(suggested_merges))
);
`;

export const PEOPLE_INDEX_DDL = `
-- Name uniqueness is what makes "tag two clusters with the same name" a merge.
-- Built over name_key, not over the name under COLLATE NOCASE: NOCASE folds
-- ASCII A-Z and nothing else, so under it josé and JOSÉ are two names and
-- the merge silently does not happen — which is not what the Mongo collation
-- { locale: 'en', strength: 2 } this replaces does. See db/sqlite/case-fold.ts.
-- Scoped to live rows so a merged-away person does not hold its old name
-- hostage.
CREATE UNIQUE INDEX people_name_unique
  ON people (name_key)
  WHERE merged_into IS NULL;

-- Audit trail walk: "which rows merged into this one".
CREATE INDEX people_merged_into
  ON people (merged_into)
  WHERE merged_into IS NOT NULL;
`;

/**
 * One permanently-dismissed "not a match" pair from the merge-suggestion
 * banner. `pair` is the direction-independent key built by `sortedPairKey`, so
 * it stays a single unique string rather than two ordered columns.
 */
export const PERSON_MERGE_DISMISSALS_DDL = `
CREATE TABLE person_merge_dismissals (
  pair       TEXT NOT NULL PRIMARY KEY,
  created_at TEXT NOT NULL
) WITHOUT ROWID;
`;
