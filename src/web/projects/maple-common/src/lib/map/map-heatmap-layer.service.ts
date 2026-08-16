// MapHeatmapLayerService — the density-overlay layer for the Map view (Map
// T5, #2829). Reads the SAME shared cluster GeoJSON source
// `MapClusterPinsService` feeds (`map-cluster-source.ts`), so heatmap and
// pins can never disagree about what's on the map — see that file's module
// doc. Provided by `MapViewComponent` itself (component-scoped, same as
// `MapClusterPinsService`), so its layer lives and dies with exactly one
// map mount.
//
// Unlike the pins layer this owns no fetch/subscription/marker state — the
// shared source already gets its data from `MapClusterPinsService`'s fetch
// loop, and the heatmap layer itself repaints automatically off that same
// source whenever it changes — so there's nothing to `detach()` on
// teardown; `MapLibreService.destroy()` tearing down the whole map instance
// removes this layer along with it.

import { Injectable } from '@angular/core';
import { MAP_CLUSTER_SOURCE_ID } from './map-cluster-source';
import type { MapLibreMapHandle } from './maplibre-instance-factory';

@Injectable()
export class MapHeatmapLayerService {
  /** Adds the heatmap layer to a freshly-mounted map instance, bound to the
   * shared cluster source. */
  attach(handle: MapLibreMapHandle): void {
    handle.addHeatmapLayer(MAP_CLUSTER_SOURCE_ID);
  }
}
