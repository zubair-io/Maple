// map-heatmap-layer.ts unit tests (Map T5, #2829).
//
// Pure-function tests — no MapLibre `Map` instance involved — covering the
// three contract points the ticket calls out: `heatmap-weight` bound to the
// `count` feature property, a zoom-interpolated `heatmap-opacity` that's
// visible at low zoom and ~0 at high zoom, and (the regression guard against
// a future second source) that the built layer's `source` is exactly whatever
// id the caller passes in — the same shared id the pins layer uses.

import { describe, expect, it } from 'vitest';
import {
  MAP_HEATMAP_FADE_END_ZOOM,
  MAP_HEATMAP_FADE_START_ZOOM,
  MAP_HEATMAP_LAYER_ID,
  buildHeatmapLayer,
} from './map-heatmap-layer';

describe('buildHeatmapLayer', () => {
  it('is a heatmap-type layer reading from the given source id', () => {
    const layer = buildHeatmapLayer('some-shared-source');

    expect(layer.id).toBe(MAP_HEATMAP_LAYER_ID);
    expect(layer.type).toBe('heatmap');
    expect(layer.source).toBe('some-shared-source');
  });

  it('weights by the count feature property', () => {
    const layer = buildHeatmapLayer('src');

    const weight = layer.paint?.['heatmap-weight'];
    expect(weight).toEqual(expect.arrayContaining(['interpolate', ['linear'], ['get', 'count']]));
  });

  it('is fully opaque at or below the fade-start zoom', () => {
    const layer = buildHeatmapLayer('src');

    const opacity = layer.paint?.['heatmap-opacity'] as unknown[];
    // ['interpolate', ['linear'], ['zoom'], startZoom, startValue, endZoom, endValue]
    expect(opacity[3]).toBe(MAP_HEATMAP_FADE_START_ZOOM);
    expect(opacity[4]).toBe(1);
  });

  it('fades to fully transparent at or above the fade-end zoom', () => {
    const layer = buildHeatmapLayer('src');

    const opacity = layer.paint?.['heatmap-opacity'] as unknown[];
    expect(opacity[5]).toBe(MAP_HEATMAP_FADE_END_ZOOM);
    expect(opacity[6]).toBe(0);
  });

  it('fade-end zoom is strictly after fade-start zoom', () => {
    expect(MAP_HEATMAP_FADE_END_ZOOM).toBeGreaterThan(MAP_HEATMAP_FADE_START_ZOOM);
  });
});
