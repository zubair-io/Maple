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
  type StyleSpecification,
} from 'maplibre-gl';
import type { MapBoundingBox } from '../api/map-clusters.service';
import type { ClusterFeatureCollection } from './map-cluster-source';
import { buildHeatmapLayer } from './map-heatmap-layer';

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
  /** Resolves once the style is loaded and `addSource` / `addLayer` are safe
   * (MapLibre throws from both until then). If the style fails to load —
   * e.g. its JSON URL is unreachable — switches to `fallbackStyle` and
   * resolves once that has loaded, so callers always get a usable map. */
  whenStyleReady(fallbackStyle: StyleSpecification): Promise<void>;
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
  /** Adds the density-overlay `heatmap` layer (Map T5, #2829) reading from
   * `sourceId` — the shared cluster source. Call once per mounted instance,
   * after `addSource`. Added as a plain canvas style layer with no
   * `beforeId`: pins are HTML `Marker`s, which MapLibre always renders in
   * their own DOM layer above the WebGL canvas regardless of style-layer
   * order, so this already paints beneath them without needing one. */
  addHeatmapLayer(sourceId: string): void;
}

@Injectable({ providedIn: 'root' })
export class MapLibreInstanceFactory {
  create(options: MapOptions): MapLibreMapHandle {
    const map = new MapLibreMap(options);
    const styleLoaded = map.once('style.load').then(() => 'loaded' as const);
    // `getStyle()` is undefined until the style document has been parsed, so an
    // error while it is still undefined means the style itself failed to load,
    // not a tile, sprite or glyph request.
    const styleFailed = new Promise<'failed'>((resolve) => {
      const onError = (): void => {
        if (map.getStyle()) return;
        map.off('error', onError);
        resolve('failed');
      };
      map.on('error', onError);
      void styleLoaded.then(() => map.off('error', onError));
    });
    return {
      onError: (handler) => map.on('error', handler),
      whenStyleReady: async (fallbackStyle) => {
        if ((await Promise.race([styleLoaded, styleFailed])) === 'loaded') return;
        map.setStyle(fallbackStyle);
        await map.once('style.load');
      },
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
      addHeatmapLayer: (sourceId) => {
        map.addLayer(buildHeatmapLayer(sourceId));
      },
    };
  }
}
