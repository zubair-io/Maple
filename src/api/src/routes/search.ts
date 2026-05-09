/**
 * /api/search — EXIF-focused photo search across one or all libraries.
 *
 * Endpoints:
 *   GET /api/search          — paginated result list
 *   GET /api/search/facets   — aggregation buckets for FE dropdowns
 *
 * The route lives behind `requireAuth`, so it is registered after that
 * middleware in `src/index.ts`.
 *
 * Filter strategy notes:
 *   - For free-text `q`, we use case-insensitive `$regex` against `filename`
 *     (and a fallback regex against `abs_path` via `$or`). We deliberately
 *     do NOT use the `$text` index here even though one exists: `$text`
 *     does not allow substring matches without word boundaries (e.g.
 *     "DJI" wouldn't match "dji_0001.dng" cleanly), and combining `$text`
 *     with the structured EXIF filters would require `$and` plumbing that
 *     the planner sometimes mis-costs. The text index is still kept for
 *     future ranked search.
 *   - All other filters are exact / range matches on indexed paths
 *     (see `ensureIndexes` in `src/db/client.ts`).
 *   - Default sort `{ "exif.captured_at": -1, _id: 1 }` is stable across
 *     pages — `_id` breaks ties when many assets share the same timestamp
 *     (e.g. burst frames).
 */

import { Elysia, t } from "elysia";
import { ObjectId } from "mongodb";
import type { Filter, Sort } from "mongodb";
import { assetsCollection } from "../db/client.ts";
import type { AssetDoc, Place } from "../db/schema.ts";

const COLOR_LABELS = new Set(["", "red", "yellow", "green", "blue", "purple"]);
const FLAG_BY_NAME: Record<string, -1 | 0 | 1> = {
  pick: 1,
  none: 0,
  reject: -1,
};
const SORT_OPTIONS = new Set([
  "captured_desc",
  "captured_asc",
  "name",
  "rating",
]);

/** Escape a string for use inside a `$regex` pattern. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clampInt(
  value: string | undefined,
  lo: number,
  hi: number,
  def: number,
): number {
  if (value === undefined) return def;
  const n = Number(value);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function asNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Bare-date detector: matches `YYYY-MM-DD` with no time component. */
const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Widen a `from` date to the start of the day if no time component is set,
 * so the lexicographic compare against ISO datetimes is correct. */
function widenFromDate(s: string): string {
  return BARE_DATE.test(s) ? `${s}T00:00:00.000Z` : s;
}

/** Widen a `to` date to the end of the day if no time component is set,
 * so `$lte` includes photos captured on that day. */
function widenToDate(s: string): string {
  return BARE_DATE.test(s) ? `${s}T23:59:59.999Z` : s;
}

interface SearchQuery {
  q?: string;
  /** Phase 3: free-text place search against the `place.search_blob` text
   * index. Distinct from `q` (filename substring) so a caller can mix the
   * two — `q=DJI&placeQuery=Albany NY` finds DJI files captured in Albany. */
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
  page?: string;
  limit?: string;
  sort?: string;
}

/**
 * Translate a query-string into a Mongo filter. Exported for testing.
 *
 * Returns `null` when the query asks for something impossible (bad libraryId,
 * malformed extensions) — the caller should turn this into a 400.
 */
export function buildFilter(
  q: SearchQuery,
): Filter<AssetDoc> | { error: string } {
  const filter: Filter<AssetDoc> = {};

  // Free-text q: case-insensitive substring on filename + abs_path.
  if (q.q && q.q.trim().length > 0) {
    const pattern = escapeRegex(q.q.trim());
    (filter as Filter<AssetDoc> & { $or?: unknown[] }).$or = [
      { filename: { $regex: pattern, $options: "i" } },
      { abs_path: { $regex: pattern, $options: "i" } },
    ];
  }

  // Phase 3: free-text PLACE search via the `place.search_blob` text index.
  // Mongo allows only one `$text` predicate per query and it must be at
  // top-level — that composes correctly with the other structured filters
  // (Mongo ANDs top-level fields) and with `applyLiveFilter`'s wrapper
  // (`{ $and: [filter, liveClause] }` keeps `$text` at top-level of its
  // sub-filter, which is the legal position).
  if (q.placeQuery && q.placeQuery.trim().length > 0) {
    (filter as Record<string, unknown>).$text = {
      $search: q.placeQuery.trim(),
    };
  }

  // Library scoping.
  if (q.libraryId) {
    if (!ObjectId.isValid(q.libraryId)) {
      return { error: "Invalid libraryId" };
    }
    (filter as Record<string, unknown>).folder_id = new ObjectId(q.libraryId);
  }

  // Camera substring across make + model.
  if (q.camera && q.camera.trim().length > 0) {
    const pattern = escapeRegex(q.camera.trim());
    const camOr = [
      { "exif.camera_make": { $regex: pattern, $options: "i" } },
      { "exif.camera_model": { $regex: pattern, $options: "i" } },
    ];
    if ((filter as { $or?: unknown[] }).$or) {
      // Combine prior $or (q) with this one via $and so both sets remain restrictive.
      const existing = (filter as { $or?: unknown[] }).$or!;
      delete (filter as { $or?: unknown[] }).$or;
      (filter as { $and?: unknown[] }).$and = [
        { $or: existing },
        { $or: camOr },
      ];
    } else {
      (filter as { $or?: unknown[] }).$or = camOr;
    }
  }

  // Lens substring.
  if (q.lens && q.lens.trim().length > 0) {
    (filter as Record<string, unknown>)["exif.lens"] = {
      $regex: escapeRegex(q.lens.trim()),
      $options: "i",
    };
  }

  // Numeric ranges.
  const isoMin = asNumber(q.isoMin);
  const isoMax = asNumber(q.isoMax);
  if (isoMin !== undefined || isoMax !== undefined) {
    const range: Record<string, number> = {};
    if (isoMin !== undefined) range.$gte = isoMin;
    if (isoMax !== undefined) range.$lte = isoMax;
    (filter as Record<string, unknown>)["exif.iso"] = range;
  }

  const apMin = asNumber(q.apertureMin);
  const apMax = asNumber(q.apertureMax);
  if (apMin !== undefined || apMax !== undefined) {
    const range: Record<string, number> = {};
    if (apMin !== undefined) range.$gte = apMin;
    if (apMax !== undefined) range.$lte = apMax;
    (filter as Record<string, unknown>)["exif.aperture"] = range;
  }

  const focMin = asNumber(q.focalMin);
  const focMax = asNumber(q.focalMax);
  if (focMin !== undefined || focMax !== undefined) {
    const range: Record<string, number> = {};
    if (focMin !== undefined) range.$gte = focMin;
    if (focMax !== undefined) range.$lte = focMax;
    (filter as Record<string, unknown>)["exif.focal_length"] = range;
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
  if (q.hasCapturedAt === "true") {
    capturedAtPredicate.$ne = null;
  }
  if (Object.keys(capturedAtPredicate).length > 0) {
    (filter as Record<string, unknown>)["exif.captured_at"] =
      capturedAtPredicate;
  }

  // Rating threshold (>= n).
  const rating = asNumber(q.rating);
  if (rating !== undefined) {
    (filter as Record<string, unknown>).rating = { $gte: rating };
  }

  // Flag.
  if (q.flag !== undefined && q.flag !== "") {
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

  // Path prefix — anchored regex on abs_path, used by Timeline view to
  // scope results to a subtree. We add it as a top-level field; Mongo ANDs
  // top-level fields, which composes correctly with the existing q-driven
  // `$or` (which also touches abs_path) — the $or only needs ONE branch to
  // match, while pathPrefix forces all matches to also start with the prefix.
  if (q.pathPrefix && q.pathPrefix.length > 0) {
    if (q.pathPrefix.length > 1024) {
      return { error: "pathPrefix too long" };
    }
    (filter as Record<string, unknown>).abs_path = {
      $regex: "^" + escapeRegex(q.pathPrefix),
    };
  }

  // Extensions: comma-separated, alphanumeric only.
  if (q.ext && q.ext.trim().length > 0) {
    const exts = q.ext
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0);
    for (const e of exts) {
      if (!/^[a-z0-9]+$/.test(e)) {
        return { error: `Invalid extension: ${e}` };
      }
    }
    if (exts.length > 0) {
      (filter as Record<string, unknown>).filename = {
        $regex: `\\.(?:${exts.join("|")})$`,
        $options: "i",
      };
    }
  }

  return filter;
}

/**
 * Wrap a query-built filter with the live-row constraint (excludes
 * soft-deleted rows). Always lifts existing top-level fields into a
 * single `$and` so user-supplied `$or`/`$and` clauses can't shadow the
 * deleted_at predicate.
 */
function applyLiveFilter(filter: Filter<AssetDoc>): Filter<AssetDoc> {
  const liveClause = {
    $or: [{ deleted_at: null }, { deleted_at: { $exists: false } }],
  };
  // If the filter is empty, return a plain match on the live clause.
  const keys = Object.keys(filter);
  if (keys.length === 0) {
    return liveClause as unknown as Filter<AssetDoc>;
  }
  return { $and: [filter, liveClause] } as unknown as Filter<AssetDoc>;
}

function pickSort(sort: string | undefined): Sort {
  switch (sort) {
    case "captured_asc":
      return { "exif.captured_at": 1, _id: 1 };
    case "name":
      return { filename: 1, _id: 1 };
    case "rating":
      return { rating: -1, "exif.captured_at": -1, _id: 1 };
    case "captured_desc":
    default:
      return { "exif.captured_at": -1, _id: 1 };
  }
}

interface SearchResult {
  id: string;
  _id: string;
  folder_id: string;
  abs_path: string;
  filename: string;
  size: number;
  mtime: number;
  captured_at: string | null;
  camera: { make: string | null; model: string | null } | null;
  lens: string | null;
  iso: number | null;
  aperture: number | null;
  shutter: string | null;
  focal_length: number | null;
  rating: number;
  flag: -1 | 0 | 1;
  color_label: string;
  /** Reverse-geocoded place; `null` for assets without GPS or before the
   * Phase 2 geocode worker has run. */
  place: Place | null;
  /** LLM-generated caption; `null` before the Phase 6 describe worker has run. */
  description: string | null;
}

function projectAsset(d: AssetDoc & { _id: ObjectId }): SearchResult {
  const exif = d.exif ?? null;
  const camera =
    exif && (exif.camera_make !== null || exif.camera_model !== null)
      ? { make: exif.camera_make, model: exif.camera_model }
      : null;
  return {
    // The editor's id format is `fs:<absPath>` (matches Hosted's
    // browser-FS-Access keys); keeping the same shape here lets the FE
    // route a search hit straight into the editor.
    id: `fs:${d.abs_path}`,
    _id: d._id.toHexString(),
    folder_id: d.folder_id.toHexString(),
    abs_path: d.abs_path,
    filename: d.filename,
    size: d.size,
    mtime: d.mtime,
    captured_at: exif?.captured_at ?? null,
    camera,
    lens: exif?.lens ?? null,
    iso: exif?.iso ?? null,
    aperture: exif?.aperture ?? null,
    shutter: exif?.shutter ?? null,
    focal_length: exif?.focal_length ?? null,
    rating: d.rating,
    flag: d.flag,
    color_label: d.color_label,
    // Enrichment outputs — null on old rows or before the worker has run.
    // `faces` and the `enrichment` worker-state subdocument are deliberately
    // not on the list payload (face embeddings can be large; worker state is
    // internal). Use `/api/assets/:id` for the full record.
    place: d.place ?? null,
    description: d.description ?? null,
  };
}

const SearchQueryT = t.Object({
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
  page: t.Optional(t.String()),
  limit: t.Optional(t.String()),
  sort: t.Optional(t.String()),
});

export const searchRoutes = new Elysia({ prefix: "/api/search" })
  .get(
    "/",
    async ({ query, set }) => {
      const filterOrError = buildFilter(query as SearchQuery);
      if ("error" in filterOrError) {
        set.status = 400;
        return { error: filterOrError.error };
      }
      const filter = filterOrError;

      const page = clampInt(query.page, 0, Number.MAX_SAFE_INTEGER, 0);
      const limit = clampInt(query.limit, 1, 200, 100);
      const sort =
        query.sort && SORT_OPTIONS.has(query.sort)
          ? query.sort
          : "captured_desc";
      const skip = page * limit;

      const coll = await assetsCollection();
      // Exclude soft-deleted rows from search results. We always wrap the
      // existing filter into a `$and` so a user-supplied `$or` (free-text
      // q + camera) doesn't shadow this constraint.
      const finalFilter = applyLiveFilter(filter);

      // When a placeQuery is set, sort by Mongo's textScore first so
      // closer matches lead the page; tie-break on captured_at desc, then
      // _id for pagination stability. Otherwise honour the caller's sort.
      const usingPlaceText =
        typeof query.placeQuery === "string" &&
        query.placeQuery.trim().length > 0;
      const sortSpec: Sort = usingPlaceText
        ? ({
            score: { $meta: "textScore" },
            "exif.captured_at": -1,
            _id: 1,
          } as unknown as Sort)
        : pickSort(sort);
      const projection = usingPlaceText
        ? { score: { $meta: "textScore" } }
        : undefined;

      const cursor = coll.find(finalFilter);
      if (projection) cursor.project(projection);
      const [docs, total] = await Promise.all([
        cursor.sort(sortSpec).skip(skip).limit(limit).toArray(),
        coll.countDocuments(finalFilter),
      ]);

      const results = docs.map((d) =>
        projectAsset(d as AssetDoc & { _id: ObjectId }),
      );
      return { total, page, limit, results };
    },
    { query: SearchQueryT },
  )

  .get(
    "/facets",
    async ({ query, set }) => {
      const filterOrError = buildFilter(query as SearchQuery);
      if ("error" in filterOrError) {
        set.status = 400;
        return { error: filterOrError.error };
      }
      const filter = filterOrError;
      const coll = await assetsCollection();
      const finalFilter = applyLiveFilter(filter);

      const [total, cameraAgg, lensAgg, extAgg, isoAgg, capAgg] =
        await Promise.all([
          coll.countDocuments(finalFilter),
          coll
            .aggregate([
              { $match: finalFilter },
              {
                $group: {
                  _id: {
                    make: "$exif.camera_make",
                    model: "$exif.camera_model",
                  },
                  count: { $sum: 1 },
                },
              },
              { $sort: { count: -1 } },
              { $limit: 50 },
            ])
            .toArray(),
          coll
            .aggregate([
              { $match: finalFilter },
              { $group: { _id: "$exif.lens", count: { $sum: 1 } } },
              { $sort: { count: -1 } },
              { $limit: 50 },
            ])
            .toArray(),
          // Extensions: derive in Mongo via $split + $arrayElemAt — simpler
          // than $regexFindAll and works on every supported server version.
          coll
            .aggregate([
              { $match: finalFilter },
              {
                $project: {
                  ext: {
                    $toLower: {
                      $arrayElemAt: [{ $split: ["$filename", "."] }, -1],
                    },
                  },
                },
              },
              { $match: { ext: { $nin: [null, ""] } } },
              { $group: { _id: "$ext", count: { $sum: 1 } } },
              { $sort: { count: -1 } },
              { $limit: 50 },
            ])
            .toArray(),
          coll
            .aggregate([
              { $match: finalFilter },
              {
                $group: {
                  _id: null,
                  min: { $min: "$exif.iso" },
                  max: { $max: "$exif.iso" },
                },
              },
            ])
            .toArray(),
          coll
            .aggregate([
              { $match: finalFilter },
              {
                $group: {
                  _id: null,
                  from: { $min: "$exif.captured_at" },
                  to: { $max: "$exif.captured_at" },
                },
              },
            ])
            .toArray(),
        ]);

      const cameras = cameraAgg.map((r) => ({
        make: r._id.make ?? null,
        model: r._id.model ?? null,
        count: r.count as number,
      }));
      const lenses = lensAgg.map((r) => ({
        value: (r._id as string | null) ?? null,
        count: r.count as number,
      }));
      const extensions = extAgg
        .filter((r) => typeof r._id === "string" && r._id.length > 0)
        .map((r) => ({ value: r._id as string, count: r.count as number }));
      const isoRow = isoAgg[0];
      const iso_range =
        isoRow &&
        typeof isoRow.min === "number" &&
        typeof isoRow.max === "number"
          ? { min: isoRow.min as number, max: isoRow.max as number }
          : null;
      const capRow = capAgg[0];
      const capture_range =
        capRow &&
        typeof capRow.from === "string" &&
        typeof capRow.to === "string"
          ? { from: capRow.from as string, to: capRow.to as string }
          : null;

      return { total, cameras, lenses, extensions, iso_range, capture_range };
    },
    { query: SearchQueryT },
  )

  .get(
    "/buckets",
    async ({ query, set }) => {
      const filterOrError = buildFilter(query as SearchQuery);
      if ("error" in filterOrError) {
        set.status = 400;
        return { error: filterOrError.error };
      }

      // Cache lookup. Buckets only change when assets are written —
      // a 30s TTL keeps repeat loads from the same client cheap and is
      // tight enough that newly-indexed photos surface within a minute.
      const cacheKey = makeBucketsCacheKey(query as SearchQuery);
      const cached = bucketsCache.get(cacheKey);
      const nowMs = Date.now();
      if (cached && cached.expiresMs > nowMs) {
        return cached.result;
      }

      const filter = filterOrError;
      const coll = await assetsCollection();
      const finalFilter = applyLiveFilter(filter);

      // Two parallel aggregations instead of one $facet pipeline: each
      // branch can use its own optimal index, and Mongo schedules them
      // independently. The timed branch uses pre-computed numeric
      // exif.captured_year/month (set by the indexer + backfilled at
      // startup) so $group is index-only — no $dateFromString per doc.
      const timedFilter = {
        ...finalFilter,
        "exif.captured_year": { $ne: null },
      } as typeof finalFilter;
      const untimedFilter = {
        ...finalFilter,
        $or: [
          { "exif.captured_at": null },
          { "exif.captured_at": { $exists: false } },
        ],
      } as typeof finalFilter;

      const [timed, untimed_count] = await Promise.all([
        coll
          .aggregate<{
            _id: { year: number; month: number };
            count: number;
          }>([
            { $match: timedFilter },
            {
              $group: {
                _id: {
                  year: "$exif.captured_year",
                  month: "$exif.captured_month",
                },
                count: { $sum: 1 },
              },
            },
            { $sort: { "_id.year": -1, "_id.month": -1 } },
          ])
          .toArray(),
        coll.countDocuments(untimedFilter),
      ]);

      const buckets = timed.map((t) => ({
        year: t._id.year,
        month: t._id.month,
        count: t.count,
      }));
      const total = buckets.reduce((acc, b) => acc + b.count, 0);

      const result = { total, buckets, untimed_count };
      // Bound the cache so a parameterised attack can't grow it
      // unboundedly. 500 unique filter sets is generous for a single
      // server; eviction is FIFO via insertion order.
      if (bucketsCache.size >= 500) {
        const oldest = bucketsCache.keys().next().value;
        if (oldest !== undefined) bucketsCache.delete(oldest);
      }
      bucketsCache.set(cacheKey, {
        result,
        expiresMs: nowMs + BUCKETS_CACHE_TTL_MS,
      });
      return result;
    },
    { query: SearchQueryT },
  );

// ── Buckets response cache ────────────────────────────────────────────
// Module-scoped because the cache lives for the process lifetime. Keys
// are the full filter set; values are the aggregation result + an
// absolute expiry. 30 s is short enough that newly-indexed assets show
// up "soon" without explicit invalidation, long enough that a user
// flicking between scopes hits warm cache.
const BUCKETS_CACHE_TTL_MS = 30_000;
interface CachedBuckets {
  result: {
    total: number;
    buckets: Array<{ year: number; month: number; count: number }>;
    untimed_count: number;
  };
  expiresMs: number;
}
const bucketsCache = new Map<string, CachedBuckets>();

/** Stable JSON serialisation of a SearchQuery. Field order is fixed so
 * that two requests with the same params produce the same key
 * regardless of how the URL was constructed. */
function makeBucketsCacheKey(q: SearchQuery): string {
  return JSON.stringify({
    pathPrefix: q.pathPrefix ?? null,
    libraryId: q.libraryId ?? null,
    q: q.q ?? null,
    placeQuery: q.placeQuery ?? null,
    camera: q.camera ?? null,
    lens: q.lens ?? null,
    isoMin: q.isoMin ?? null,
    isoMax: q.isoMax ?? null,
    apertureMin: q.apertureMin ?? null,
    apertureMax: q.apertureMax ?? null,
    focalMin: q.focalMin ?? null,
    focalMax: q.focalMax ?? null,
    from: q.from ?? null,
    to: q.to ?? null,
    rating: q.rating ?? null,
    flag: q.flag ?? null,
    color: q.color ?? null,
    ext: q.ext ?? null,
    hasCapturedAt: q.hasCapturedAt ?? null,
  });
}

/** Test-only: blow the cache so back-to-back tests don't see each
 * other's results. Safe in production too — just slower for 30 s. */
export function _resetBucketsCacheForTests(): void {
  bucketsCache.clear();
}
