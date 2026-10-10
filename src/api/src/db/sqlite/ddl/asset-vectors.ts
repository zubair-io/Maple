/**
 * `asset_vectors` — one L2-normalised embedding per asset, written by the `embed` stage.
 *
 * Keyed on `maple_id`, the content identity the search index addresses documents by. It has no
 * foreign key: `assets.maple_id` is unique only through a partial index, which SQLite does not
 * accept as a foreign-key parent.
 *
 * Because there is no foreign key, triggers keep the table in step with `assets`: a deleted asset
 * takes its vector with it, and an asset whose `maple_id` changes (a dedup merge promoting the
 * survivor) loses the stale vector and is re-armed for `embed`.
 *
 * `version` is the embedder template shape the text was rendered with, and `model` with `endpoint`
 * identify the embedding space, so a vector can be recognised as stale after either changes. `vector` is `dims`
 * little-endian f32 values.
 */
export const ASSET_VECTORS_TABLE_DDL = `
CREATE TABLE asset_vectors (
  maple_id    TEXT PRIMARY KEY,
  version     INTEGER NOT NULL,
  model       TEXT NOT NULL,
  endpoint    TEXT NOT NULL,
  dims        INTEGER NOT NULL CHECK (dims > 0),
  vector      BLOB NOT NULL CHECK (length(vector) = dims * 4),
  embedded_at TEXT NOT NULL
);
`;

export const ASSET_VECTORS_INDEX_DDL = `
CREATE INDEX asset_vectors_embedder ON asset_vectors (model, endpoint);
`;

// A read-only window onto stage claims: the runner rejects handler statements that name stage_state.
export const STAGE_CLAIM_LEASES_VIEW_DDL = `
CREATE VIEW stage_claim_leases AS
  SELECT asset_id, stage, next_attempt_at, claim_token FROM stage_state;
`;

export const ASSET_VECTORS_TRIGGER_DDL = `
CREATE TRIGGER asset_vectors_asset_deleted AFTER DELETE ON assets
WHEN OLD.maple_id IS NOT NULL
BEGIN
  DELETE FROM asset_vectors WHERE maple_id = OLD.maple_id;
END;

CREATE TRIGGER asset_vectors_maple_id_changed AFTER UPDATE OF maple_id ON assets
WHEN OLD.maple_id IS NOT NULL AND OLD.maple_id IS NOT NEW.maple_id
BEGIN
  DELETE FROM asset_vectors WHERE maple_id = OLD.maple_id;
  UPDATE stage_state
     SET version = 0, attempts = 0, last_error = NULL, processed_at = NULL, dead = 0,
         next_attempt_at = NULL, claim_token = NULL
   WHERE asset_id = NEW.id AND stage = 'embed';
END;
`;

const RESET_SET = `version = 0, attempts = 0, last_error = NULL, processed_at = NULL, dead = 0,
         next_attempt_at = NULL, claim_token = NULL`;

function rearmAssetStages(assetIdExpr: string): string {
  return ['meili', 'embed']
    .map(
      (
        stage,
      ) => `INSERT INTO stage_state (asset_id, stage, version, attempts, last_error, processed_at, dead)
  SELECT id, '${stage}', 0, 0, NULL, NULL, 0 FROM assets WHERE id = ${assetIdExpr}
  ON CONFLICT (asset_id, stage) DO UPDATE SET ${RESET_SET};`,
    )
    .join('\n  ');
}

function rearmPersonAssetStages(personIdExpr: string): string {
  return ['meili', 'embed']
    .map(
      (
        stage,
      ) => `INSERT INTO stage_state (asset_id, stage, version, attempts, last_error, processed_at, dead)
  SELECT DISTINCT asset_id, '${stage}', 0, 0, NULL, NULL, 0 FROM faces WHERE person_id = ${personIdExpr}
  ON CONFLICT (asset_id, stage) DO UPDATE SET ${RESET_SET};`,
    )
    .join('\n  ');
}

/**
 * The searchable text names the people on an asset, so every change to which person a face
 * belongs to, or to a person's indexable identity, re-queues `meili` and `embed` for the affected
 * assets. Triggers cover every writer (face detect, clustering, assign, hide, merge, purge,
 * rename, visibility) instead of each path remembering to. Unrelated columns (a face's bbox, a
 * person's cover) re-queue nothing.
 */
export const SEARCH_TEXT_TRIGGER_DDL = `
CREATE TRIGGER faces_search_inserted AFTER INSERT ON faces
WHEN NEW.person_id IS NOT NULL
BEGIN
  ${rearmAssetStages('NEW.asset_id')}
END;

CREATE TRIGGER faces_search_deleted AFTER DELETE ON faces
WHEN OLD.person_id IS NOT NULL
BEGIN
  ${rearmAssetStages('OLD.asset_id')}
END;

CREATE TRIGGER faces_search_reassigned AFTER UPDATE OF person_id ON faces
WHEN OLD.person_id IS NOT NEW.person_id
BEGIN
  ${rearmAssetStages('NEW.asset_id')}
END;

CREATE TRIGGER people_search_changed AFTER UPDATE OF name, merged_into, hidden, excluded ON people
WHEN OLD.name IS NOT NEW.name OR OLD.merged_into IS NOT NEW.merged_into
  OR OLD.hidden IS NOT NEW.hidden OR OLD.excluded IS NOT NEW.excluded
BEGIN
  ${rearmPersonAssetStages('NEW.id')}
END;
`;

export const STAGE_CLAIM_TOKEN_DDL = `
ALTER TABLE stage_state ADD COLUMN claim_token TEXT;
`;
