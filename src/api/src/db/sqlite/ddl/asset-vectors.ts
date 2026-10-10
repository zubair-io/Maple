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
 * `version` is the embedder template shape the text was rendered with and `model` the embedding
 * model, so a vector can be recognised as stale after either changes. `vector` is `dims`
 * little-endian f32 values.
 */
export const ASSET_VECTORS_TABLE_DDL = `
CREATE TABLE asset_vectors (
  maple_id    TEXT PRIMARY KEY,
  version     INTEGER NOT NULL,
  model       TEXT NOT NULL,
  dims        INTEGER NOT NULL CHECK (dims > 0),
  vector      BLOB NOT NULL CHECK (length(vector) = dims * 4),
  embedded_at TEXT NOT NULL
);
`;

export const ASSET_VECTORS_INDEX_DDL = `
CREATE INDEX asset_vectors_model ON asset_vectors (model);
`;

// A read-only window onto stage claims: the runner rejects handler statements that name stage_state.
export const STAGE_CLAIM_LEASES_VIEW_DDL = `
CREATE VIEW stage_claim_leases AS
  SELECT asset_id, stage, next_attempt_at FROM stage_state;
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
         next_attempt_at = NULL
   WHERE asset_id = NEW.id AND stage = 'embed';
END;
`;
