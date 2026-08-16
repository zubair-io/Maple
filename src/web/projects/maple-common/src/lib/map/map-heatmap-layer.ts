// Pure MapLibre `heatmap` layer spec for the Map view's density overlay
// (Map T5, #2829). MapLibre GL ships a built-in `heatmap` layer type, so
// this is a styled layer over the SAME shared GeoJSON source pins bind to
// (`map-cluster-source.ts`) — one source feeding both layers means pins and
// heatmap can never disagree about what's on the map. No hand-rolled canvas
// overlay is needed here (that was only necessary on Apple, where MapKit has
// no heatmap type — see `MapHeatmapOverlay.swift`).
//
// Zoom breakpoints mirror Apple's `MapHeatmapZoomCrossfade` curve
// (`MapHeatmapZoomCrossfade.swift`, #2831) so both platforms read the same:
// the heatmap owns the low-zoom (country/continent-scale) view, where
// individual pins would be too sparse to read as "where are my photos," and
// fades out by the time the server's finer per-zoom grid cells (T1) already
// give legible clustered pins.

import type { HeatmapLayerSpecification } from 'maplibre-gl';

export const MAP_HEATMAP_LAYER_ID = 'maple-map-heatmap';

/** Fully opaque at/below this zoom — same convention as Apple's
 * `MapHeatmapZoomCrossfade.fadeStartZoom`. */
export const MAP_HEATMAP_FADE_START_ZOOM = 4;
/** Fully transparent at/above this zoom — same convention as Apple's
 * `MapHeatmapZoomCrossfade.fadeEndZoom`. */
export const MAP_HEATMAP_FADE_END_ZOOM = 10;

/** Cell `count` at/above which `heatmap-weight` maxes out — high enough that
 * a single mega-hotspot cell doesn't wash out the rest of the density ramp
 * by comparison. */
const WEIGHT_MAX_COUNT = 50;

/** Builds the heatmap layer spec reading from `sourceId` (the shared
 * cluster source `MAP_CLUSTER_SOURCE_ID` feeds). Pure — no `Map` instance
 * required — so it's directly unit-testable without the real SDK. */
export function buildHeatmapLayer(sourceId: string): HeatmapLayerSpecification {
  return {
    id: MAP_HEATMAP_LAYER_ID,
    type: 'heatmap',
    source: sourceId,
    paint: {
      // Denser cells burn hotter. Clamps at `WEIGHT_MAX_COUNT` rather than
      // scaling unbounded, so a single outlier cell can't flatten the ramp
      // for every other cell on the map.
      'heatmap-weight': ['interpolate', ['linear'], ['get', 'count'], 1, 0.1, WEIGHT_MAX_COUNT, 1],
      // Compensates for `heatmap-radius` shrinking the point footprint at
      // low zoom by boosting per-point intensity, so the low-zoom view (the
      // heatmap's whole reason for existing) still reads as a legible
      // density gradient rather than a scatter of faint dots.
      'heatmap-intensity': [
        'interpolate',
        ['linear'],
        ['zoom'],
        0,
        1,
        MAP_HEATMAP_FADE_END_ZOOM,
        3,
      ],
      'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 0, 6, MAP_HEATMAP_FADE_END_ZOOM, 24],
      // Transparent → cool → hot density ramp (standard heatmap gradient).
      'heatmap-color': [
        'interpolate',
        ['linear'],
        ['heatmap-density'],
        0,
        'rgba(33,102,172,0)',
        0.2,
        'rgb(103,169,207)',
        0.4,
        'rgb(209,229,240)',
        0.6,
        'rgb(253,219,199)',
        0.8,
        'rgb(239,138,98)',
        1,
        'rgb(178,24,43)',
      ],
      // Zoom crossfade: the heatmap owns the low-zoom view and fades out as
      // the pin layer's finer per-zoom grid cells take over — see module doc.
      'heatmap-opacity': [
        'interpolate',
        ['linear'],
        ['zoom'],
        MAP_HEATMAP_FADE_START_ZOOM,
        1,
        MAP_HEATMAP_FADE_END_ZOOM,
        0,
      ],
    },
  };
}
