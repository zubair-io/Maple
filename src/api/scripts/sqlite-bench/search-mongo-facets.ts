/**
 * The MongoDB half of the facet comparison: the `$group` pipelines
 * `routes/search/facets.ts` runs, as data.
 *
 * They are copied rather than imported because the route builds them inside its
 * Elysia handler, and the point of this slice is that the Mongo path is left
 * alone — refactoring a live route so a benchmark can reach into it would be a
 * worse trade than a mirrored copy with this comment on it. The `$match` stage
 * is *not* copied: the live filter comes from the route's own `buildFilter` and
 * `applyLiveFilter`, which are exported and pure, so the half of the query that
 * decides which documents participate cannot drift.
 *
 * Only the eleven aggregations are here. The twelfth, `total`, is a
 * `countDocuments` rather than a pipeline, and the caller issues it directly.
 */

import type { Filter } from 'mongodb';
import type { AssetDoc } from '../../src/db/schema.ts';
import { applyLiveFilter, buildFilter } from '../../src/routes/search/query.ts';

/** Exactly the filter an unfiltered `/api/search/facets` request produces. */
export function mongoLiveFilter(): Filter<AssetDoc> {
  const filter = buildFilter({});
  if ('error' in filter) throw new Error(filter.error);
  return applyLiveFilter(filter);
}

/**
 * The stages after `$match`, keyed by the facet name the SQLite side uses, so
 * the two halves line up row for row in the comparison table.
 */
export const MONGO_FACET_PIPELINES: Record<string, object[]> = {
  cameras: [
    {
      $group: {
        _id: { make: '$exif.camera_make', model: '$exif.camera_model' },
        count: { $sum: 1 },
      },
    },
    { $sort: { count: -1 } },
    { $limit: 50 },
  ],
  lenses: [
    { $group: { _id: '$exif.lens', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 50 },
  ],
  extensions: [
    {
      $project: {
        ext: {
          $toLower: {
            $arrayElemAt: [{ $split: [{ $arrayElemAt: ['$fileinfo.filename', 0] }, '.'] }, -1],
          },
        },
      },
    },
    { $match: { ext: { $nin: [null, ''] } } },
    { $group: { _id: '$ext', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 50 },
  ],
  iso_range: [{ $group: { _id: null, min: { $min: '$exif.iso' }, max: { $max: '$exif.iso' } } }],
  capture_range: [
    {
      $group: { _id: null, from: { $min: '$exif.captured_at' }, to: { $max: '$exif.captured_at' } },
    },
  ],
  scene_types: [
    { $match: { 'vision.scene_type': { $nin: [null, ''] } } },
    { $group: { _id: '$vision.scene_type', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 20 },
  ],
  activities: [
    { $match: { 'vision.activity': { $nin: [null, ''] } } },
    { $group: { _id: '$vision.activity', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 50 },
  ],
  subjects: [
    { $unwind: '$vision.subjects' },
    { $match: { 'vision.subjects': { $nin: [null, ''] } } },
    { $group: { _id: '$vision.subjects', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 50 },
  ],
  is_screenshot: [
    {
      $project: {
        bucket: {
          $cond: [
            { $eq: ['$is_screenshot', true] },
            'true',
            { $cond: [{ $eq: ['$is_screenshot', false] }, 'false', 'unknown'] },
          ],
        },
      },
    },
    { $group: { _id: '$bucket', count: { $sum: 1 } } },
  ],
  people: [
    {
      $project: {
        person_ids: {
          $setUnion: [
            { $map: { input: { $ifNull: ['$faces', []] }, as: 'f', in: '$$f.person_id' } },
            [],
          ],
        },
      },
    },
    { $unwind: '$person_ids' },
    { $match: { person_ids: { $nin: [null, ''] } } },
    { $group: { _id: '$person_ids', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 100 },
  ],
  places: [
    {
      $match: {
        $or: [
          { 'place.rollups.locality': { $nin: [null, ''] } },
          { 'place.rollups.region': { $nin: [null, ''] } },
        ],
      },
    },
    {
      $group: {
        _id: { locality: '$place.rollups.locality', region: '$place.rollups.region' },
        count: { $sum: 1 },
      },
    },
    { $sort: { count: -1 } },
    { $limit: 100 },
  ],
};
