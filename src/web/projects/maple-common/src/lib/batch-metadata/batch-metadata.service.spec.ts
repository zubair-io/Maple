// batch-metadata.service.spec.ts — unit tests for BatchMetadataService (#1606).
// Tests the pure computeMixedValues function directly from batch-metadata.types
// (no Angular imports → no JIT compilation errors in plain vitest).
// HTTP layer (batchApply, geocodeSearch) is covered by the type contracts;
// the actual HTTP wiring is validated in the build (TypeScript + Angular compiler).

import { describe, it, expect } from 'vitest';
import { computeMixedValues, MIXED } from './batch-metadata.types';
import type { AssetMetadataSnapshot } from './batch-metadata.types';

describe('computeMixedValues', () => {
  it('returns empty map for empty snapshots', () => {
    const result = computeMixedValues([]);
    expect(result.gpsLatitude).toBeUndefined();
    expect(result.city).toBeUndefined();
    expect(result.rating).toBeUndefined();
    expect(result.flag).toBeUndefined();
  });

  it('returns single value when all snapshots agree on a string field', () => {
    const snapshots: AssetMetadataSnapshot[] = [
      { path: '/a.dng', metadata: { city: 'Paris', rating: 3 } },
      { path: '/b.dng', metadata: { city: 'Paris', rating: 3 } },
    ];
    const result = computeMixedValues(snapshots);
    expect(result.city).toBe('Paris');
    expect(result.rating).toBe(3);
  });

  it('returns MIXED when string field values differ', () => {
    const snapshots: AssetMetadataSnapshot[] = [
      { path: '/a.dng', metadata: { city: 'Paris' } },
      { path: '/b.dng', metadata: { city: 'Berlin' } },
    ];
    const result = computeMixedValues(snapshots);
    expect(result.city).toBe(MIXED);
  });

  it('returns undefined (not MIXED) when all snapshots lack the field', () => {
    const snapshots: AssetMetadataSnapshot[] = [
      { path: '/a.dng', metadata: {} },
      { path: '/b.dng', metadata: {} },
    ];
    const result = computeMixedValues(snapshots);
    expect(result.city).toBeUndefined();
  });

  it('returns MIXED when one snapshot has a value and another is undefined', () => {
    const snapshots: AssetMetadataSnapshot[] = [
      { path: '/a.dng', metadata: { city: 'Paris' } },
      { path: '/b.dng', metadata: {} },
    ];
    const result = computeMixedValues(snapshots);
    expect(result.city).toBe(MIXED);
  });

  it('returns single value for keywords when all snapshots match (array equality)', () => {
    const snapshots: AssetMetadataSnapshot[] = [
      { path: '/a.dng', metadata: { keywords: ['travel', 'france'] } },
      { path: '/b.dng', metadata: { keywords: ['travel', 'france'] } },
    ];
    const result = computeMixedValues(snapshots);
    expect(result.keywords).toEqual(['travel', 'france']);
  });

  it('returns MIXED for keywords when they differ', () => {
    const snapshots: AssetMetadataSnapshot[] = [
      { path: '/a.dng', metadata: { keywords: ['travel'] } },
      { path: '/b.dng', metadata: { keywords: ['landscape'] } },
    ];
    const result = computeMixedValues(snapshots);
    expect(result.keywords).toBe(MIXED);
  });

  it('handles a single snapshot by returning its values directly', () => {
    const snapshots: AssetMetadataSnapshot[] = [
      {
        path: '/a.dng',
        metadata: {
          gpsLatitude: 48.8566,
          gpsLongitude: 2.3522,
          city: 'Paris',
          copyrightStatus: 'copyrighted',
          flag: 'pick',
          colorLabel: 'red',
          rating: 4,
        },
      },
    ];
    const result = computeMixedValues(snapshots);
    expect(result.gpsLatitude).toBe(48.8566);
    expect(result.gpsLongitude).toBe(2.3522);
    expect(result.city).toBe('Paris');
    expect(result.copyrightStatus).toBe('copyrighted');
    expect(result.flag).toBe('pick');
    expect(result.colorLabel).toBe('red');
    expect(result.rating).toBe(4);
  });

  it('returns MIXED only for differing fields; uniform fields stay their value', () => {
    const snapshots: AssetMetadataSnapshot[] = [
      { path: '/a.dng', metadata: { city: 'Paris', country: 'France' } },
      { path: '/b.dng', metadata: { city: 'Berlin', country: 'France' } },
    ];
    const result = computeMixedValues(snapshots);
    expect(result.city).toBe(MIXED);
    expect(result.country).toBe('France');
  });

  it('handles null metadata values correctly (null is a valid "set" state)', () => {
    const snapshots: AssetMetadataSnapshot[] = [
      { path: '/a.dng', metadata: { gpsLatitude: null } },
      { path: '/b.dng', metadata: { gpsLatitude: null } },
    ];
    const result = computeMixedValues(snapshots);
    expect(result.gpsLatitude).toBeNull();
  });

  it('returns MIXED when one snapshot has null and another has a value', () => {
    const snapshots: AssetMetadataSnapshot[] = [
      { path: '/a.dng', metadata: { gpsLatitude: null } },
      { path: '/b.dng', metadata: { gpsLatitude: 48.8566 } },
    ];
    const result = computeMixedValues(snapshots);
    expect(result.gpsLatitude).toBe(MIXED);
  });

  it('handles tri-state copyrightStatus correctly', () => {
    const snapshots: AssetMetadataSnapshot[] = [
      { path: '/a.dng', metadata: { copyrightStatus: 'copyrighted' } },
      { path: '/b.dng', metadata: { copyrightStatus: 'public-domain' } },
    ];
    const result = computeMixedValues(snapshots);
    expect(result.copyrightStatus).toBe(MIXED);
  });

  it('handles flag values correctly', () => {
    const snapshots: AssetMetadataSnapshot[] = [
      { path: '/a.dng', metadata: { flag: 'pick' } },
      { path: '/b.dng', metadata: { flag: 'pick' } },
    ];
    const result = computeMixedValues(snapshots);
    expect(result.flag).toBe('pick');
  });
});
