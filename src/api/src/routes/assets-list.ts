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
 *
 * Mongo access lives in `src/db/assets.repo.ts` — this route is
 * validation + repo dispatch only.
 */

import { Elysia, t } from "elysia";
import { findListItems, type ListFilter } from "../db/assets.repo.ts";

export const assetsListRoutes = new Elysia({ prefix: "/api/assets" }).get(
  "/",
  async ({ query, set }) => {
    const filter: ListFilter = { liveOnly: true };
    if (query.has_xmp === "1") filter.hasXmp = true;
    if (query.rating_gte !== undefined) {
      // L: reject non-integer rating_gte rather than silently broaden
      // the result set. Garbage input was previously dropped and the
      // filter ran without a rating predicate, which is a quiet bug.
      const v = Number.parseInt(query.rating_gte, 10);
      if (!Number.isFinite(v)) {
        set.status = 400;
        return { error: "rating_gte must be an integer" };
      }
      filter.ratingGte = v;
    }
    if (query.captured_after !== undefined) {
      const d = new Date(query.captured_after);
      if (isNaN(d.getTime())) {
        set.status = 400;
        return { error: "captured_after must be an ISO 8601 date" };
      }
      filter.capturedAfterIso = d.toISOString();
    }
    // Validate `limit` here rather than letting `Number.parseInt` pass
    // `NaN` through to the repo's `Math.min(Math.max(NaN, 1), 20000)`
    // (which propagates NaN, then turns into an unbounded find). Reject
    // garbage with 400; the repo still clamps as a defensive backstop.
    let limit: number;
    if (query.limit === undefined) {
      limit = 1000;
    } else {
      const parsed = Number.parseInt(query.limit, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        set.status = 400;
        return { error: "limit must be a positive integer" };
      }
      limit = parsed;
    }
    const assets = await findListItems(filter, limit);
    return { assets };
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
