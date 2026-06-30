// batch-metadata.service.spec.ts — unit tests for the pure computeMixedValues
// function exported from batch-metadata.types (#1616).
//
// These run under bare vitest (no Angular DI) because computeMixedValues is a
// standalone pure function — no TestBed needed.
//
// HTTP wiring (batchApply, geocodeSearch, refileCount, refile) is covered by
// batch-metadata.service.http.spec.ts using Angular TestBed + HttpTestingController.

import { describe, it, expect } from 'vitest';
import { computeMixedValues, MIXED } from './batch-metadata.types';
import type { AssetMetadataSnapshot } from './batch-metadata.types';

describe('computeMixedValues', () => {
  it('returns empty map for empty snapshots', () => {
    const result = computeMixedValues([]);
    expect(result.gpsLatitude).toBeUndefined();
    expect(result.city).toBeUndefined();
  });

  it('returns single value when all snapshots agree on a string field', () => {
    const snapshots: AssetMetadataSnapshot[] = [
      { address: 'photos:a.dng', metadata: { city: 'Paris' } },
      { address: 'photos:b.dng', metadata: { city: 'Paris' } },
    ];
    const result = computeMixedValues(snapshots);
    expect(result.city).toBe('Paris');
  });

  it('returns MIXED when string field values differ', () => {
    const snapshots: AssetMetadataSnapshot[] = [
      { address: 'photos:a.dng', metadata: { city: 'Paris' } },
      { address: 'photos:b.dng', metadata: { city: 'Berlin' } },
    ];
    const result = computeMixedValues(snapshots);
    expect(result.city).toBe(MIXED);
  });

  it('returns undefined (not MIXED) when all snapshots lack the field', () => {
    const snapshots: AssetMetadataSnapshot[] = [
      { address: 'photos:a.dng', metadata: {} },
      { address: 'photos:b.dng', metadata: {} },
    ];
    const result = computeMixedValues(snapshots);
    expect(result.city).toBeUndefined();
  });

  it('returns MIXED when one snapshot has a value and another is undefined', () => {
    const snapshots: AssetMetadataSnapshot[] = [
      { address: 'photos:a.dng', metadata: { city: 'Paris' } },
      { address: 'photos:b.dng', metadata: {} },
    ];
    const result = computeMixedValues(snapshots);
    expect(result.city).toBe(MIXED);
  });

  it('returns single value for keywords when all snapshots match (array equality)', () => {
    const snapshots: AssetMetadataSnapshot[] = [
      { address: 'photos:a.dng', metadata: { keywords: ['travel', 'france'] } },
      { address: 'photos:b.dng', metadata: { keywords: ['travel', 'france'] } },
    ];
    const result = computeMixedValues(snapshots);
    expect(result.keywords).toEqual(['travel', 'france']);
  });

  it('returns MIXED for keywords when they differ', () => {
    const snapshots: AssetMetadataSnapshot[] = [
      { address: 'photos:a.dng', metadata: { keywords: ['travel'] } },
      { address: 'photos:b.dng', metadata: { keywords: ['landscape'] } },
    ];
    const result = computeMixedValues(snapshots);
    expect(result.keywords).toBe(MIXED);
  });

  it('handles a single snapshot by returning its values directly', () => {
    const snapshots: AssetMetadataSnapshot[] = [
      {
        address: 'photos:a.dng',
        metadata: {
          gpsLatitude: 48.8566,
          gpsLongitude: 2.3522,
          city: 'Paris',
          copyrightStatus: 'copyrighted',
        },
      },
    ];
    const result = computeMixedValues(snapshots);
    expect(result.gpsLatitude).toBe(48.8566);
    expect(result.gpsLongitude).toBe(2.3522);
    expect(result.city).toBe('Paris');
    expect(result.copyrightStatus).toBe('copyrighted');
  });

  it('returns MIXED only for differing fields; uniform fields stay their value', () => {
    const snapshots: AssetMetadataSnapshot[] = [
      { address: 'photos:a.dng', metadata: { city: 'Paris', country: 'France' } },
      { address: 'photos:b.dng', metadata: { city: 'Berlin', country: 'France' } },
    ];
    const result = computeMixedValues(snapshots);
    expect(result.city).toBe(MIXED);
    expect(result.country).toBe('France');
  });

  it('handles null metadata values correctly (null is a valid "set" state)', () => {
    const snapshots: AssetMetadataSnapshot[] = [
      { address: 'photos:a.dng', metadata: { gpsLatitude: null } },
      { address: 'photos:b.dng', metadata: { gpsLatitude: null } },
    ];
    const result = computeMixedValues(snapshots);
    expect(result.gpsLatitude).toBeNull();
  });

  it('returns MIXED when one snapshot has null and another has a value', () => {
    const snapshots: AssetMetadataSnapshot[] = [
      { address: 'photos:a.dng', metadata: { gpsLatitude: null } },
      { address: 'photos:b.dng', metadata: { gpsLatitude: 48.8566 } },
    ];
    const result = computeMixedValues(snapshots);
    expect(result.gpsLatitude).toBe(MIXED);
  });

  it('handles tri-state copyrightStatus correctly', () => {
    const snapshots: AssetMetadataSnapshot[] = [
      { address: 'photos:a.dng', metadata: { copyrightStatus: 'copyrighted' } },
      { address: 'photos:b.dng', metadata: { copyrightStatus: 'public-domain' } },
    ];
    const result = computeMixedValues(snapshots);
    expect(result.copyrightStatus).toBe(MIXED);
  });
});
