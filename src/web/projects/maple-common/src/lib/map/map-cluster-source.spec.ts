import { describe, expect, it } from 'vitest';
import type { MapCluster } from '../api/map-clusters.service';
import { cellsToFeatureCollection } from './map-cluster-source';

function cluster(overrides: Partial<MapCluster> = {}): MapCluster {
  return {
    lat: 10,
    lng: 20,
    count: 1,
    representativeAssetId: 'a',
    placeLabel: null,
    ...overrides,
  };
}

describe('cellsToFeatureCollection', () => {
  it('builds one Point feature per cell with count as the only property', () => {
    const collection = cellsToFeatureCollection([cluster({ count: 4, lat: -33.9, lng: 151.2 })]);

    expect(collection.type).toBe('FeatureCollection');
    expect(collection.features).toHaveLength(1);
    expect(collection.features[0]).toEqual({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [151.2, -33.9] },
      properties: { count: 4 },
    });
  });

  it('produces an empty FeatureCollection for no cells', () => {
    expect(cellsToFeatureCollection([])).toEqual({ type: 'FeatureCollection', features: [] });
  });
});
