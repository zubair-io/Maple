/**
 * GET /api/geocode/reverse
 *
 * Returns the cached Place from `geocode_cache` for a given lat/lon, or 404
 * if no row matches. The cache is populated by the indexer's geocode worker
 * (Phase 2 of indexer-enrichment); this endpoint is a read-only device-side
 * lookup so a PhotoKit-backup client can decide a destination folder path
 * before uploading bytes.
 *
 * Query:
 *   lat        — required, finite number
 *   lon        — required, finite number
 *   precision  — optional, decimal places for quantisation (default 4)
 *
 * Response 200: { place: Place }
 * Response 404: { error: "not in cache" } — device falls back to the
 *               no-GPS path shape (spec §9).
 * Response 400: { error: "lat and lon are required and must be finite numbers" }
 *
 * Note: we deliberately do NOT validate `geocoder_version` here. Stale entries
 * are still useful for path-formation; the indexer is responsible for refresh.
 *
 * Spec: docs/superpowers/specs/2026-05-09-photokit-backup-design.md §9, §20.
 */
import { Elysia, t } from "elysia";
import { geocodeCacheCollection } from "../db/client.ts";
import {
  quantizedKey,
  DEFAULT_QUANTIZATION_DECIMALS,
} from "../enrichment/coordinate-cache.ts";

export const geocodeReverseRoutes = new Elysia().get(
  "/api/geocode/reverse",
  async ({ query, set }) => {
    if (!query.lat || !query.lon) {
      set.status = 400;
      return { error: "lat and lon are required and must be finite numbers" };
    }
    const lat = parseFloat(query.lat);
    const lon = parseFloat(query.lon);
    const precision = query.precision
      ? parseInt(query.precision, 10)
      : DEFAULT_QUANTIZATION_DECIMALS;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      set.status = 400;
      return { error: "lat and lon are required and must be finite numbers" };
    }
    if (!Number.isFinite(precision) || precision < 0 || precision > 8) {
      set.status = 400;
      return { error: "precision must be an integer between 0 and 8" };
    }

    const coll = await geocodeCacheCollection();
    const row = await coll.findOne({ _id: quantizedKey(lat, lon, precision) });
    if (!row) {
      set.status = 404;
      return { error: "not in cache" };
    }
    return { place: row.place };
  },
  {
    query: t.Object({
      lat: t.Optional(t.String()),
      lon: t.Optional(t.String()),
      precision: t.Optional(t.String()),
    }),
  },
);
