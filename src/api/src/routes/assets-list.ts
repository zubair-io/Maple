/**
 * GET /api/assets — minimal list endpoint used by the File Provider
 * working-set enumerator to seed its tracked subset.
 *
 * Supported filters (combined with AND):
 *   has_xmp=1            — only assets whose XMP sidecar exists
 *   rating_gte=N         — rating >= N
 *   captured_after=ISO   — exif.captured_at > ISO
 *   limit=N (default 1000, max 20000)
 *
 * Mounted as its own Elysia plugin (sibling to assetsRoutes) so the bare
 * `GET /api/assets` doesn't collide with the `GET /api/assets/:id` route
 * defined in assets.ts.
 */

import { Elysia, t } from "elysia";
import type { Filter } from "mongodb";
import { assetsCollection } from "../db/client.ts";
import type { AssetDoc } from "../db/schema.ts";

export const assetsListRoutes = new Elysia({ prefix: "/api/assets" }).get(
  "/",
  async ({ query, set }) => {
    const filter: Filter<AssetDoc> = {};
    if (query.has_xmp === "1") filter.has_xmp = true;
    if (query.rating_gte !== undefined) {
      const v = Number.parseInt(query.rating_gte, 10);
      if (Number.isFinite(v)) filter.rating = { $gte: v };
    }
    if (query.captured_after !== undefined) {
      const d = new Date(query.captured_after);
      if (isNaN(d.getTime())) {
        set.status = 400;
        return { error: "captured_after must be an ISO 8601 date" };
      }
      // exif.captured_at is stored as an ISO 8601 string in the asset doc;
      // lexicographic comparison matches chronological comparison for
      // well-formed ISO strings.
      (filter as Filter<AssetDoc>)["exif.captured_at"] = {
        $gt: d.toISOString(),
      } as never;
    }
    const limit = Math.min(
      Math.max(Number.parseInt(query.limit ?? "1000", 10), 1),
      20000
    );
    const coll = await assetsCollection();
    const rows = await coll.find(filter).limit(limit).toArray();
    return {
      assets: rows.map((r) => ({
        id: r._id.toHexString(),
        folder_id: r.folder_id.toHexString(),
        filename: r.filename,
        abs_path: r.abs_path,
        mtime: r.mtime,
        rating: r.rating,
        has_xmp: r.has_xmp ?? false,
      })),
    };
  },
  {
    query: t.Object({
      has_xmp: t.Optional(t.String()),
      rating_gte: t.Optional(t.String()),
      captured_after: t.Optional(t.String()),
      limit: t.Optional(t.String()),
    }),
  }
);
