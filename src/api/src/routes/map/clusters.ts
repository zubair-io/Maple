/**
 * `GET /api/map/clusters` — zoom-dependent grid aggregation feeding both
 * the heatmap and the clustered pins on the Map view (design:
 * `docs/superpowers/specs/2026-08-14-photo-map-view-design.md`; ticket
 * #2825, part of epic #2824).
 *
 * Mirrors `search/buckets.ts`'s shape: reuse the shared `buildFilter` +
 * `applyLiveFilter` so the map respects whatever search filters the
 * caller already has active, then additionally require an in-viewport
 * GPS point and bucket the survivors into a zoom-sized lat/lng grid via
 * plain `$floor` arithmetic — no geohash/tiling dependency. Payload size
 * is bounded by the number of *cells* the viewport can show, not by
 * library size (root CLAUDE.md performance invariants).
 */

import { Elysia, t } from 'elysia';
import type { ObjectId } from 'mongodb';
import { assetsCollection } from '../../db/client.ts';
import type { FileInfo } from '../../db/schema.ts';
import { assetAbsPath, assetPrimaryFileInfo } from '../../indexer/images.repo.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import { hiddenPersonIds } from '../../people/people.repo.ts';
import {
  applyLiveFilter,
  buildFilter,
  clampInt,
  SearchQueryT,
  type SearchQuery,
} from '../search/query.ts';

/** The `/api/map/clusters` query-string contract: every `/api/search`
 * filter param (so the map respects the caller's active search filters)
 * plus the viewport shape. Declared by spreading `SearchQueryT`'s
 * properties rather than re-typing them so the two schemas can never
 * drift apart. */
interface MapClustersQuery extends SearchQuery {
  /** `west,south,east,north` viewport bounds in decimal degrees. */
  bbox?: string;
  /** Integer zoom level — selects the grid cell size (see
   * `cellSizeDegForZoom`). */
  zoom?: string;
}

const MapClustersQueryT = t.Object({
  ...SearchQueryT.properties,
  bbox: t.Optional(t.String()),
  zoom: t.Optional(t.String()),
});

/** Grid resolution bounds. Mirrors the range of zoom levels a slippy-map
 * client actually presents: 0 is the coarsest grid (one 360°-wide cell
 * edge) and 20 is building-scale. Note that zoom 0 is NOT "the whole
 * world in a single cell" — `$floor` puts negative and non-negative
 * coordinates in different cells, so the coarsest grid still splits at
 * the equator and the prime meridian. That's the same behaviour a tile
 * grid has and it costs nothing here (the cap below is what actually
 * bounds cell count), so the math is left alone. */
const MIN_ZOOM = 0;
const MAX_ZOOM = 20;
const DEFAULT_ZOOM = 10;

/**
 * Ceiling on the cells one response may span, enforced per axis as
 * `sqrt(MAX_GRID_CELLS)` = 64. This is what makes the endpoint's central
 * promise true — "payload bounded to the number of visible cells" — for
 * *every* input rather than only well-formed ones: `bbox` and `zoom`
 * arrive as independent params, so a caller can ask for a whole-world
 * bbox at zoom 20, where the requested cell is 0.0003° and the number of
 * occupied cells degenerates to one per asset. That would put both the
 * response size and the `$group` hash table at O(library size) instead of
 * O(viewport). 64×64 is far more distinct pins/heatmap cells than a
 * screen can usefully show.
 */
const MAX_CELLS_PER_AXIS = 64;

/**
 * Degrees per grid cell at a given zoom: halves on every zoom step (the
 * same "world / 2^zoom" halving slippy-map tile grids use), applied
 * identically to both axes. This is a plain equirectangular grid, not a
 * Mercator projection — cells narrow (in real-world distance) toward the
 * poles, same as the reference tile grid. Good enough for bucketing: the
 * client needs stable, zoom-proportional cell counts for a heatmap/
 * cluster view, not geodesic-accurate cell areas.
 */
function cellSizeDegForZoom(zoom: number): number {
  return 360 / Math.pow(2, zoom);
}

interface ParsedBbox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Longitude degrees the viewport covers, taking the antimeridian-
 * crossing case (`west > east`) the long way round. */
function bboxLngSpanDeg(bbox: ParsedBbox): number {
  return bbox.west <= bbox.east ? bbox.east - bbox.west : 360 - (bbox.west - bbox.east);
}

/**
 * The cell size actually used: the zoom's own cell, widened if needed so
 * neither axis spans more than `MAX_CELLS_PER_AXIS` cells. Coarsening
 * (rather than rejecting the request or truncating the result with a
 * `$limit`) keeps the response a complete, if lower-resolution, picture
 * of the viewport — which is what a heatmap/cluster view wants; dropping
 * cells would silently lose photos from the map.
 */
function effectiveCellSizeDeg(zoom: number, bbox: ParsedBbox): number {
  const requested = cellSizeDegForZoom(zoom);
  const minForLat = (bbox.north - bbox.south) / MAX_CELLS_PER_AXIS;
  const minForLng = bboxLngSpanDeg(bbox) / MAX_CELLS_PER_AXIS;
  return Math.max(requested, minForLat, minForLng);
}

const LAT_LIMIT_DEG = 90;
const LNG_LIMIT_DEG = 180;

/** True when `value` lies within ±`limit` inclusive. */
function withinAbs(value: number, limit: number): boolean {
  return value >= -limit && value <= limit;
}

/** Parse+validate the `bbox` param. Returns `{ error }` for a missing or
 * malformed value — bbox is required because it's what bounds the
 * aggregation's cost and payload size; there is no sane "whole world"
 * default for a per-viewport endpoint.
 *
 * Note the deliberate asymmetry between the two axes: `south > north` is
 * rejected, but `west > east` is NOT — that's the legitimate
 * antimeridian-crossing viewport the handler special-cases below. There
 * is no equivalent wrap-around at the poles. */
function parseBbox(raw: string | undefined): ParsedBbox | { error: string } {
  const parts = (raw ?? '').split(',').map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    return { error: 'Invalid or missing bbox: expected west,south,east,north' };
  }
  const [west, south, east, north] = parts as [number, number, number, number];
  const latsValid = withinAbs(south, LAT_LIMIT_DEG) && withinAbs(north, LAT_LIMIT_DEG);
  if (!latsValid || south > north) {
    return { error: 'Invalid bbox: bad latitude range' };
  }
  if (!withinAbs(west, LNG_LIMIT_DEG) || !withinAbs(east, LNG_LIMIT_DEG)) {
    return { error: 'Invalid bbox: bad longitude range' };
  }
  return { west, south, east, north };
}

/** Fallback chain for a cell's place label: locality → region → country
 * code → null. A pin click needs SOME label to build a `placeQuery`
 * from even when the geocoder only resolved a coarse level (rural,
 * ocean, or aerial shots often have no `locality`). */
function placeLabelFrom(
  locality: string | null | undefined,
  region: string | null | undefined,
  countryCode: string | null | undefined,
): string | null {
  return locality || region || countryCode || null;
}

/** One cell's representative asset, carried out of the `$group` as a
 * single sub-document so the id and the fields read off that asset can't
 * disagree (see the `$top` accumulator in the pipeline). */
interface ClusterRepresentative {
  id: ObjectId;
  fileinfo: FileInfo[] | undefined;
  locality: string | null | undefined;
  region: string | null | undefined;
  countryCode: string | null | undefined;
}

interface ClusterGroupRow {
  _id: { lat: number; lng: number };
  count: number;
  avgLat: number;
  avgLng: number;
  representative: ClusterRepresentative;
}

interface MapCluster {
  lat: number;
  lng: number;
  count: number;
  representativeAssetId: string;
  placeLabel: string | null;
  /** The representative asset's absolute filesystem path — the same
   * value `/api/fs/thumb?path=` expects. Present only on single-asset
   * cells: once a cell holds more than one photo there is no single
   * representative image to draw as a thumbnail pin, so the client
   * renders a count bubble instead. */
  thumbKey?: string;
}

export const mapClustersRoute = new Elysia().get(
  '/clusters',
  async ({ query, set }) => {
    const q = query as MapClustersQuery;

    const bbox = parseBbox(q.bbox);
    if ('error' in bbox) {
      set.status = 400;
      return { error: bbox.error };
    }
    const zoom = clampInt(q.zoom, MIN_ZOOM, MAX_ZOOM, DEFAULT_ZOOM);
    const cellSizeDeg = effectiveCellSizeDeg(zoom, bbox);

    // Opt-in hidden-people exclusion — same pattern as buckets.ts/facets.ts.
    const hiddenIds = q.excludeHiddenPeople === 'true' ? await hiddenPersonIds() : [];
    const filterOrError = buildFilter(q as SearchQuery, hiddenIds);
    if ('error' in filterOrError) {
      set.status = 400;
      return { error: filterOrError.error };
    }
    const finalFilter = applyLiveFilter(filterOrError);

    // `finalFilter`'s only top-level key is always `$and` (or, when
    // `buildFilter` used `$text`, a handful of literal field keys plus
    // `$and`) — see `applyLiveFilter`'s doc comment. Mongo ANDs sibling
    // top-level operators/fields implicitly, so spreading in the GPS +
    // bbox predicates alongside it is safe and needs no extra `$and`
    // wrapper.
    const matchFilter: Record<string, unknown> = {
      ...finalFilter,
      'exif.gps': { $ne: null },
      'exif.gps.lat': { $gte: bbox.south, $lte: bbox.north },
    };
    if (bbox.west <= bbox.east) {
      matchFilter['exif.gps.lng'] = { $gte: bbox.west, $lte: bbox.east };
    } else {
      // Antimeridian-crossing viewport (west > east, e.g. west=170,
      // east=-170): "inside the bbox" is everything east of `west` OR
      // west of `east`. This keeps the $match FILTER correct across the
      // seam. Grid bucketing below is NOT merged across it — a point at
      // lng=179.9 and one at lng=-179.9 land in different cells even
      // though they're physically adjacent. That's an accepted,
      // explicitly-called-out limitation for a density/cluster view (not
      // a silent bug): the antimeridian is mid-ocean for every inhabited
      // landmass, so a cell split there costs nothing in practice.
      matchFilter.$or = [
        { 'exif.gps.lng': { $gte: bbox.west } },
        { 'exif.gps.lng': { $lte: bbox.east } },
      ];
    }

    const coll = await assetsCollection();
    const rows = await coll
      .aggregate<ClusterGroupRow>([
        { $match: matchFilter as never },
        {
          $addFields: {
            __cellLat: { $floor: { $divide: ['$exif.gps.lat', cellSizeDeg] } },
            __cellLng: { $floor: { $divide: ['$exif.gps.lng', cellSizeDeg] } },
          },
        },
        {
          // `$top` (sortBy `_id`) rather than a pipeline-level `$sort`
          // feeding `$first`: it picks each cell's representative WITHIN
          // the group, so the pipeline never has to order the matched set
          // as a whole. A pre-`$group` `{ $sort: { _id: 1 } }` is a
          // blocking stage over every located asset in the viewport —
          // O(library) memory and runtime at low zoom on a big library,
          // the one part of this pipeline that genuinely could not be
          // bounded by the `$match`. Sorting inside the accumulator also
          // keeps the id and the fields read off that same asset
          // consistent by construction, which a `$min` id plus separate
          // `$first` fields would not guarantee.
          //
          // Cell count is capped (see MAX_CELLS_PER_AXIS), so the group's
          // hash table holds at most ~4k of these sub-documents — hence
          // no `allowDiskUse`: there is no longer a stage here whose
          // memory scales with the number of matched assets.
          $group: {
            _id: { lat: '$__cellLat', lng: '$__cellLng' },
            count: { $sum: 1 },
            avgLat: { $avg: '$exif.gps.lat' },
            avgLng: { $avg: '$exif.gps.lng' },
            representative: {
              $top: {
                sortBy: { _id: 1 },
                output: {
                  id: '$_id',
                  fileinfo: '$fileinfo',
                  locality: '$place.rollups.locality',
                  region: '$place.rollups.region',
                  countryCode: '$place.rollups.country_code',
                },
              },
            },
          },
        },
      ])
      .toArray();

    const libraries = await loadLibraryRoots().catch(() => new Map<string, string>());

    const cells: MapCluster[] = rows.map((r) => {
      const rep = r.representative;
      const cell: MapCluster = {
        lat: r.avgLat,
        lng: r.avgLng,
        count: r.count,
        representativeAssetId: rep.id.toHexString(),
        placeLabel: placeLabelFrom(rep.locality, rep.region, rep.countryCode),
      };
      if (r.count === 1) {
        const asset = { fileinfo: rep.fileinfo };
        const primary = assetPrimaryFileInfo(asset);
        const absPath = primary ? assetAbsPath(asset, libraries) : null;
        if (absPath) {
          cell.thumbKey = absPath;
        }
      }
      return cell;
    });

    return { cells };
  },
  { query: MapClustersQueryT },
);
