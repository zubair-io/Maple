/**
 * `GET /api/search/facets` — aggregation buckets for FE dropdowns.
 *
 * Six parallel aggregations (count, cameras, lenses, extensions, iso
 * range, capture range) sharing the same `finalFilter`. The route honours
 * every search filter so a faceted UI can show "cameras within the
 * current scope" rather than the global universe.
 */

import { Elysia } from "elysia";
import { assetsCollection } from "../../db/client.ts";
import { applyLiveFilter, buildFilter, SearchQueryT, type SearchQuery } from "./query.ts";

export const facetsRoute = new Elysia().get(
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
);
