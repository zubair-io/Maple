/**
 * Unit tests for the effective-metadata resolver.
 */

import { describe, test, expect } from 'bun:test';
import { effectiveMetadata, parseYearMonth } from './override-resolver.ts';
import type { AssetDoc, MetadataOverride } from '../db/schema.ts';

// ---------------------------------------------------------------------------
// parseYearMonth
// ---------------------------------------------------------------------------

describe('parseYearMonth', () => {
  test('extracts UTC year and month from ISO with offset', () => {
    // 2026-06-26T22:00:00+02:00 → UTC 2026-06-26T20:00:00Z → year=2026, month=6
    const { year, month } = parseYearMonth('2026-06-26T22:00:00+02:00');
    expect(year).toBe(2026);
    expect(month).toBe(6);
  });

  test('extracts UTC year/month from Z timestamp crossing midnight', () => {
    // 2026-01-01T00:30:00+02:00 → UTC 2025-12-31T22:30:00Z → year=2025, month=12
    const { year, month } = parseYearMonth('2026-01-01T00:30:00+02:00');
    expect(year).toBe(2025);
    expect(month).toBe(12);
  });

  test('returns nulls for null input', () => {
    expect(parseYearMonth(null)).toEqual({ year: null, month: null });
  });

  test('returns nulls for undefined input', () => {
    expect(parseYearMonth(undefined)).toEqual({ year: null, month: null });
  });

  test('returns nulls for unparseable string', () => {
    expect(parseYearMonth('not-a-date')).toEqual({ year: null, month: null });
  });
});

// ---------------------------------------------------------------------------
// effectiveMetadata — no override
// ---------------------------------------------------------------------------

describe('effectiveMetadata — no override', () => {
  const doc: Pick<AssetDoc, 'exif' | 'metadata_override'> = {
    exif: {
      captured_at: '2025-07-04T12:00:00Z',
      captured_year: 2025,
      captured_month: 7,
      camera_make: 'Hasselblad',
      camera_model: 'L3D-100c',
      lens: null,
      iso: 100,
      aperture: 2.8,
      shutter: '1/250',
      focal_length: 24,
      gps: { lat: 40.7128, lng: -74.006 },
    },
    metadata_override: undefined,
  };

  test('falls back to exif.captured_at', () => {
    expect(effectiveMetadata(doc).captured_at).toBe('2025-07-04T12:00:00Z');
  });

  test('derives year/month from exif.captured_at', () => {
    const r = effectiveMetadata(doc);
    expect(r.captured_year).toBe(2025);
    expect(r.captured_month).toBe(7);
  });

  test('falls back to exif.gps', () => {
    const r = effectiveMetadata(doc);
    expect(r.gps).toEqual({ lat: 40.7128, lng: -74.006 });
  });

  test('time_zone is null when no override', () => {
    expect(effectiveMetadata(doc).time_zone).toBeNull();
  });

  test('place_text is null when no override', () => {
    expect(effectiveMetadata(doc).place_text).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// effectiveMetadata — full override
// ---------------------------------------------------------------------------

describe('effectiveMetadata — with override', () => {
  const override: MetadataOverride = {
    edited_at: '2026-06-26T16:40:00Z',
    touched_fields: ['gps', 'captured_at', 'time_zone', 'place_text'],
    gps: { lat: 48.8566, lng: 2.3522, alt: 35 },
    captured_at: '2026-06-26T18:40:00+02:00',
    time_zone: 'Europe/Paris',
    place_text: { city: 'Paris', country: 'France', country_code: 'FR' },
  };

  const doc: Pick<AssetDoc, 'exif' | 'metadata_override'> = {
    exif: {
      captured_at: '2025-07-04T12:00:00Z',
      captured_year: 2025,
      captured_month: 7,
      camera_make: 'Sony',
      camera_model: 'A7IV',
      lens: null,
      iso: null,
      aperture: null,
      shutter: null,
      focal_length: null,
      gps: { lat: 40.7128, lng: -74.006 },
    },
    metadata_override: override,
  };

  test('override.captured_at wins over exif', () => {
    expect(effectiveMetadata(doc).captured_at).toBe('2026-06-26T18:40:00+02:00');
  });

  test('year/month re-derived from override.captured_at', () => {
    // 2026-06-26T18:40:00+02:00 → UTC 2026-06-26T16:40:00Z → year=2026, month=6
    const r = effectiveMetadata(doc);
    expect(r.captured_year).toBe(2026);
    expect(r.captured_month).toBe(6);
  });

  test('override.gps wins over exif.gps', () => {
    const r = effectiveMetadata(doc);
    // Returns {lat, lng} only (altitude is not in EffectiveMetadata.gps)
    expect(r.gps).toEqual({ lat: 48.8566, lng: 2.3522 });
  });

  test('time_zone comes from override', () => {
    expect(effectiveMetadata(doc).time_zone).toBe('Europe/Paris');
  });

  test('place_text comes from override', () => {
    expect(effectiveMetadata(doc).place_text).toEqual({
      city: 'Paris',
      country: 'France',
      country_code: 'FR',
    });
  });
});

// ---------------------------------------------------------------------------
// effectiveMetadata — explicit clears (null in override)
// ---------------------------------------------------------------------------

describe('effectiveMetadata — nullish override falls back to exif (spec: override ?? exif)', () => {
  test('override.gps = null falls back to exif.gps', () => {
    const doc: Pick<AssetDoc, 'exif' | 'metadata_override'> = {
      exif: {
        captured_at: null,
        captured_year: null,
        captured_month: null,
        camera_make: null,
        camera_model: null,
        lens: null,
        iso: null,
        aperture: null,
        shutter: null,
        focal_length: null,
        gps: { lat: 40.7128, lng: -74.006 },
      },
      metadata_override: {
        edited_at: '2026-06-26T16:40:00Z',
        touched_fields: ['gps'],
        gps: null,
      },
    };
    // Spec formula override ?? exif: a nullish override reverts to the original.
    expect(effectiveMetadata(doc).gps).toEqual({ lat: 40.7128, lng: -74.006 });
  });

  test('override.captured_at = null falls back to exif.captured_at', () => {
    const doc: Pick<AssetDoc, 'exif' | 'metadata_override'> = {
      exif: {
        captured_at: '2025-07-04T12:00:00Z',
        captured_year: 2025,
        captured_month: 7,
        camera_make: null,
        camera_model: null,
        lens: null,
        iso: null,
        aperture: null,
        shutter: null,
        focal_length: null,
        gps: null,
      },
      metadata_override: {
        edited_at: '2026-06-26T16:40:00Z',
        touched_fields: ['captured_at'],
        captured_at: null,
      },
    };
    const r = effectiveMetadata(doc);
    expect(r.captured_at).toBe('2025-07-04T12:00:00Z');
    expect(r.captured_year).toBe(2025);
    expect(r.captured_month).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// effectiveMetadata — no exif, no override
// ---------------------------------------------------------------------------

describe('effectiveMetadata — no data at all', () => {
  test('returns all nulls', () => {
    const doc: Pick<AssetDoc, 'exif' | 'metadata_override'> = {
      exif: null,
      metadata_override: null,
    };
    const r = effectiveMetadata(doc);
    expect(r.captured_at).toBeNull();
    expect(r.captured_year).toBeNull();
    expect(r.captured_month).toBeNull();
    expect(r.gps).toBeNull();
    expect(r.time_zone).toBeNull();
    expect(r.place_text).toBeNull();
  });
});
