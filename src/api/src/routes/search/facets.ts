/**
 * `GET /api/search/facets` — aggregation buckets for FE dropdowns.
 *
 * Six parallel aggregations (count, cameras, lenses, extensions, iso
 * range, capture range) sharing the same `finalFilter`. The route honours
 * every search filter so a faceted UI can show "cameras within the
 * current scope" rather than the global universe.
 */

import { Elysia } from 'elysia';
import { ObjectId } from 'mongodb';
import { assetsCollection } from '../../db/client.ts';
import { hiddenPersonIds } from '../../people/people.repo.ts';
import { namesForPersonIds, personIdsForNames } from '../../people/people-search-filter.repo.ts';
import {
  applyLiveFilter,
  buildFilter,
  peopleNames,
  SearchQueryT,
  type SearchQuery,
} from './query.ts';

/** Display label for one `place.rollups` bucket — the exact wire value the
 * `place` filter param parses back (`placeLabelClause` in
 * `filter-terms.ts`): "locality, region" when both are set, the bare
 * non-blank half otherwise. `''` normalises to blank exactly like the
 * clause's `BLANK_HALF`, so a label can never be the empty string and
 * every emitted label round-trips. */
function placeLabel(locality: string | null, region: string | null): string | null {
  const loc = locality || null;
  const reg = region || null;
  if (loc !== null && reg !== null) return `${loc}, ${reg}`;
  return loc ?? reg;
}

/** Canonical (lowercase) hex for a person-id aggregation key, so the map
 * lookup against `namesForPersonIds`' `toHexString()` keys can't miss on
 * case. Invalid ids pass through untouched — they simply find no name. */
function canonicalHex(id: string): string {
  return ObjectId.isValid(id) ? new ObjectId(id).toHexString() : id;
}

export const facetsRoute = new Elysia().get(
  '/facets',
  async ({ query, set }) => {
    // Keep facet counts in agreement with the result list when the caller
    // excludes hidden people (opt-in; skips the lookup otherwise).
    const hiddenIds =
      (query as SearchQuery).excludeHiddenPeople === 'true' ? await hiddenPersonIds() : [];
    // Names → person ids, same contract as the list route: facet counts must
    // agree with the result list when a person filter is active.
    const peopleIds = await personIdsForNames(peopleNames((query as SearchQuery).people));
    const filterOrError = buildFilter(query as SearchQuery, hiddenIds, peopleIds);
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
      peopleAgg,
      placesAgg,
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
      // People (#2864) — assets per assigned person. Group on the DISTINCT
      // person ids per asset (not per face) so a group shot with the same
      // person detected twice counts once; the id → name join happens in JS
      // below (`namesForPersonIds`), where hidden and merged-away persons
      // drop out. A hidden FACE can't contribute — hiding a face nulls its
      // `person_id`, and the `$ne: null` match drops unassigned faces.
      coll
        .aggregate([
          { $match: finalFilter },
          {
            $project: {
              person_ids: {
                $setUnion: [
                  {
                    $map: {
                      input: { $ifNull: ['$faces', []] },
                      as: 'f',
                      in: '$$f.person_id',
                    },
                  },
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
        ])
        .toArray(),
      // Places (#2864) — assets per geocode rollup tuple. The tuple → label
      // rule lives in `placeLabel` and must stay the inverse of
      // `placeLabelClause` in `query.ts`.
      coll
        .aggregate([
          { $match: finalFilter },
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
              _id: {
                locality: '$place.rollups.locality',
                region: '$place.rollups.region',
              },
              count: { $sum: 1 },
            },
          },
          { $sort: { count: -1 } },
          { $limit: 100 },
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

    // Join the person-id buckets to display names; ids whose person is
    // hidden, merged away, or gone drop out (count order is preserved).
    const personNames = await namesForPersonIds(
      peopleAgg.map((r) => canonicalHex(r._id as string)),
    );
    const people = peopleAgg
      .map((r) => ({
        value: personNames.get(canonicalHex(r._id as string)),
        count: r.count as number,
      }))
      .filter((r): r is { value: string; count: number } => typeof r.value === 'string');

    // Label the place tuples. Two tuples can produce the same label (a
    // region-less locality and a locality-less region with the same text) —
    // merge their counts, matching `placeLabelClause`'s both-halves OR.
    const placeCounts = new Map<string, number>();
    for (const r of placesAgg) {
      const id = r._id as { locality: string | null; region: string | null };
      const label = placeLabel(id.locality ?? null, id.region ?? null);
      if (label === null) continue;
      placeCounts.set(label, (placeCounts.get(label) ?? 0) + (r.count as number));
    }
    const places = [...placeCounts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count);

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
      people,
      places,
    };
  },
  { query: SearchQueryT },
);
