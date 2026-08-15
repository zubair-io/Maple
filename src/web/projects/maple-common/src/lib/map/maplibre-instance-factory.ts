// MapLibreInstanceFactory — the only file in maple-common that imports the
// `maplibre-gl` SDK's runtime code (Map T3, #2827).
//
// Exists purely so `MapLibreService` — the actual owner of map
// lifecycle/config-resolution logic, and the file with real unit test
// coverage — can depend on this via Angular DI and get swapped for a fake
// in tests, instead of leaning on `vi.mock('maplibre-gl', ...)`. That
// module-mocking shape depends on Vitest correctly intercepting a
// third-party package's own module resolution, which has already
// reproduced a real, intermittent CI failure for a different SDK in this
// codebase — see `exif-reader.service.ts`'s module doc for the incident.
// Routing the SDK call itself through DI sidesteps that whole class of
// flake: nothing for a test to race against, and jsdom (which has no real
// WebGL context) never has to construct a real `maplibregl.Map`.
import { Injectable } from '@angular/core';
import {
  Map as MapLibreMap,
  Marker as MapLibreMarker,
  type GeoJSONSource,
  type MapOptions,
  type SourceSpecification,
} from 'maplibre-gl';
import type { MapBoundingBox } from '../api/map-clusters.service';
import type { ClusterFeatureCollection } from './map-cluster-source';

/** A single DOM marker mounted on the map (Map T4, #2828) — the handle for
 * a thumbnail pin or count bubble. Narrow on purpose: callers only ever
 * need to take a marker back off the map once its cell drops out of the
 * viewport. */
export interface MapLibreMarkerHandle {
  remove(): void;
}

/** The subset of `maplibregl.Map`'s API `MapLibreService` and the cluster-
 * pins layer (Map T4, #2828) actually use — kept narrow so a test fake only
 * has to implement these members, never the real SDK. */
export interface MapLibreMapHandle {
  onError(handler: (event: { error?: { message: string } }) => void): void;
  /** Fires once MapLibre's pan/zoom inertia settles — the trigger for a
   * debounced `/api/map/clusters` re-fetch. */
  onMoveEnd(handler: () => void): void;
  remove(): void;
  /** Current viewport as a plain bbox — the same shape `/api/map/clusters`
   * expects, so callers never touch a MapLibre `LngLatBounds`. */
  getBounds(): MapBoundingBox;
  getZoom(): number;
  /** Adds the shared cluster GeoJSON source. Call once per mounted
   * instance, before the first `setSourceData`. */
  addSource(id: string, data: ClusterFeatureCollection): void;
  /** Replaces a GeoJSON source's data in place. A no-op if `id` hasn't been
   * `addSource`'d yet. */
  setSourceData(id: string, data: ClusterFeatureCollection): void;
  /** Mounts an HTML marker at `lngLat` and returns a handle to remove it
   * later. `element` is owned by the caller — MapLibre only reads its
   * bounding box for positioning. */
  addMarker(element: HTMLElement, lngLat: [number, number]): MapLibreMarkerHandle;
}

@Injectable({ providedIn: 'root' })
export class MapLibreInstanceFactory {
  create(options: MapOptions): MapLibreMapHandle {
    const map = new MapLibreMap(options);
    return {
      onError: (handler) => map.on('error', handler),
      onMoveEnd: (handler) => map.on('moveend', handler),
      remove: () => map.remove(),
      getBounds: () => {
        const bounds = map.getBounds();
        return {
          west: bounds.getWest(),
          south: bounds.getSouth(),
          east: bounds.getEast(),
          north: bounds.getNorth(),
        };
      },
      getZoom: () => map.getZoom(),
      addSource: (id, data) => {
        map.addSource(id, { type: 'geojson', data } as SourceSpecification);
      },
      setSourceData: (id, data) => {
        const source = map.getSource(id) as GeoJSONSource | undefined;
        source?.setData(data);
      },
      addMarker: (element, lngLat) => {
        const marker = new MapLibreMarker({ element }).setLngLat(lngLat).addTo(map);
        return { remove: () => marker.remove() };
      },
    };
  }
}
