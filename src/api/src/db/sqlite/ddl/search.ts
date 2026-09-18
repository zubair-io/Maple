/**
 * `asset_search` + `assets_fts` — full-text search over the synthesised
 * `search_blob`.
 *
 * `search_blob` is the concatenation of the place blob, the caption and the
 * OCR text, recomputed inside each worker's `complete()` so it stays consistent
 * without a separate write. On Mongo it carries the collection's one permitted
 * text index, `search_blob_text`, partial over live rows with a non-empty blob.
 *
 * Two things change here.
 *
 * The blob moves off the asset row. It is the largest text an asset carries
 * after the vision payload and nothing but search reads it, so leaving it on
 * `assets` would undo the narrowness the rest of the schema is built for. A row
 * exists only when an asset has a non-empty blob, which is the partial filter
 * the Mongo index spelled out.
 *
 * The index becomes FTS5 in external-content mode. `content='asset_search'`
 * means FTS5 stores only its inverted index and reads column values back from
 * `asset_search`, so the text is stored once rather than twice. In exchange the
 * two must be kept in step by hand, which is what the triggers below are for —
 * that is the documented and only supported way to use external content.
 *
 * Ranking: `bm25(assets_fts)` replaces `{ $meta: 'textScore' }`. The `porter`
 * tokenizer gives the English stemming the Mongo index got from
 * `default_language: 'english'`, and `unicode61` folds accents and case.
 */

export const ASSET_SEARCH_TABLE_DDL = `
CREATE TABLE asset_search (
  -- Explicit rowid alias: FTS5 external content joins on an INTEGER rowid, so
  -- this is one of the internal tables that keeps one.
  rowid INTEGER PRIMARY KEY,

  asset_id    TEXT NOT NULL UNIQUE REFERENCES assets (id) ON DELETE CASCADE,
  search_blob TEXT NOT NULL CHECK (search_blob <> '')
);

CREATE VIRTUAL TABLE assets_fts USING fts5(
  search_blob,
  content = 'asset_search',
  content_rowid = 'rowid',
  tokenize = 'porter unicode61'
);
`;

/**
 * Keeps the FTS5 index in step with `asset_search`.
 *
 * External-content FTS5 does not observe its content table on its own. The
 * delete form — inserting into the table's own name with the `'delete'`
 * command and the OLD text — is how FTS5 is told to retract postings it can no
 * longer read back.
 *
 * Exported separately so the importer can drop them, bulk-load `asset_search`,
 * and then run {@link ASSETS_FTS_REBUILD_SQL} once, which is far cheaper than
 * maintaining the index a row at a time across a whole library.
 */
export const ASSET_SEARCH_TRIGGER_DDL = `
CREATE TRIGGER asset_search_fts_ai AFTER INSERT ON asset_search
BEGIN
  INSERT INTO assets_fts (rowid, search_blob) VALUES (NEW.rowid, NEW.search_blob);
END;

CREATE TRIGGER asset_search_fts_ad AFTER DELETE ON asset_search
BEGIN
  INSERT INTO assets_fts (assets_fts, rowid, search_blob)
  VALUES ('delete', OLD.rowid, OLD.search_blob);
END;

CREATE TRIGGER asset_search_fts_au AFTER UPDATE ON asset_search
BEGIN
  INSERT INTO assets_fts (assets_fts, rowid, search_blob)
  VALUES ('delete', OLD.rowid, OLD.search_blob);
  INSERT INTO assets_fts (rowid, search_blob) VALUES (NEW.rowid, NEW.search_blob);
END;
`;

/** Names of the triggers above, so the importer can drop them by name. */
export const ASSET_SEARCH_TRIGGER_NAMES = [
  'asset_search_fts_ai',
  'asset_search_fts_ad',
  'asset_search_fts_au',
] as const;

/** Rebuilds the whole inverted index from `asset_search`. */
export const ASSETS_FTS_REBUILD_SQL = `INSERT INTO assets_fts (assets_fts) VALUES ('rebuild');`;

/**
 * Merges the FTS5 b-tree into fewer, larger segments. Worth running once after
 * a bulk import; the incremental writes of normal operation do not need it.
 */
export const ASSETS_FTS_OPTIMIZE_SQL = `INSERT INTO assets_fts (assets_fts) VALUES ('optimize');`;
