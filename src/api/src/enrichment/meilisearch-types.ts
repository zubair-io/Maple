/**
 * Meilisearch document and search-surface types, extracted from
 * `meilisearch-client.ts` (file budget), same as `meilisearch-filter.ts`
 * before it.
 *
 * These are declaration-only, so this module is a leaf: it imports nothing
 * from the client. That also breaks the `meilisearch-client` ⇄
 * `meilisearch-filter` type cycle those two had while the client owned the
 * declarations.
 */

export type MeilisearchMediaType = 'image' | 'video' | 'audio';

/** Document shape we push to Meilisearch. Mirror of the unified
 * `asset.search_blob` field plus the per-attribute sources so
 * Meilisearch can apply per-field weighting (POI/place metadata typically
 * outranks description prose, which outranks OCR'd UI chrome). */
export interface MeilisearchAssetDoc {
  /** Unique document id. We use the asset's stable `maple_id` so re-upserts
   * are idempotent even after rename/move (the absPath changes; mapleId
   * doesn't). */
  id: string;
  /** Primary filename. Kept as the highest-weight lexical field so exact
   * camera filenames remain strong even when hybrid search is enabled. */
  filename?: string;
  /** Unified text bag — concatenation of `place.search_blob`,
   * `description`, and `ocr_text`. Equivalent to what the Mongo `$text`
   * index covers. */
  searchBlob: string;
  /** LLM-generated caption from the describe worker (Phase 6). Stored
   * separately so per-attribute weighting can favour caption matches.
   * `null`/omitted before the worker has run. */
  description?: string | null;
  /** OCR'd text from the OCR worker (Phase 8). Same per-attribute
   * weighting story as `description`. */
  ocrText?: string | null;
  /** Speech-to-text transcript as PROSE — word order and repetition intact,
   * capped at `MAX_INDEXED_TRANSCRIPT_CHARS`. This is the field that makes a
   * transcript-rich video rank on what was actually said rather than on the
   * alphabetised `searchBlob` bag (#2384). `null` before the transcribe
   * stage has run. */
  transcript?: string | null;
  /** Reverse-geocoded `place.display_name` as prose. NOT `place.search_blob`,
   * which is itself an alphabetised token bag. `null` before geocode. */
  placeText?: string | null;
  /** Folder hex string. Filterable so the route can scope to one library. */
  folderId: string;
  /** ISO timestamp; sortable so the future "search-as-you-type" path can
   * tie-break by recency, and filterable so service callers can constrain to
   * a capture-date window. Meilisearch compares same-typed values, so the
   * range operators below are a lexicographic compare over this ISO string —
   * which is why UTC-normalised, fixed-width formatting matters. Null when
   * EXIF is missing. */
  capturedAt: string | null;
  /** ISO timestamp when the asset was soft-deleted. Filterable so the
   * route can exclude `deletedAt IS NOT NULL`. We keep tombstones in-index
   * by setting this rather than `deleteDocument` so eventual-consistency
   * lag never resurrects a deleted row. */
  deletedAt: string | null;
  /** Closed-union scene classification from `vision.scene_type`. `null` on
   * rows that haven't been through the qwen2.5-vl describe stage yet. */
  visionSceneType?: string | null;
  /** Open-vocab activity tag from `vision.activity`. */
  visionActivity?: string | null;
  /** Open-vocab subject tags from `vision.subjects`. Array filterable so a
   * future meili-side facet path can intersect on subject. */
  visionSubjects?: string[] | null;
  /** Screenshot vs photograph — top-level mirror of `vision.is_screenshot`
   * (or the exif-stage heuristic when describe hasn't run yet). */
  isScreenshot?: boolean | null;
  /** Named people appearing in this asset — `PersonDoc.name`s resolved from
   * `faces[].person_id`, EXCLUDING auto-generated `Person N` clusters and
   * merged rows. Searchable (so "Greyson" matches) and filterable (so an
   * explicit picker can `people IN [...]`). `null`/omitted when the asset
   * has no named people. */
  people?: string[] | null;
  /** Coarse media class for service consumers such as SugarMaple. */
  mediaType?: MeilisearchMediaType;
  /** Effective hidden state. Filtered by default; service callers need an
   * explicit includeHidden=true request to retrieve hidden assets. */
  hidden?: boolean;
}

export interface MeilisearchSearchOptions {
  /** Hex folder id; passed through to Meilisearch's filter syntax. */
  folderId?: string;
  /** Person names to constrain results to (filterable `people IN [...]`).
   * Each value is escaped before injection. */
  people?: string[];
  /** Optional coarse media-type filter. */
  mediaTypes?: MeilisearchMediaType[];
  /** Inclusive UTC lower bound for `capturedAt`, as a full ISO-8601 instant
   * (`YYYY-MM-DDTHH:mm:ss.sssZ`) so it compares like-for-like against the
   * indexed string. */
  capturedFrom?: string;
  /** Exclusive UTC upper bound for `capturedAt`, same format as
   * `capturedFrom`. Exclusive so a caller's inclusive end-date can be
   * expressed as the following midnight without end-of-month special cases. */
  capturedBefore?: string;
  /** Hidden assets are excluded unless explicitly requested. */
  includeHidden?: boolean;
  /** Hidden assets only (`hidden = true`); keeps `hidden=only` pages dense
   * (#2358). Takes precedence over `includeHidden`. */
  onlyHidden?: boolean;
  /** When true, run a hybrid (keyword + vector) query against the managed
   * `caption` embedder. Ignored unless `semanticConfigured()` is true; the
   * route passes `meili.semanticConfigured()` so this is self-gating. */
  semantic?: boolean;
  /** Pagination. Defaults match the search route. */
  offset?: number;
  limit?: number;
}

export interface MeilisearchSearchResult {
  /** Asset ids in Meilisearch's relevance order. The route fetches asset
   * summaries from Mongo with `find({ maple_id: { $in: ids } })` and
   * preserves this order. */
  ids: string[];
  /** Meilisearch's `estimatedTotalHits` — what the route returns as `total`. */
  estimatedTotal: number;
  /** Ranking scores keyed by asset id when the Meilisearch version exposes
   * `_rankingScore`. Older servers omit it and callers return `null`. */
  scores?: Record<string, number>;
}
