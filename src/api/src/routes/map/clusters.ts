/**
 * `GET /api/map/clusters` — zoom-dependent grid aggregation feeding both
 * the heatmap and the clustered pins on the Map view (design:
 * `docs/superpowers/specs/2026-08-14-photo-map-view-design.md`; ticket
 * #2825, part of epic #2824).
 *
 * Mirrors `search/buckets.ts`'s shape: reuse the shared query translation
 * so the map respects whatever search filters the caller already has
 * active, then additionally require an in-viewport GPS point and bucket
 * the survivors into a zoom-sized lat/lng grid with plain `floor`
 * arithmetic — no geohash/tiling dependency. Payload size is bounded by
 * the number of *cells* the viewport can show, not by library size (root
 * CLAUDE.md performance invariants).
 *
 * The grouping itself lives in `db/repos/map-clusters.repo.ts`;
 * everything in this file is viewport arithmetic and wire shaping.
 */

import { Elysia, t } from 'elysia';
import { mapClusters } from '../../db/repos/map-clusters.repo.ts';
import { buildSearchWhere } from '../../db/repos/search.where.ts';
import { assetAbsPath, assetPrimaryFileInfo } from '../../indexer/images.repo.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import { personIdsToDrop } from '../../db/repos/people.visibility.ts';
import { clampInt, SearchQueryT, type SearchQuery } from '../search/query.ts';

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
 * Floor on how coarse the grid may get, as a subdivision of the viewport.
 * Without this the endpoint could return a single cell covering the entire
 * visible map, which is useless as pins (one bubble, no zoom reveal) and
 * useless as a heatmap (one uniform blob) — and it silently disables
 * thumbnail pins entirely, because `thumbKey` is only emitted for
 * `count == 1` cells and one cell holding every visible photo is never 1.
 *
 * That is not hypothetical: it was the observed behaviour on Apple TV
 * (#2856). `zoom` and `bbox` arrive as independent params and every client
 * derives zoom from its own viewport span (`log2(360 / lonDelta)`), which
 * made the requested cell exactly one viewport wide at every zoom level.
 * Deriving the bound from the viewport rather than trusting `zoom` keeps
 * the endpoint correct for any client's zoom convention, so a single client
 * getting that arithmetic wrong can no longer flatten the whole feature.
 */
const MIN_CELLS_PER_AXIS = 8;

/**
 * The cell size actually used: the zoom's own cell, clamped into the window
 * the viewport can usefully support.
 *
 * - Widened (coarsened) so neither axis exceeds `MAX_CELLS_PER_AXIS` cells,
 *   bounding response size and `$group` memory. Coarsening rather than
 *   rejecting the request or truncating with a `$limit` keeps the response a
 *   complete, if lower-resolution, picture of the viewport — dropping cells
 *   would silently lose photos from the map.
 * - Narrowed (refined) so each axis is divided into at least
 *   `MIN_CELLS_PER_AXIS` cells, so there is always a real grid to cluster
 *   and heat-map over.
 *
 * `zoom` therefore acts as a hint within that window: a client asking for a
 * sensible cell size gets exactly it, while a client whose zoom convention
 * disagrees with this grid still gets a usable viewport subdivision.
 */
function effectiveCellSizeDeg(zoom: number, bbox: ParsedBbox): number {
  const latSpan = bbox.north - bbox.south;
  const lngSpan = bboxLngSpanDeg(bbox);
  // Finest permitted: the tighter axis governs, so neither exceeds the cap.
  const finest = Math.max(latSpan / MAX_CELLS_PER_AXIS, lngSpan / MAX_CELLS_PER_AXIS);
  // Coarsest permitted: the *looser* axis governs, so both are subdivided.
  const coarsest = Math.min(latSpan / MIN_CELLS_PER_AXIS, lngSpan / MIN_CELLS_PER_AXIS);
  const requested = cellSizeDegForZoom(zoom);
  // The window collapses on a viewport skewed past MAX/MIN (one axis wants a
  // finer floor than the other axis' ceiling allows), and degenerately on a
  // zero-span bbox — `south == north` / `west == east` pass validation, so a
  // client mid-gesture can send one. Drop the impossible `coarsest` bound but
  // keep honouring `zoom` above the cost ceiling: returning `finest` outright
  // would peg a skewed viewport to maximum resolution (making zoom a no-op
  // there), and on a point bbox `finest` is 0, which reaches `$divide` and
  // fails the aggregation as soon as any document matches.
  if (!(coarsest > finest)) return Math.max(requested, finest);
  return Math.min(Math.max(requested, finest), coarsest);
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

    // Same id set as the search routes (see `personIdsToDrop`).
    const dropIds = await personIdsToDrop(q.excludeHiddenPeople);
    const where = buildSearchWhere(q as SearchQuery, dropIds);
    if ('error' in where) {
      set.status = 400;
      return { error: where.error };
    }

    // The viewport is handed to the repository as its own predicate rather
    // than folded into the translated query. Keeping the two apart is what
    // makes every clause restrictive no matter what the search translation
    // contributes — the same reasoning `buckets.ts` records, where a naive
    // merge of an `$or` once dropped the live-row constraint and let
    // soft-deleted rows into a count.
    //
    // Note the bbox makes the FILTER correct across the antimeridian. Grid
    // bucketing is NOT merged across it — a point at lng=179.9 and one at
    // lng=-179.9 land in different cells even though they're physically
    // adjacent. That's an accepted, explicitly-called-out limitation for a
    // density/cluster view (not a silent bug): the antimeridian is mid-ocean
    // for every inhabited landmass, so a cell split there costs nothing in
    // practice.
    const rows = await mapClusters(where, bbox, cellSizeDeg);

    const libraries = await loadLibraryRoots().catch(() => new Map<string, string>());

    const cells: MapCluster[] = rows.map((r) => {
      const cell: MapCluster = {
        lat: r.avgLat,
        lng: r.avgLng,
        count: r.count,
        representativeAssetId: r.representativeId,
        placeLabel: placeLabelFrom(r.locality, r.region, r.countryCode),
      };
      if (r.count === 1) {
        const asset = { fileinfo: r.fileinfo };
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
