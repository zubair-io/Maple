// MapHeatmapLayerService unit tests (Map T5, #2829).
//
// Drives the service against a fake `MapLibreMapHandle` (no real
// `maplibre-gl`, same rationale as the other map specs in this directory).

import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { MAP_CLUSTER_SOURCE_ID } from './map-cluster-source';
import { MapHeatmapLayerService } from './map-heatmap-layer.service';
import type { MapLibreMapHandle } from './maplibre-instance-factory';

function fakeHandle(overrides: Partial<MapLibreMapHandle> = {}): MapLibreMapHandle {
  return {
    onError: vi.fn(),
    onMoveEnd: vi.fn(),
    remove: vi.fn(),
    getBounds: vi.fn(),
    getZoom: vi.fn(),
    addSource: vi.fn(),
    setSourceData: vi.fn(),
    addMarker: vi.fn(),
    addHeatmapLayer: vi.fn(),
    ...overrides,
  } as MapLibreMapHandle;
}

describe('MapHeatmapLayerService', () => {
  it('adds the heatmap layer bound to the SAME shared cluster source id pins use', () => {
    TestBed.configureTestingModule({ providers: [MapHeatmapLayerService] });
    const service = TestBed.inject(MapHeatmapLayerService);
    const handle = fakeHandle();

    service.attach(handle);

    expect(handle.addHeatmapLayer).toHaveBeenCalledExactlyOnceWith(MAP_CLUSTER_SOURCE_ID);
  });
});
