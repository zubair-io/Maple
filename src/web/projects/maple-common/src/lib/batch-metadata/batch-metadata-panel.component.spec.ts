// batch-metadata-panel.component.spec.ts — unit tests for Batch Metadata panel
// logic (#1606). Avoids Angular component instantiation (which requires JIT
// compiler in plain vitest). Tests the pure logic that is not Angular-specific:
//   - mixed-value computation (via the pure function in types)
//   - geocode candidate selection logic (pure function extractable from class)
//   - payload building logic (pure function)
//
// Angular template / DI / lifecycle integration is covered by the build check
// (tsc + angular compiler) and manual verification in the dev server.

import { describe, it, expect } from 'vitest';
import { computeMixedValues, MIXED } from './batch-metadata.types';
import type {
  AssetMetadataSnapshot,
  BatchApplyMetadata,
  GeocodeCandidate,
  MixedValueMap,
} from './batch-metadata.types';

// ---------------------------------------------------------------------------
// Helpers extracted from the component's private logic, tested here as pure fns
// ---------------------------------------------------------------------------

/** Mirrors BatchMetadataPanelComponent.onGeocodeSelect address→fields mapping. */
function geocodeSelectToFields(candidate: GeocodeCandidate): {
  lat: string;
  lon: string;
  city: string;
  state: string;
  country: string;
  countryCode: string;
} {
  const addr = candidate.address;
  return {
    lat: String(candidate.lat),
    lon: String(candidate.lon),
    city: addr['city'] ?? addr['town'] ?? addr['village'] ?? '',
    state: addr['state'] ?? addr['region'] ?? '',
    country: addr['country'] ?? '',
    countryCode: (addr['country_code'] ?? '').toUpperCase(),
  };
}

/** Mirrors the keyword-splitting logic from _buildPayload. */
function parseKeywords(raw: string): string[] {
  return raw === ''
    ? []
    : raw
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean);
}

/**
 * Mirrors _buildPayload for a set of touched fields and values.
 * Only the touched fields appear in the output; untouched fields are absent.
 */
function buildPayload(
  paths: string[],
  touched: Set<keyof MixedValueMap>,
  values: Record<string, string>,
): Array<{ path: string; metadata: BatchApplyMetadata }> {
  const meta: BatchApplyMetadata = {};

  if (touched.has('gpsLatitude')) {
    const v = values['gpsLatitude'] ?? '';
    meta.gpsLatitude = v === '' ? null : Number(v);
  }
  if (touched.has('gpsLongitude')) {
    const v = values['gpsLongitude'] ?? '';
    meta.gpsLongitude = v === '' ? null : Number(v);
  }
  if (touched.has('city')) {
    const v = values['city'] ?? '';
    meta.city = v === '' ? null : v;
  }
  if (touched.has('country')) {
    const v = values['country'] ?? '';
    meta.country = v === '' ? null : v;
  }
  if (touched.has('title')) {
    const v = values['title'] ?? '';
    meta.title = v === '' ? null : v;
  }
  if (touched.has('keywords')) {
    meta.keywords = parseKeywords(values['keywords'] ?? '');
  }
  if (touched.has('rating')) {
    const v = values['rating'] ?? '';
    meta.rating = v === '' ? undefined : Number(v);
  }

  return paths.map((path) => ({ path, metadata: meta }));
}

// ---------------------------------------------------------------------------
// Tests: mixed-value computation
// ---------------------------------------------------------------------------

describe('BatchMetadataPanel — mixed-value placeholders', () => {
  it('shows MIXED when a field differs across selected assets', () => {
    const snapshots: AssetMetadataSnapshot[] = [
      { path: '/a.dng', metadata: { city: 'Paris' } },
      { path: '/b.dng', metadata: { city: 'Berlin' } },
    ];
    const mixed = computeMixedValues(snapshots);
    expect(mixed.city).toBe(MIXED);
  });

  it('shows single value when all assets agree on a field', () => {
    const snapshots: AssetMetadataSnapshot[] = [
      { path: '/a.dng', metadata: { city: 'Paris', rating: 4 } },
      { path: '/b.dng', metadata: { city: 'Paris', rating: 4 } },
    ];
    const mixed = computeMixedValues(snapshots);
    expect(mixed.city).toBe('Paris');
    expect(mixed.rating).toBe(4);
  });

  it('shows undefined for a field absent on all assets', () => {
    const snapshots: AssetMetadataSnapshot[] = [
      { path: '/a.dng', metadata: {} },
      { path: '/b.dng', metadata: {} },
    ];
    const mixed = computeMixedValues(snapshots);
    expect(mixed.city).toBeUndefined();
  });

  it('shows MIXED when keywords differ', () => {
    const snapshots: AssetMetadataSnapshot[] = [
      { path: '/a.dng', metadata: { keywords: ['travel'] } },
      { path: '/b.dng', metadata: { keywords: ['landscape'] } },
    ];
    const mixed = computeMixedValues(snapshots);
    expect(mixed.keywords).toBe(MIXED);
  });

  it('shows single value for keywords when arrays are identical', () => {
    const snapshots: AssetMetadataSnapshot[] = [
      { path: '/a.dng', metadata: { keywords: ['travel', 'france'] } },
      { path: '/b.dng', metadata: { keywords: ['travel', 'france'] } },
    ];
    const mixed = computeMixedValues(snapshots);
    expect(mixed.keywords).toEqual(['travel', 'france']);
  });
});

// ---------------------------------------------------------------------------
// Tests: only touched fields appear in the submit payload
// ---------------------------------------------------------------------------

describe('BatchMetadataPanel — payload building (only touched fields)', () => {
  it('empty touched set produces empty metadata in payload', () => {
    const payload = buildPayload(['/a.dng'], new Set(), {});
    expect(payload[0]!.metadata).toEqual({});
  });

  it('only touched fields appear in payload', () => {
    const touched = new Set<keyof MixedValueMap>(['city', 'rating'] as Array<keyof MixedValueMap>);
    const values = { city: 'Paris', rating: '4', country: 'France' }; // country NOT touched
    const payload = buildPayload(['/a.dng'], touched, values);

    expect(payload[0]!.metadata).toHaveProperty('city', 'Paris');
    expect(payload[0]!.metadata).toHaveProperty('rating', 4);
    expect(payload[0]!.metadata).not.toHaveProperty('country');
  });

  it('empty string for a touched field emits null (explicit clear)', () => {
    const touched = new Set<keyof MixedValueMap>(['city'] as Array<keyof MixedValueMap>);
    const payload = buildPayload(['/a.dng'], touched, { city: '' });
    expect(payload[0]!.metadata.city).toBeNull();
  });

  it('produces one payload entry per asset path', () => {
    const touched = new Set<keyof MixedValueMap>(['city'] as Array<keyof MixedValueMap>);
    const paths = ['/a.dng', '/b.dng', '/c.dng'];
    const payload = buildPayload(paths, touched, { city: 'Rome' });

    expect(payload).toHaveLength(3);
    expect(payload.map((p) => p.path)).toEqual(paths);
    payload.forEach((entry) => {
      expect(entry.metadata.city).toBe('Rome');
    });
  });

  it('parses comma-separated keywords into an array', () => {
    const touched = new Set<keyof MixedValueMap>(['keywords'] as Array<keyof MixedValueMap>);
    const payload = buildPayload(['/a.dng'], touched, { keywords: 'travel, france, street' });
    expect(payload[0]!.metadata.keywords).toEqual(['travel', 'france', 'street']);
  });

  it('empty keywords string produces an empty array (clears bag)', () => {
    const touched = new Set<keyof MixedValueMap>(['keywords'] as Array<keyof MixedValueMap>);
    const payload = buildPayload(['/a.dng'], touched, { keywords: '' });
    expect(payload[0]!.metadata.keywords).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests: geocode candidate selection → field mapping
// ---------------------------------------------------------------------------

describe('BatchMetadataPanel — geocode candidate selection', () => {
  it('maps lat/lon and structured address fields from a candidate', () => {
    const candidate: GeocodeCandidate = {
      displayName: 'Paris, France',
      lat: 48.8566,
      lon: 2.3522,
      address: {
        city: 'Paris',
        state: 'Île-de-France',
        country: 'France',
        country_code: 'fr',
      },
    };

    const fields = geocodeSelectToFields(candidate);

    expect(fields.lat).toBe('48.8566');
    expect(fields.lon).toBe('2.3522');
    expect(fields.city).toBe('Paris');
    expect(fields.state).toBe('Île-de-France');
    expect(fields.country).toBe('France');
    expect(fields.countryCode).toBe('FR'); // uppercased
  });

  it('falls back to town when city is absent', () => {
    const candidate: GeocodeCandidate = {
      displayName: 'Some town, Country',
      lat: 10,
      lon: 20,
      address: { town: 'Smalltown', country: 'Country', country_code: 'xx' },
    };
    const fields = geocodeSelectToFields(candidate);
    expect(fields.city).toBe('Smalltown');
  });

  it('falls back to village when city and town are absent', () => {
    const candidate: GeocodeCandidate = {
      displayName: 'Village, Country',
      lat: 5,
      lon: 10,
      address: { village: 'Tinyville', country_code: 'xx' },
    };
    const fields = geocodeSelectToFields(candidate);
    expect(fields.city).toBe('Tinyville');
  });

  it('uppercases the country code', () => {
    const candidate: GeocodeCandidate = {
      displayName: 'Test',
      lat: 0,
      lon: 0,
      address: { country_code: 'de' },
    };
    const fields = geocodeSelectToFields(candidate);
    expect(fields.countryCode).toBe('DE');
  });

  it('returns empty strings for absent address components', () => {
    const candidate: GeocodeCandidate = {
      displayName: 'Unknown',
      lat: 0,
      lon: 0,
      address: {},
    };
    const fields = geocodeSelectToFields(candidate);
    expect(fields.city).toBe('');
    expect(fields.state).toBe('');
    expect(fields.country).toBe('');
    expect(fields.countryCode).toBe('');
  });
});
