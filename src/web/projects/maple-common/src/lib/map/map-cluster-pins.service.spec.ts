// MapClusterPinsService unit tests (Map T4, #2828).
//
// Drives the service against a fake `MapLibreMapHandle` (no real
// `maplibre-gl`, same rationale as `maplibre-map.service.spec.ts`) and a
// stubbed `MapClustersService`/`FilesystemBrowseService`/`Router` so these
// tests focus purely on: fetch bbox/zoom + debounce, GeoJSON source
// updates, thumbnail-pin vs count-bubble marker rendering, pin-click
// navigation (+ the no-`placeLabel` fallback), the empty-viewport state,
// and marker recycling across overlapping fetches.

import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { Subject, of, throwError } from 'rxjs';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FilesystemBrowseService } from '../api/filesystem-browse.service';
import { MapClustersService, type MapCluster } from '../api/map-clusters.service';
import { MAP_CLUSTER_SOURCE_ID } from './map-cluster-source';
import { MapClusterPinsService } from './map-cluster-pins.service';
import type { MapLibreMapHandle, MapLibreMarkerHandle } from './maplibre-instance-factory';

class FakeMarker implements MapLibreMarkerHandle {
  removed = false;
  remove(): void {
    this.removed = true;
  }
}

class FakeMapHandle implements MapLibreMapHandle {
  moveEndHandler: (() => void) | null = null;
  sources = new Map<string, unknown>();
  markers: Array<{ element: HTMLElement; lngLat: [number, number]; marker: FakeMarker }> = [];
  bounds = { west: -1, south: -1, east: 1, north: 1 };
  zoom = 10;

  onError(): void {}
  onMoveEnd(handler: () => void): void {
    this.moveEndHandler = handler;
  }
  remove(): void {}
  getBounds() {
    return this.bounds;
  }
  getZoom(): number {
    return this.zoom;
  }
  addSource(id: string, data: unknown): void {
    this.sources.set(id, data);
  }
  setSourceData(id: string, data: unknown): void {
    this.sources.set(id, data);
  }
  addMarker(element: HTMLElement, lngLat: [number, number]): MapLibreMarkerHandle {
    const marker = new FakeMarker();
    this.markers.push({ element, lngLat, marker });
    return marker;
  }

  fireMoveEnd(): void {
    this.moveEndHandler?.();
  }
}

function cluster(overrides: Partial<MapCluster> = {}): MapCluster {
  return {
    lat: 40,
    lng: -73,
    count: 1,
    representativeAssetId: 'asset-1',
    placeLabel: 'Paris',
    thumbKey: '/abs/photo.dng',
    ...overrides,
  };
}

describe('MapClusterPinsService', () => {
  let getClusters: ReturnType<typeof vi.fn>;
  let getThumbBlobUrl: ReturnType<typeof vi.fn>;
  let navigate: ReturnType<typeof vi.fn>;
  let service: MapClusterPinsService;
  let handle: FakeMapHandle;

  beforeEach(() => {
    vi.useFakeTimers();
    getClusters = vi.fn(() => of([]));
    getThumbBlobUrl = vi.fn(() => Promise.resolve('blob:thumb'));
    navigate = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        MapClusterPinsService,
        { provide: MapClustersService, useValue: { getClusters } },
        { provide: FilesystemBrowseService, useValue: { getThumbBlobUrl } },
        { provide: Router, useValue: { navigate } },
      ],
    });
    service = TestBed.inject(MapClusterPinsService);
    handle = new FakeMapHandle();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('adds the shared cluster source and fetches immediately on attach', () => {
    getClusters.mockReturnValue(of([cluster()]));

    service.attach(handle);

    expect(handle.sources.has(MAP_CLUSTER_SOURCE_ID)).toBe(true);
    expect(getClusters).toHaveBeenCalledTimes(1);
    expect(getClusters).toHaveBeenCalledWith(handle.bounds, handle.zoom);
  });

  it('debounces refetches across rapid moveend events', () => {
    service.attach(handle);
    getClusters.mockClear();

    handle.fireMoveEnd();
    vi.advanceTimersByTime(50);
    handle.fireMoveEnd();
    vi.advanceTimersByTime(50);
    handle.fireMoveEnd();

    expect(getClusters).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);

    expect(getClusters).toHaveBeenCalledTimes(1);
  });

  it('feeds returned cells into the GeoJSON source with count as a feature property', () => {
    getClusters.mockReturnValue(of([cluster({ count: 3, lat: 10, lng: 20 })]));

    service.attach(handle);

    const data = handle.sources.get(MAP_CLUSTER_SOURCE_ID) as {
      features: Array<{ properties: { count: number }; geometry: { coordinates: number[] } }>;
    };
    expect(data.features).toHaveLength(1);
    expect(data.features[0]!.properties.count).toBe(3);
    expect(data.features[0]!.geometry.coordinates).toEqual([20, 10]);
  });

  it('renders a thumbnail-pin marker for a single-count cell', () => {
    getClusters.mockReturnValue(of([cluster({ count: 1, thumbKey: '/abs/a.dng' })]));

    service.attach(handle);

    expect(handle.markers).toHaveLength(1);
    const el = handle.markers[0]!.element;
    expect(el.classList.contains('map-pin--thumb')).toBe(true);
    expect(el.querySelector('img')).not.toBeNull();
    expect(getThumbBlobUrl).toHaveBeenCalledWith('/abs/a.dng');
  });

  it('renders a count-bubble marker for a multi-count cell', () => {
    getClusters.mockReturnValue(of([cluster({ count: 5, representativeAssetId: 'a' })]));

    service.attach(handle);

    expect(handle.markers).toHaveLength(1);
    const el = handle.markers[0]!.element;
    expect(el.classList.contains('map-pin--count')).toBe(true);
    expect(el.textContent).toBe('5');
    expect(el.querySelector('img')).toBeNull();
  });

  it('navigates to /search/advanced with placeQuery on pin click', () => {
    getClusters.mockReturnValue(of([cluster({ placeLabel: 'Reykjavik' })]));
    service.attach(handle);

    handle.markers[0]!.element.click();

    expect(navigate).toHaveBeenCalledWith(['/search/advanced'], {
      queryParams: { placeQuery: 'Reykjavik' },
    });
  });

  it('falls back to scope=places on click when placeLabel is missing', () => {
    getClusters.mockReturnValue(of([cluster({ placeLabel: null })]));
    service.attach(handle);

    handle.markers[0]!.element.click();

    expect(navigate).toHaveBeenCalledWith(['/search/advanced'], {
      queryParams: { scope: 'places' },
    });
  });

  it('sets the empty signal when a fetch returns no cells', () => {
    getClusters.mockReturnValue(of([]));

    service.attach(handle);

    expect(service.empty()).toBe(true);
  });

  it('clears the empty signal once cells come back', () => {
    getClusters.mockReturnValue(of([]));
    service.attach(handle);
    expect(service.empty()).toBe(true);

    getClusters.mockReturnValue(of([cluster()]));
    handle.fireMoveEnd();
    vi.advanceTimersByTime(500);

    expect(service.empty()).toBe(false);
  });

  it('keeps the last good cells rendered on a fetch failure', () => {
    getClusters.mockReturnValue(of([cluster({ representativeAssetId: 'keep-me' })]));
    service.attach(handle);
    expect(handle.markers).toHaveLength(1);

    getClusters.mockReturnValue(throwError(() => new Error('network down')));
    handle.fireMoveEnd();
    vi.advanceTimersByTime(500);

    expect(handle.markers).toHaveLength(1);
    expect(handle.markers[0]!.marker.removed).toBe(false);
  });

  it('reuses markers for cells that persist across fetches instead of rebuilding them', () => {
    const persistent = cluster({ representativeAssetId: 'stays', count: 1 });
    getClusters.mockReturnValue(of([persistent]));
    service.attach(handle);
    expect(handle.markers).toHaveLength(1);
    const firstMarker = handle.markers[0]!.marker;

    getClusters.mockReturnValue(
      of([persistent, cluster({ representativeAssetId: 'new-one', lat: 5, lng: 5 })]),
    );
    handle.fireMoveEnd();
    vi.advanceTimersByTime(500);

    // Only ONE new marker was added for the new cell — the persistent
    // cell's original marker was not torn down and recreated.
    expect(handle.markers).toHaveLength(2);
    expect(firstMarker.removed).toBe(false);
  });

  it('removes markers for cells that drop out of a later fetch', () => {
    const dropped = cluster({ representativeAssetId: 'dropped' });
    getClusters.mockReturnValue(of([dropped]));
    service.attach(handle);
    const droppedMarker = handle.markers[0]!.marker;

    getClusters.mockReturnValue(of([]));
    handle.fireMoveEnd();
    vi.advanceTimersByTime(500);

    expect(droppedMarker.removed).toBe(true);
  });

  it('detach() removes every marker and stops further fetches', () => {
    getClusters.mockReturnValue(of([cluster()]));
    service.attach(handle);
    const marker = handle.markers[0]!.marker;

    service.detach();
    getClusters.mockClear();
    handle.fireMoveEnd();
    vi.advanceTimersByTime(500);

    expect(marker.removed).toBe(true);
    expect(getClusters).not.toHaveBeenCalled();
  });

  it('rounds the fractional zoom before requesting clusters', () => {
    handle.zoom = 7.8;
    getClusters.mockReturnValue(of([]));

    service.attach(handle);

    expect(getClusters).toHaveBeenCalledWith(handle.bounds, 8);
  });

  it('unsubscribes an in-flight fetch on detach so a late response is dropped', () => {
    const pending = new Subject<MapCluster[]>();
    getClusters.mockReturnValue(pending.asObservable());
    service.attach(handle);

    service.detach();
    pending.next([cluster()]);

    expect(handle.markers).toHaveLength(0);
  });
});
