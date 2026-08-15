// Shared GeoJSON source feeding the Map view's clustered pins (Map T4,
// #2828) and, later, #2829's heatmap `heatmap` layer — both draw from the
// SAME source so pins and heatmap can never disagree (design doc §
// "3. Web front-end"). The source id is exported here, not inlined as a
// string literal in each consumer, since #2829 adds a second consumer.

import type { MapCluster } from '../api/map-clusters.service';

export const MAP_CLUSTER_SOURCE_ID = 'maple-map-clusters';

export interface ClusterFeatureProperties {
  count: number;
}

export interface ClusterFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: ClusterFeatureProperties;
}

export interface ClusterFeatureCollection {
  type: 'FeatureCollection';
  features: ClusterFeature[];
}

/** Converts `/api/map/clusters`' `cells` into the shared source's data —
 * one feature per cell, `count` as the only property the source needs to
 * carry (the heatmap layer weights by it; the pins layer reads the rest of
 * a cell's fields straight off the originating `MapCluster`, not the
 * feature). */
export function cellsToFeatureCollection(cells: readonly MapCluster[]): ClusterFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: cells.map((cell) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [cell.lng, cell.lat] as [number, number] },
      properties: { count: cell.count },
    })),
  };
}
