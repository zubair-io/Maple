/**
 * `GET /api/search/facets` — aggregation buckets for FE dropdowns.
 *
 * Six parallel aggregations (count, cameras, lenses, extensions, iso
 * range, capture range) sharing the same `finalFilter`. The route honours
 * every search filter so a faceted UI can show "cameras within the
 * current scope" rather than the global universe.
 */

import { Elysia } from 'elysia';
import { assetsCollection } from '../../db/client.ts';
import { hiddenPersonIds } from '../../people/people.repo.ts';
import { applyLiveFilter, buildFilter, SearchQueryT, type SearchQuery } from './query.ts';

export const facetsRoute = new Elysia().get(
  '/facets',
  async ({ query, set }) => {
    // Keep facet counts in agreement with the result list when the caller
    // excludes hidden people (opt-in; skips the lookup otherwise).
    const hiddenIds =
      (query as SearchQuery).excludeHiddenPeople === 'true' ? await hiddenPersonIds() : [];
    const filterOrError = buildFilter(query as SearchQuery, hiddenIds);
    if ('error' in filterOrError) {
      set.status = 400;
      return { error: filterOrError.error };
    }
    const filter = filterOrError;
    const coll = await assetsCollection();
    const finalFilter = applyLiveFilter(filter);

    const [
      total,
      cameraAgg,
      lensAgg,
      extAgg,
      isoAgg,
      capAgg,
      sceneAgg,
      activityAgg,
      subjectsAgg,
      screenshotAgg,
    ] = await Promise.all([
      coll.countDocuments(finalFilter),
      coll
        .aggregate([
          { $match: finalFilter },
          {
            $group: {
              _id: {
                make: '$exif.camera_make',
                model: '$exif.camera_model',
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
          { $group: { _id: '$exif.lens', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 50 },
        ])
        .toArray(),
      // Extensions: derive in Mongo via $split + $arrayElemAt — simpler
      // than $regexFindAll and works on every supported server version.
      // Post drop-abs-path-2026-05-21 the filename lives on
      // `fileinfo[0].filename`; pull it out before splitting on `.`.
      coll
        .aggregate([
          { $match: finalFilter },
          {
            $project: {
              ext: {
                $toLower: {
                  $arrayElemAt: [
                    {
                      $split: [{ $arrayElemAt: ['$fileinfo.filename', 0] }, '.'],
                    },
                    -1,
                  ],
                },
              },
            },
          },
          { $match: { ext: { $nin: [null, ''] } } },
          { $group: { _id: '$ext', count: { $sum: 1 } } },
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
              min: { $min: '$exif.iso' },
              max: { $max: '$exif.iso' },
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
              from: { $min: '$exif.captured_at' },
              to: { $max: '$exif.captured_at' },
            },
          },
        ])
        .toArray(),
      // Vision scene_type — scalar field, group directly.
      coll
        .aggregate([
          { $match: finalFilter },
          { $match: { 'vision.scene_type': { $nin: [null, ''] } } },
          { $group: { _id: '$vision.scene_type', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 20 },
        ])
        .toArray(),
      // Vision activity — scalar nullable field.
      coll
        .aggregate([
          { $match: finalFilter },
          { $match: { 'vision.activity': { $nin: [null, ''] } } },
          { $group: { _id: '$vision.activity', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 50 },
        ])
        .toArray(),
      // Vision subjects — array field; $unwind before $group so each
      // element gets its own bucket.
      coll
        .aggregate([
          { $match: finalFilter },
          { $unwind: '$vision.subjects' },
          { $match: { 'vision.subjects': { $nin: [null, ''] } } },
          { $group: { _id: '$vision.subjects', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 50 },
        ])
        .toArray(),
      // Screenshot tri-state: true / false / unknown (field absent on
      // legacy rows). Group on a $cond so the bucket key normalises.
      coll
        .aggregate([
          { $match: finalFilter },
          {
            $project: {
              bucket: {
                $cond: [
                  { $eq: ['$is_screenshot', true] },
                  'true',
                  {
                    $cond: [{ $eq: ['$is_screenshot', false] }, 'false', 'unknown'],
                  },
                ],
              },
            },
          },
          { $group: { _id: '$bucket', count: { $sum: 1 } } },
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
      .filter((r) => typeof r._id === 'string' && r._id.length > 0)
      .map((r) => ({ value: r._id as string, count: r.count as number }));
    const isoRow = isoAgg[0];
    const iso_range =
      isoRow && typeof isoRow.min === 'number' && typeof isoRow.max === 'number'
        ? { min: isoRow.min as number, max: isoRow.max as number }
        : null;
    const capRow = capAgg[0];
    const capture_range =
      capRow && typeof capRow.from === 'string' && typeof capRow.to === 'string'
        ? { from: capRow.from as string, to: capRow.to as string }
        : null;

    const scene_types = sceneAgg
      .filter((r) => typeof r._id === 'string' && r._id.length > 0)
      .map((r) => ({ value: r._id as string, count: r.count as number }));
    const activities = activityAgg
      .filter((r) => typeof r._id === 'string' && r._id.length > 0)
      .map((r) => ({ value: r._id as string, count: r.count as number }));
    const subjects = subjectsAgg
      .filter((r) => typeof r._id === 'string' && r._id.length > 0)
      .map((r) => ({ value: r._id as string, count: r.count as number }));

    const is_screenshot = {
      true: (screenshotAgg.find((r) => r._id === 'true')?.count as number | undefined) ?? 0,
      false: (screenshotAgg.find((r) => r._id === 'false')?.count as number | undefined) ?? 0,
      unknown: (screenshotAgg.find((r) => r._id === 'unknown')?.count as number | undefined) ?? 0,
    };

    return {
      total,
      cameras,
      lenses,
      extensions,
      iso_range,
      capture_range,
      scene_types,
      activities,
      subjects,
      is_screenshot,
    };
  },
  { query: SearchQueryT },
);
