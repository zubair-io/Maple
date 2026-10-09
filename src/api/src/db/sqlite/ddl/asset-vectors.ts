/**
 * `asset_vectors` — one L2-normalised embedding per asset, written by the `embed` stage.
 *
 * Keyed on `maple_id`, the content identity the search index addresses documents by. It has no
 * foreign key: `assets.maple_id` is unique only through a partial index, which SQLite does not
 * accept as a foreign-key parent.
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
