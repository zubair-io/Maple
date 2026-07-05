/**
 * Query parsing + Mongo filter construction for `/api/search*`.
 *
 * The HTTP route handlers all share the same query-string schema
 * (`SearchQueryT`) and reuse `buildFilter` to translate that string-bag
 * into a Mongo `Filter<AssetDoc>`. `applyLiveFilter` wraps the result
 * to exclude soft-deleted rows in a way that is safe even when the
 * caller injected `$or`/`$and` clauses.
 *
 * Filter strategy notes:
 *   - For free-text `q`, we use case-insensitive `$regex` against
 *     `fileinfo[].filename` (and a fallback regex against `fileinfo[].path`
 *     via `$or`). Post drop-abs-path-2026-05-21 the canonical filename and
 *     path live on `fileinfo[]` entries; Mongo array-element semantics make
 *     `fileinfo.filename` and `fileinfo.path` predicates match if ANY
 *     entry's value matches — same wire semantics as the old top-level
 *     `filename` / `abs_path` scans. We deliberately do NOT use the
 *     `$text` index here even though one exists: `$text` does not allow
 *     substring matches without word boundaries (e.g. "DJI" wouldn't
 *     match "dji_0001.dng" cleanly), and combining `$text` with the
 *     structured EXIF filters would require `$and` plumbing that the
 *     planner sometimes mis-costs. The text index is still kept for
 *     future ranked search.
 *   - All other filters are exact / range matches on indexed paths
 *     (see `ensureIndexes` in `src/db/client.ts`).
 *   - Default sort `{ "exif.captured_at": -1, _id: 1 }` is stable across
 *     pages — `_id` breaks ties when many assets share the same timestamp
 *     (e.g. burst frames).
 */

import { t } from 'elysia';
import { ObjectId } from 'mongodb';
import type { Filter } from 'mongodb';
import type { AssetDoc } from '../../db/schema.ts';
import { liveFileInfoElemMatch } from '../../indexer/images.repo.ts';
import { parseNlDateRange } from './nl-date.ts';

export const COLOR_LABELS = new Set(['', 'red', 'yellow', 'green', 'blue', 'purple']);

export const SCENE_TYPES = new Set(['indoor', 'outdoor', 'aerial', 'macro', 'studio', 'mixed']);

/** UI scope chip values. `photos` (the default) returns the full live set;
 * the others narrow the result set to assets whose underlying field is
 * non-empty. `albums` has no backing field today — see `list.ts` for the
 * short-circuit + `notImplemented` flag.
 *
 * The set is exported so the route schema and tests share one source of
 * truth and a typo on the wire surfaces as a 400 instead of being silently
 * ignored. */
export const SEARCH_SCOPES = new Set(['photos', 'places', 'people', 'albums']);
export type SearchScope = 'photos' | 'places' | 'people' | 'albums';

export const FLAG_BY_NAME: Record<string, -1 | 0 | 1> = {
  pick: 1,
  none: 0,
  reject: -1,
};

/** Escape a string for use inside a `$regex` pattern. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function clampInt(value: string | undefined, lo: number, hi: number, def: number): number {
  if (value === undefined) return def;
  const n = Number(value);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

export function asNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Bare-date detector: matches `YYYY-MM-DD` with no time component. */
const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Widen a `from` date to the start of the day if no time component is set,
 * so the lexicographic compare against ISO datetimes is correct. */
export function widenFromDate(s: string): string {
  return BARE_DATE.test(s) ? `${s}T00:00:00.000Z` : s;
}

/** Widen a `to` date to the end of the day if no time component is set,
 * so `$lte` includes photos captured on that day. */
export function widenToDate(s: string): string {
  return BARE_DATE.test(s) ? `${s}T23:59:59.999Z` : s;
}

/**
 * Pull a natural-language date out of `placeQuery` and fold it into the
 * structured `from`/`to` fields. Returns a shallow clone of `q` with:
 *   - `from`/`to` intersected with any parsed range (max-of-froms,
 *     min-of-tos so an explicit param always tightens, never loosens), and
 *   - the matched date substring stripped from `placeQuery`.
 *
 * Conservative by construction — `parseNlDateRange` only fires on clear
 * date tokens, so non-date text is returned untouched. Pure; safe to call
 * before `buildFilter`. The `now` argument is injectable for tests.
 */
export function extractDatesFromQuery(q: SearchQuery, now: Date = new Date()): SearchQuery {
  const placeQuery = q.placeQuery;
  if (!placeQuery || placeQuery.trim().length === 0) return q;
  const parsed = parseNlDateRange(placeQuery, now);
  if (!parsed) return q;

  const out: SearchQuery = { ...q };

  // Intersect, comparing the *widened* forms so an explicit param carrying a
  // time component (e.g. `to=2024-06-30T00:00:00Z`) is measured against the
  // parsed bare date on the same scale — a naive lexicographic compare treats
  // the bare date as a prefix and would let it loosen the bound. The tightest
  // bound wins (max-of-froms, min-of-tos); an explicit param can only tighten.
  // Store the normalized value — downstream `widen*Date` is idempotent on it.
  if (parsed.from) {
    const candidate = widenFromDate(parsed.from);
    const explicit = q.from ? widenFromDate(q.from) : undefined;
    out.from = explicit && explicit > candidate ? explicit : candidate;
  }
  if (parsed.to) {
    const candidate = widenToDate(parsed.to);
    const explicit = q.to ? widenToDate(q.to) : undefined;
    out.to = explicit && explicit < candidate ? explicit : candidate;
  }

  // Strip the consumed substring from the residual free-text query, then
  // collapse the whitespace it leaves behind. Only the first occurrence is
  // removed — the parser matched exactly one span.
  if (parsed.matched && parsed.matched.length > 0) {
    const idx = placeQuery.toLowerCase().indexOf(parsed.matched.toLowerCase());
    let residual = placeQuery;
    if (idx >= 0) {
      residual = placeQuery.slice(0, idx) + placeQuery.slice(idx + parsed.matched.length);
    }
    residual = residual.replace(/\s+/g, ' ').trim();
    out.placeQuery = residual;
  }

  return out;
}

export interface SearchQuery {
  q?: string;
  /** Phase 3+: free-text search against the unified `asset.search_blob`
   * text index (place + description + ocr_text). Distinct from `q`
   * (filename substring) so a caller can mix the two —
   * `q=DJI&placeQuery=Albany NY` finds DJI files captured in Albany. */
  placeQuery?: string;
  libraryId?: string;
  camera?: string;
  lens?: string;
  isoMin?: string;
  isoMax?: string;
  apertureMin?: string;
  apertureMax?: string;
  focalMin?: string;
  focalMax?: string;
  from?: string;
  to?: string;
  rating?: string;
  flag?: string;
  color?: string;
  ext?: string;
  pathPrefix?: string;
  hasCapturedAt?: string;
  /** Closed-union from `vision.scene_type` (indoor / outdoor / aerial / …). */
  sceneType?: string;
  /** Open-vocab `vision.activity` exact match. */
  activity?: string;
  /** Comma-separated `vision.subjects` — OR within the field (any match
   * wins), AND against other top-level filters. */
  subjects?: string;
  /** Screenshot filter. `"true"` shows only screenshots, `"false"` shows
   * only photographs, omitted shows everything. */
  isScreenshot?: string;
  /** Comma-separated person names for an explicit person picker. Passed to
   * the Meilisearch `people` filterable attribute; the Mongo `$text`
   * fallback already covers names via `search_blob`. */
  people?: string;
  /** UI scope chip from the responsive-program S7 search surface.
   * `photos` (or absent) is the default and matches the full live set;
   * `places` narrows to assets with EXIF GPS; `people` narrows to assets
   * with at least one detected face; `albums` is a no-op today (returns
   * `{ results: [], notImplemented: true }`) because the schema has no
   * album field — see `.archived-plans/specs/2026-05-19-qwen-vision-ocr-design.md`
   * and `db/schema.ts` `AssetDoc`. */
  scope?: string;
  /** Hidden image filter. "only" returns only hidden images, "all" returns everything,
   * omitted or "none" (default) excludes hidden images. */
  hidden?: string;
  page?: string;
  limit?: string;
  sort?: string;
}

export const SearchQueryT = t.Object({
  q: t.Optional(t.String()),
  placeQuery: t.Optional(t.String()),
  libraryId: t.Optional(t.String()),
  camera: t.Optional(t.String()),
  lens: t.Optional(t.String()),
  isoMin: t.Optional(t.String()),
  isoMax: t.Optional(t.String()),
  apertureMin: t.Optional(t.String()),
  apertureMax: t.Optional(t.String()),
  focalMin: t.Optional(t.String()),
  focalMax: t.Optional(t.String()),
  from: t.Optional(t.String()),
  to: t.Optional(t.String()),
  rating: t.Optional(t.String()),
  flag: t.Optional(t.String()),
  color: t.Optional(t.String()),
  ext: t.Optional(t.String()),
  pathPrefix: t.Optional(t.String()),
  hasCapturedAt: t.Optional(t.String()),
  sceneType: t.Optional(t.String()),
  activity: t.Optional(t.String()),
  subjects: t.Optional(t.String()),
  isScreenshot: t.Optional(t.String()),
  people: t.Optional(t.String()),
  scope: t.Optional(t.String()),
  hidden: t.Optional(t.String()),
  page: t.Optional(t.String()),
  limit: t.Optional(t.String()),
  sort: t.Optional(t.String()),
});

/**
 * Translate a query-string into a Mongo filter. Exported for testing.
 *
 * Returns `{ error }` when the query asks for something impossible (bad
 * libraryId, malformed extensions) — the caller should turn this into
 * a 400.
 */
export function buildFilter(q: SearchQuery): Filter<AssetDoc> | { error: string } {
  const filter: Filter<AssetDoc> = {};

  // Free-text q: case-insensitive substring on `fileinfo[].filename` and
  // `fileinfo[].path`. Pre-PR 7 this scanned the top-level `filename` and
  // `abs_path` fields; after the drop-abs-path-2026-05-21 migration both
  // live on `fileinfo[]` entries instead. Mongo array-element semantics
  // make a `fileinfo.filename` predicate match if ANY entry's filename
  // matches — which is the same semantics as the old top-level scan.
  if (q.q && q.q.trim().length > 0) {
    const pattern = escapeRegex(q.q.trim());
    (filter as Filter<AssetDoc> & { $or?: unknown[] }).$or = [
      { 'fileinfo.filename': { $regex: pattern, $options: 'i' } },
      { 'fileinfo.path': { $regex: pattern, $options: 'i' } },
    ];
  }

  // Phase 3+: free-text search via the unified `asset.search_blob` text
  // index. The blob covers place metadata, LLM caption (description),
  // and OCR'd text (ocr_text). Mongo allows only one `$text` predicate
  // per query and it must be at top-level — that composes correctly
  // with the other structured filters (Mongo ANDs top-level fields)
  // and with `applyLiveFilter`'s wrapper (`{ $and: [filter, liveClause] }`
  // keeps `$text` at top-level of its sub-filter, which is the legal
  // position).
  if (q.placeQuery && q.placeQuery.trim().length > 0) {
    (filter as Record<string, unknown>).$text = {
      $search: q.placeQuery.trim(),
    };
  }

  // Library scoping. After drop-abs-path-2026-05-21 the per-asset
  // library pointer lives on `fileinfo[].library_id` (one row can span
  // multiple library entries when the same content is observed under
  // more than one root); we restrict to assets whose ANY entry is in
  // the requested library.
  if (q.libraryId) {
    if (!ObjectId.isValid(q.libraryId)) {
      return { error: 'Invalid libraryId' };
    }
    (filter as Record<string, unknown>)['fileinfo.library_id'] = new ObjectId(q.libraryId);
  }

  // Camera substring across make + model.
  if (q.camera && q.camera.trim().length > 0) {
    const pattern = escapeRegex(q.camera.trim());
    const camOr = [
      { 'exif.camera_make': { $regex: pattern, $options: 'i' } },
      { 'exif.camera_model': { $regex: pattern, $options: 'i' } },
    ];
    if ((filter as { $or?: unknown[] }).$or) {
      // Combine prior $or (q) with this one via $and so both sets remain restrictive.
      const existing = (filter as { $or?: unknown[] }).$or!;
      delete (filter as { $or?: unknown[] }).$or;
      (filter as { $and?: unknown[] }).$and = [{ $or: existing }, { $or: camOr }];
    } else {
      (filter as { $or?: unknown[] }).$or = camOr;
    }
  }

  // Lens substring.
  if (q.lens && q.lens.trim().length > 0) {
    (filter as Record<string, unknown>)['exif.lens'] = {
      $regex: escapeRegex(q.lens.trim()),
      $options: 'i',
    };
  }

  // Numeric ranges.
  const isoMin = asNumber(q.isoMin);
  const isoMax = asNumber(q.isoMax);
  if (isoMin !== undefined || isoMax !== undefined) {
    const range: Record<string, number> = {};
    if (isoMin !== undefined) range.$gte = isoMin;
    if (isoMax !== undefined) range.$lte = isoMax;
    (filter as Record<string, unknown>)['exif.iso'] = range;
  }

  const apMin = asNumber(q.apertureMin);
  const apMax = asNumber(q.apertureMax);
  if (apMin !== undefined || apMax !== undefined) {
    const range: Record<string, number> = {};
    if (apMin !== undefined) range.$gte = apMin;
    if (apMax !== undefined) range.$lte = apMax;
    (filter as Record<string, unknown>)['exif.aperture'] = range;
  }

  const focMin = asNumber(q.focalMin);
  const focMax = asNumber(q.focalMax);
  if (focMin !== undefined || focMax !== undefined) {
    const range: Record<string, number> = {};
    if (focMin !== undefined) range.$gte = focMin;
    if (focMax !== undefined) range.$lte = focMax;
    (filter as Record<string, unknown>)['exif.focal_length'] = range;
  }

  // Date range — captured_at is an ISO 8601 string; lexicographic compares
  // are safe for ISO 8601 with constant-width fields.
  // We may augment the same field below with `hasCapturedAt`'s `$ne: null`,
  // so build the predicate object once and merge to avoid double-write.
  // Bare-date inputs (`YYYY-MM-DD` with no `T`) are widened to the full day
  // before lexicographic comparison — otherwise `$lte: "2025-07-31"` skips
  // every photo captured on July 31 (their stored value is `"2025-07-31T..."`
  // which compares greater than the bare date).
  const capturedAtPredicate: Record<string, string | null> = {};
  if (q.from) capturedAtPredicate.$gte = widenFromDate(q.from);
  if (q.to) capturedAtPredicate.$lte = widenToDate(q.to);

  // hasCapturedAt='true' requires an EXIF capture date to be present. We
  // merge into the same predicate object as the from/to range so we don't
  // accidentally clobber the date constraints when both are set.
  if (q.hasCapturedAt === 'true') {
    capturedAtPredicate.$ne = null;
  }
  if (Object.keys(capturedAtPredicate).length > 0) {
    (filter as Record<string, unknown>)['exif.captured_at'] = capturedAtPredicate;
  }

  // Rating threshold (>= n).
  const rating = asNumber(q.rating);
  if (rating !== undefined) {
    (filter as Record<string, unknown>).rating = { $gte: rating };
  }

  // Flag.
  if (q.flag !== undefined && q.flag !== '') {
    const f = FLAG_BY_NAME[q.flag];
    if (f === undefined) return { error: `Invalid flag: ${q.flag}` };
    (filter as Record<string, unknown>).flag = f;
  }

  // Color.
  if (q.color !== undefined) {
    if (!COLOR_LABELS.has(q.color)) {
      return { error: `Invalid color: ${q.color}` };
    }
    (filter as Record<string, unknown>).color_label = q.color;
  }

  // Path prefix — anchored regex on `fileinfo[].path`, used by the
  // Timeline view to scope results to a subtree. `fileinfo[].path` is
  // the directory portion (relative to the library root) without the
  // filename. Pre-PR 7 this regex-anchored on the absolute `abs_path`;
  // post-migration we strip leading AND trailing slashes off the
  // caller's prefix and require a directory boundary after it, so a
  // prefix like `/A/` matches `A` and `A/B` but NOT `A (1)` (which the
  // pre-migration `^/A/` regex would also have rejected). Preserves
  // wire semantics for callers that pass slash-anchored prefixes.
  if (q.pathPrefix && q.pathPrefix.length > 0) {
    if (q.pathPrefix.length > 1024) {
      return { error: 'pathPrefix too long' };
    }
    const stripped = q.pathPrefix.replace(/^\/+/, '').replace(/\/+$/, '');
    if (stripped.length > 0) {
      (filter as Record<string, unknown>)['fileinfo.path'] = {
        $regex: '^' + escapeRegex(stripped) + '(\\/|$)',
      };
    }
  }

  // Vision scene_type — closed union, exact match.
  if (q.sceneType !== undefined && q.sceneType !== '') {
    if (!SCENE_TYPES.has(q.sceneType)) {
      return { error: `Invalid sceneType: ${q.sceneType}` };
    }
    (filter as Record<string, unknown>)['vision.scene_type'] = q.sceneType;
  }

  // Vision activity — open vocab, exact match. Trim only; do not regex
  // because the FE picks from the facet endpoint's exact values.
  if (q.activity && q.activity.trim().length > 0) {
    (filter as Record<string, unknown>)['vision.activity'] = q.activity.trim();
  }

  // Vision subjects — comma-separated. Mongo array-contains semantics make
  // `{ "vision.subjects": { $in: [...] } }` an OR within the field. Combined
  // with the other top-level filters via Mongo's implicit AND.
  if (q.subjects && q.subjects.trim().length > 0) {
    const subjects = q.subjects
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (subjects.length > 0) {
      (filter as Record<string, unknown>)['vision.subjects'] = {
        $in: subjects,
      };
    }
  }

  // Screenshot filter. Boolean stringified as "true" / "false"; anything
  // else (omitted, empty, "any") leaves both kinds in the result set.
  if (q.isScreenshot === 'true') {
    (filter as Record<string, unknown>).is_screenshot = true;
  } else if (q.isScreenshot === 'false') {
    // `$ne: true` rather than `false` so rows where is_screenshot was
    // never written (pre-#175 indexes) still appear under "Photos only".
    (filter as Record<string, unknown>).is_screenshot = { $ne: true };
  }

  // Hidden images filter
  if (q.hidden === 'only') {
    (filter as Record<string, unknown>).hidden = true;
  } else if (q.hidden === 'all') {
    // No filter on hidden, returns all.
  } else {
    // Default is to filter out hidden images.
    (filter as Record<string, unknown>).hidden = { $ne: true };
  }

  // Extensions: comma-separated, alphanumeric only.
  if (q.ext && q.ext.trim().length > 0) {
    const exts = q.ext
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0);
    for (const e of exts) {
      if (!/^[a-z0-9]+$/.test(e)) {
        return { error: `Invalid extension: ${e}` };
      }
    }
    if (exts.length > 0) {
      // Post-PR 7: filename moved onto `fileinfo[].filename`. Mongo
      // array-element semantics: an entry-level regex matches if ANY
      // fileinfo entry's filename satisfies it — same semantics as the
      // pre-migration top-level field scan.
      (filter as Record<string, unknown>)['fileinfo.filename'] = {
        $regex: `\\.(?:${exts.join('|')})$`,
        $options: 'i',
      };
    }
  }

  // Scope (S7 chip). `photos` and absent are no-ops — the default search
  // already returns the full live photo set. `places` and `people` narrow
  // by underlying field presence. `albums` is validated here but its
  // short-circuit lives in the route handler (we don't want to build a
  // pointless filter; the handler returns `notImplemented: true`).
  if (q.scope !== undefined && q.scope !== '') {
    if (!SEARCH_SCOPES.has(q.scope)) {
      return { error: `Invalid scope: ${q.scope}` };
    }
    if (q.scope === 'places') {
      // Use `exif.gps` (set by the EXIF stage at index time) rather than
      // the post-geocode `place` field — `place` only populates once the
      // Phase 2 geocode worker has run, so filtering on it would hide
      // every freshly indexed photo until the worker catches up. The
      // text-search path against geocoded place names is the separate
      // `placeQuery` param.
      (filter as Record<string, unknown>)['exif.gps'] = { $ne: null };
    } else if (q.scope === 'people') {
      // Any detected face counts — not just identified ones. Identity
      // assignment only happens after the face-embed + clustering jobs
      // run; gating on `person_id` would empty the People scope for
      // every photo whose face hasn't been clustered yet.
      (filter as Record<string, unknown>)['faces.0'] = { $exists: true };
    }
    // `albums` falls through here with no filter added — the handler
    // short-circuits before reaching Mongo.
    // `photos` falls through with no filter added (the default set).
  }

  return filter;
}

/**
 * Wrap a query-built filter with the live-row constraint (excludes
 * soft-deleted rows). Always lifts existing top-level fields into a
 * single `$and` so user-supplied `$or`/`$and` clauses can't shadow the
 * deleted_at predicate.
 *
 * "Live" now has two arms, ANDed:
 *   1. NOT user-trashed — root `deleted_at` is null/absent (the File Provider
 *      trash path is the only writer of root `deleted_at`).
 *   2. Has at least one live on-disk location — `liveFileInfoElemMatch()`. An
 *      asset whose every `fileinfo` entry is `deleted_at` (content replaced)
 *      or `missing_since` (file vanished) has no live location and is hidden,
 *      WITHOUT a root flag. This is what makes a watcher-`removed` of the last
 *      copy (and a per-entry `missing_since` tag) drop the asset from reads.
 *
 * When `$text` is present, the filter must also be friendly to the
 * partial text index. The `search_blob_text` index uses
 * `partialFilterExpression: { deleted_at: null,
 *  search_blob: { $type: "string", $gt: "" } }`. Mongo's planner only
 * uses a partial index when the query implies the predicate, so when
 * `$text` is in play we keep `deleted_at: null` + `search_blob` as top-level
 * keys (the fileinfo arm rides alongside as a residual). The Phase 1 indexer
 * writes `deleted_at: null` on every skeleton row, so this is safe in
 * practice — we only filter out rows that were soft-deleted.
 */
export function applyLiveFilter(filter: Filter<AssetDoc>): Filter<AssetDoc> {
  const usesText = '$text' in (filter as Record<string, unknown>);
  const liveFileinfo = liveFileInfoElemMatch();
  const liveClause: Record<string, unknown> = usesText
    ? {
        deleted_at: null,
        search_blob: { $type: 'string', $gt: '' },
        ...liveFileinfo,
      }
    : {
        $and: [{ $or: [{ deleted_at: null }, { deleted_at: { $exists: false } }] }, liveFileinfo],
      };
  const keys = Object.keys(filter);
  if (keys.length === 0) {
    return liveClause as unknown as Filter<AssetDoc>;
  }
  return { $and: [filter, liveClause] } as unknown as Filter<AssetDoc>;
}
