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
import type { AssetDoc } from "../db/schema.ts";

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

function clampInt(value: string | undefined, lo: number, hi: number, def: number): number {
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

interface SearchQuery {
  q?: string;
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
export function buildFilter(q: SearchQuery): Filter<AssetDoc> | { error: string } {
  const filter: Filter<AssetDoc> = {};

  // Free-text q: case-insensitive substring on filename + abs_path.
  if (q.q && q.q.trim().length > 0) {
    const pattern = escapeRegex(q.q.trim());
    (filter as Filter<AssetDoc> & { $or?: unknown[] }).$or = [
      { filename: { $regex: pattern, $options: "i" } },
      { abs_path: { $regex: pattern, $options: "i" } },
    ];
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
      (filter as { $and?: unknown[] }).$and = [{ $or: existing }, { $or: camOr }];
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
  const capturedAtPredicate: Record<string, string | null> = {};
  if (q.from) capturedAtPredicate.$gte = q.from;
  if (q.to) capturedAtPredicate.$lte = q.to;

  // hasCapturedAt='true' requires an EXIF capture date to be present. We
  // merge into the same predicate object as the from/to range so we don't
  // accidentally clobber the date constraints when both are set.
  if (q.hasCapturedAt === "true") {
    capturedAtPredicate.$ne = null;
  }
  if (Object.keys(capturedAtPredicate).length > 0) {
    (filter as Record<string, unknown>)["exif.captured_at"] = capturedAtPredicate;
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
}

function projectAsset(d: AssetDoc & { _id: ObjectId }): SearchResult {
  const exif = d.exif ?? null;
  const camera = exif && (exif.camera_make !== null || exif.camera_model !== null)
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
  };
}

const SearchQueryT = t.Object({
  q: t.Optional(t.String()),
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

      const [docs, total] = await Promise.all([
        coll
          .find(finalFilter)
          .sort(pickSort(sort))
          .skip(skip)
          .limit(limit)
          .toArray(),
        coll.countDocuments(finalFilter),
      ]);

      const results = docs.map((d) => projectAsset(d as AssetDoc & { _id: ObjectId }));
      return { total, page, limit, results };
    },
    { query: SearchQueryT }
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

      const [total, cameraAgg, lensAgg, extAgg, isoAgg, capAgg] = await Promise.all([
        coll.countDocuments(finalFilter),
        coll
          .aggregate([
            { $match: finalFilter },
            {
              $group: {
                _id: { make: "$exif.camera_make", model: "$exif.camera_model" },
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
        isoRow && typeof isoRow.min === "number" && typeof isoRow.max === "number"
          ? { min: isoRow.min as number, max: isoRow.max as number }
          : null;
      const capRow = capAgg[0];
      const capture_range =
        capRow && typeof capRow.from === "string" && typeof capRow.to === "string"
          ? { from: capRow.from as string, to: capRow.to as string }
          : null;

      return { total, cameras, lenses, extensions, iso_range, capture_range };
    },
    { query: SearchQueryT }
  )

  .get(
    "/buckets",
    async ({ query, set }) => {
      const filterOrError = buildFilter(query as SearchQuery);
      if ("error" in filterOrError) {
        set.status = 400;
        return { error: filterOrError.error };
      }
      const filter = filterOrError;
      const coll = await assetsCollection();
      const finalFilter = applyLiveFilter(filter);

      // Single $facet aggregation: one branch counts timed (year/month-binned)
      // rows, the other counts everything that ISN'T timed. We define
      // "untimed" as `captured_at: null` OR the field missing — Mongo's
      // `$ne: null` excludes both, putting them in neither bucket otherwise.
      // Without the explicit `$exists: false` branch in `untimed`, rows with
      // no `exif` subdoc at all would silently disappear from the totals.
      const [result] = await coll
        .aggregate([
          { $match: finalFilter },
          {
            $facet: {
              timed: [
                { $match: { "exif.captured_at": { $ne: null } } },
                {
                  $project: {
                    year: {
                      $year: {
                        $dateFromString: {
                          dateString: "$exif.captured_at",
                          onError: null,
                          onNull: null,
                        },
                      },
                    },
                    month: {
                      $month: {
                        $dateFromString: {
                          dateString: "$exif.captured_at",
                          onError: null,
                          onNull: null,
                        },
                      },
                    },
                  },
                },
                { $match: { year: { $ne: null }, month: { $ne: null } } },
                {
                  $group: {
                    _id: { year: "$year", month: "$month" },
                    count: { $sum: 1 },
                  },
                },
                { $sort: { "_id.year": -1, "_id.month": -1 } },
              ],
              untimed: [
                {
                  $match: {
                    $or: [
                      { "exif.captured_at": null },
                      { "exif.captured_at": { $exists: false } },
                    ],
                  },
                },
                { $count: "count" },
              ],
            },
          },
        ])
        .toArray();

      const timed = (result?.timed ?? []) as Array<{
        _id: { year: number; month: number };
        count: number;
      }>;
      const untimedArr = (result?.untimed ?? []) as Array<{ count: number }>;

      // Sanity cap: 50 years × 12 months = 600 buckets. Anything more means
      // a bug (corrupt dates landing in distinct buckets), not a real photo
      // library.
      if (timed.length > 600) {
        set.status = 400;
        return { error: "too many buckets" };
      }

      const buckets = timed.map((t) => ({
        year: t._id.year,
        month: t._id.month,
        count: t.count,
      }));
      const total = buckets.reduce((acc, b) => acc + b.count, 0);
      const untimed_count = untimedArr[0]?.count ?? 0;

      return { total, buckets, untimed_count };
    },
    { query: SearchQueryT }
  );
