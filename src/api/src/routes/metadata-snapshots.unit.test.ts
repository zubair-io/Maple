/**
 * Unit tests for `overrideToXmpSnapshot` — the pure mapping function that turns
 * an asset doc's metadata_override / exif / top-level culling fields into an
 * XmpSnapshot. No Mongo and no filesystem are needed, so these run standalone.
 *
 * Route-level integration tests (validation + real-DB field mapping) live in the
 * sibling metadata-snapshots.test.ts. This file was split out to keep both under
 * the per-file line budget.
 */

import { describe, test, expect } from 'bun:test';
import { overrideToXmpSnapshot } from './metadata-snapshots.ts';

// ---------------------------------------------------------------------------
// overrideToXmpSnapshot — unit tests (pure, no I/O)
// ---------------------------------------------------------------------------

describe('overrideToXmpSnapshot', () => {
  test('returns empty object when no override and no exif', () => {
    expect(overrideToXmpSnapshot({})).toEqual({});
  });

  test('returns empty object when override and exif are null', () => {
    expect(overrideToXmpSnapshot({ exif: null, metadata_override: null })).toEqual({});
  });

  test('maps full override GPS + place + text fields', () => {
    const snap = overrideToXmpSnapshot({
      exif: null,
      metadata_override: {
        edited_at: '2026-06-28T00:00:00Z',
        touched_fields: [],
        gps: { lat: 48.8566, lng: 2.3522, alt: 35 },
        captured_at: '2026-01-01T12:00:00+01:00',
        time_zone: 'Europe/Paris',
        place_text: {
          sublocation: 'Eiffel Tower',
          city: 'Paris',
          state: 'Île-de-France',
          country: 'France',
          country_code: 'fr',
        },
        keywords: ['travel', 'france'],
        title: 'Eiffel at dusk',
        caption: 'Tower at dusk',
        headline: 'Paris 2026',
        instructions: 'For editorial use only',
        creator: 'Jane Doe',
        creator_job_title: 'Photographer',
        copyright_notice: '© 2026 Jane Doe',
        copyright_status: 'copyrighted',
        usage_terms: 'Editorial only',
        credit: 'Jane Doe / Agency',
        source: 'Maple',
      },
    });

    expect(snap.gpsLatitude).toBeCloseTo(48.8566, 4);
    expect(snap.gpsLongitude).toBeCloseTo(2.3522, 4);
    expect(snap.gpsAltitude).toBe(35);
    expect(snap.dateTimeOriginal).toBe('2026-01-01T12:00:00+01:00');
    expect(snap.timeZone).toBe('Europe/Paris');
    expect(snap.sublocation).toBe('Eiffel Tower');
    expect(snap.city).toBe('Paris');
    expect(snap.state).toBe('Île-de-France');
    expect(snap.country).toBe('France');
    expect(snap.countryCode).toBe('fr');
    expect(snap.keywords).toEqual(['travel', 'france']);
    expect(snap.title).toBe('Eiffel at dusk');
    expect(snap.caption).toBe('Tower at dusk');
    expect(snap.headline).toBe('Paris 2026');
    expect(snap.instructions).toBe('For editorial use only');
    expect(snap.creator).toBe('Jane Doe');
    expect(snap.creatorJobTitle).toBe('Photographer');
    expect(snap.copyrightNotice).toBe('© 2026 Jane Doe');
    expect(snap.copyrightStatus).toBe('copyrighted');
    expect(snap.usageTerms).toBe('Editorial only');
    expect(snap.credit).toBe('Jane Doe / Agency');
    expect(snap.source).toBe('Maple');
  });

  test('falls back to exif.gps when override.gps is absent', () => {
    const snap = overrideToXmpSnapshot({
      exif: {
        gps: { lat: 51.5074, lng: -0.1278 },
        captured_at: '2025-06-01T10:00:00Z',
      } as never,
      metadata_override: {
        edited_at: '2026-01-01T00:00:00Z',
        touched_fields: [],
      },
    });
    expect(snap.gpsLatitude).toBeCloseTo(51.5074, 4);
    expect(snap.gpsLongitude).toBeCloseTo(-0.1278, 4);
    expect('gpsAltitude' in snap).toBe(false);
  });

  test('falls back to exif.captured_at when override.captured_at is absent', () => {
    const snap = overrideToXmpSnapshot({
      exif: { captured_at: '2025-05-01T08:00:00Z', gps: null } as never,
      metadata_override: {
        edited_at: '2026-01-01T00:00:00Z',
        touched_fields: [],
      },
    });
    expect(snap.dateTimeOriginal).toBe('2025-05-01T08:00:00Z');
  });

  test('override.captured_at takes precedence over exif.captured_at', () => {
    const snap = overrideToXmpSnapshot({
      exif: { captured_at: '2020-01-01T00:00:00Z', gps: null } as never,
      metadata_override: {
        edited_at: '2026-06-28T00:00:00Z',
        touched_fields: ['captured_at'],
        captured_at: '2025-06-15T14:30:00+02:00',
      },
    });
    expect(snap.dateTimeOriginal).toBe('2025-06-15T14:30:00+02:00');
  });

  test('override.gps takes precedence over exif.gps', () => {
    const snap = overrideToXmpSnapshot({
      exif: { gps: { lat: 0, lng: 0 }, captured_at: null } as never,
      metadata_override: {
        edited_at: '2026-06-28T00:00:00Z',
        touched_fields: ['gps'],
        gps: { lat: 40.7128, lng: -74.006 },
      },
    });
    expect(snap.gpsLatitude).toBeCloseTo(40.7128, 4);
    expect(snap.gpsLongitude).toBeCloseTo(-74.006, 4);
  });

  test('includes empty keywords array when override.keywords is []', () => {
    const snap = overrideToXmpSnapshot({
      metadata_override: {
        edited_at: '2026-06-28T00:00:00Z',
        touched_fields: ['keywords'],
        keywords: [],
      },
    });
    expect(snap.keywords).toEqual([]);
  });

  test('skips keywords key when override.keywords is null', () => {
    const snap = overrideToXmpSnapshot({
      metadata_override: {
        edited_at: '2026-06-28T00:00:00Z',
        touched_fields: [],
        keywords: null,
      },
    });
    expect('keywords' in snap).toBe(false);
  });

  test('overrideToXmpSnapshot returns rating from top-level doc', () => {
    const doc = {
      rating: 3,
      flag: 0 as -1 | 0 | 1,
      color_label: '',
      exif: undefined,
      metadata_override: undefined,
    };
    const snap = overrideToXmpSnapshot(doc);
    expect(snap.rating).toBe(3);
  });

  test('overrideToXmpSnapshot returns flag=pick when doc.flag===1', () => {
    const doc = {
      rating: 0,
      flag: 1 as -1 | 0 | 1,
      color_label: '',
      exif: undefined,
      metadata_override: undefined,
    };
    const snap = overrideToXmpSnapshot(doc);
    expect(snap.flag).toBe('pick');
  });

  test('overrideToXmpSnapshot omits flag when unflagged (flag===0)', () => {
    const doc = {
      rating: 0,
      flag: 0 as -1 | 0 | 1,
      color_label: '',
      exif: undefined,
      metadata_override: undefined,
    };
    const snap = overrideToXmpSnapshot(doc);
    expect(snap.flag).toBeUndefined();
  });

  test('overrideToXmpSnapshot returns colorLabel from color_label field', () => {
    const doc = {
      rating: 0,
      flag: 0 as -1 | 0 | 1,
      color_label: 'red',
      exif: undefined,
      metadata_override: undefined,
    };
    const snap = overrideToXmpSnapshot(doc);
    expect(snap.colorLabel).toBe('red');
  });

  test('skips null place_text subfields', () => {
    const snap = overrideToXmpSnapshot({
      metadata_override: {
        edited_at: '2026-06-28T00:00:00Z',
        touched_fields: [],
        place_text: { city: null, country: 'Spain' },
      },
    });
    expect('city' in snap).toBe(false);
    expect(snap.country).toBe('Spain');
  });
});
