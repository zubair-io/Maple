/**
 * Unit tests for the server-side XMP metadata serializer.
 *
 * Tests round-trip via `mergeMetadataIntoXmp` → `parseXmpMetadata`.
 */

import { describe, test, expect } from 'bun:test';
import { mergeMetadataIntoXmp } from './metadata-serializer.ts';
import { parseXmpMetadata } from './metadata-parser.ts';
import type { XmpMetadataInput } from './metadata-input.ts';

// ---------------------------------------------------------------------------
// Helper XMP stubs
// ---------------------------------------------------------------------------

const EMPTY_XMP = `<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
   xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   crs:Exposure2012="0.5">
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;

const WITH_EXISTING_META = `<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
   xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   xmlns:exif="http://ns.adobe.com/exif/1.0/"
   xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"
   crs:Exposure2012="0.5"
   exif:GPSLatitude="40,42.7680N" exif:GPSLongitude="74,0.3600W"
   photoshop:City="New York">
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;

// ---------------------------------------------------------------------------
// Round-trip tests
// ---------------------------------------------------------------------------

describe('mergeMetadataIntoXmp round-trip', () => {
  test('GPS coordinates survive round-trip', () => {
    const meta: XmpMetadataInput = {
      gpsLatitude: 48.8566,
      gpsLongitude: 2.3522,
    };
    const merged = mergeMetadataIntoXmp(EMPTY_XMP, meta);
    const parsed = parseXmpMetadata(merged);
    expect(parsed.gpsLatitude).toBeCloseTo(48.8566, 3);
    expect(parsed.gpsLongitude).toBeCloseTo(2.3522, 3);
  });

  test('GPS with altitude survives round-trip', () => {
    const meta: XmpMetadataInput = {
      gpsLatitude: 48.8566,
      gpsLongitude: 2.3522,
      gpsAltitude: 35.5,
    };
    const merged = mergeMetadataIntoXmp(EMPTY_XMP, meta);
    const parsed = parseXmpMetadata(merged);
    expect(parsed.gpsAltitude).toBeCloseTo(35.5, 1);
  });

  test('dateTimeOriginal and timeZone survive round-trip', () => {
    const meta: XmpMetadataInput = {
      dateTimeOriginal: '2026-06-26T18:40:00+02:00',
      timeZone: 'Europe/Paris',
    };
    const merged = mergeMetadataIntoXmp(EMPTY_XMP, meta);
    const parsed = parseXmpMetadata(merged);
    expect(parsed.dateTimeOriginal).toBe('2026-06-26T18:40:00+02:00');
    expect(parsed.timeZone).toBe('Europe/Paris');
  });

  test('IPTC text attributes survive round-trip', () => {
    const meta: XmpMetadataInput = {
      sublocation: 'Eiffel Tower',
      city: 'Paris',
      state: 'Île-de-France',
      country: 'France',
      countryCode: 'FR',
    };
    const merged = mergeMetadataIntoXmp(EMPTY_XMP, meta);
    const parsed = parseXmpMetadata(merged);
    expect(parsed.sublocation).toBe('Eiffel Tower');
    expect(parsed.city).toBe('Paris');
    expect(parsed.state).toBe('Île-de-France');
    expect(parsed.country).toBe('France');
    expect(parsed.countryCode).toBe('FR');
  });

  test('title lang-alt block survives round-trip', () => {
    const meta: XmpMetadataInput = { title: 'My Vacation' };
    const merged = mergeMetadataIntoXmp(EMPTY_XMP, meta);
    const parsed = parseXmpMetadata(merged);
    expect(parsed.title).toBe('My Vacation');
  });

  test('creator seq block survives round-trip', () => {
    const meta: XmpMetadataInput = { creator: 'Zubair Lawrence' };
    const merged = mergeMetadataIntoXmp(EMPTY_XMP, meta);
    const parsed = parseXmpMetadata(merged);
    expect(parsed.creator).toBe('Zubair Lawrence');
  });

  test('caption (dc:description) survives round-trip', () => {
    const meta: XmpMetadataInput = { caption: 'A lovely photo' };
    const merged = mergeMetadataIntoXmp(EMPTY_XMP, meta);
    const parsed = parseXmpMetadata(merged);
    expect(parsed.caption).toBe('A lovely photo');
  });

  test('copyrightNotice lang-alt survives round-trip', () => {
    const meta: XmpMetadataInput = { copyrightNotice: '© 2026 Z. Lawrence' };
    const merged = mergeMetadataIntoXmp(EMPTY_XMP, meta);
    const parsed = parseXmpMetadata(merged);
    expect(parsed.copyrightNotice).toBe('© 2026 Z. Lawrence');
  });

  test('copyrightStatus = copyrighted survives round-trip', () => {
    const meta: XmpMetadataInput = { copyrightStatus: 'copyrighted' };
    const merged = mergeMetadataIntoXmp(EMPTY_XMP, meta);
    const parsed = parseXmpMetadata(merged);
    expect(parsed.copyrightStatus).toBe('copyrighted');
  });

  test('keywords bag survives round-trip', () => {
    const meta: XmpMetadataInput = { keywords: ['travel', 'france', 'paris'] };
    const merged = mergeMetadataIntoXmp(EMPTY_XMP, meta);
    const parsed = parseXmpMetadata(merged);
    expect(parsed.keywords).toEqual(['travel', 'france', 'paris']);
  });

  test('XML entity characters in values survive round-trip', () => {
    const meta: XmpMetadataInput = {
      title: 'R&D <Notes>',
      city: '"Paris"',
    };
    const merged = mergeMetadataIntoXmp(EMPTY_XMP, meta);
    const parsed = parseXmpMetadata(merged);
    expect(parsed.title).toBe('R&D <Notes>');
    expect(parsed.city).toBe('"Paris"');
  });
});

// ---------------------------------------------------------------------------
// Merge / override behaviour
// ---------------------------------------------------------------------------

describe('mergeMetadataIntoXmp — merge behaviour', () => {
  test('existing adjustment fields are preserved', () => {
    const meta: XmpMetadataInput = { city: 'Paris' };
    const merged = mergeMetadataIntoXmp(EMPTY_XMP, meta);
    // crs:Exposure2012 should still be present
    expect(merged).toContain('crs:Exposure2012="0.5"');
  });

  test('existing GPS is replaced by new GPS', () => {
    const meta: XmpMetadataInput = {
      gpsLatitude: 48.8566,
      gpsLongitude: 2.3522,
    };
    const merged = mergeMetadataIntoXmp(WITH_EXISTING_META, meta);
    const parsed = parseXmpMetadata(merged);
    // New GPS should be Paris, not New York
    expect(parsed.gpsLatitude).toBeCloseTo(48.8566, 3);
    // Old GPS should not remain
    expect(merged).not.toContain('GPSLatitude="40,');
  });

  test('existing city is replaced by new city', () => {
    const meta: XmpMetadataInput = { city: 'Paris' };
    const merged = mergeMetadataIntoXmp(WITH_EXISTING_META, meta);
    expect(merged).not.toContain('City="New York"');
    expect(merged).toContain('City="Paris"');
  });

  test('stub created when xml is empty', () => {
    const meta: XmpMetadataInput = { city: 'Paris' };
    const merged = mergeMetadataIntoXmp('', meta);
    const parsed = parseXmpMetadata(merged);
    expect(parsed.city).toBe('Paris');
  });
});

// ---------------------------------------------------------------------------
// Namespace injection
// ---------------------------------------------------------------------------

describe('mergeMetadataIntoXmp — namespace declarations', () => {
  test('adds exif namespace when GPS added to sidecar without it', () => {
    const noExifXmp = `<?xml version="1.0"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="0">
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;
    const merged = mergeMetadataIntoXmp(noExifXmp, {
      gpsLatitude: 48.8566,
      gpsLongitude: 2.3522,
    });
    expect(merged).toContain('xmlns:exif=');
  });

  test('does not duplicate existing namespace declarations', () => {
    const meta: XmpMetadataInput = {
      gpsLatitude: 48.8566,
      gpsLongitude: 2.3522,
    };
    const merged = mergeMetadataIntoXmp(WITH_EXISTING_META, meta);
    // Count occurrences of xmlns:exif
    const count = (merged.match(/xmlns:exif=/g) ?? []).length;
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Partial-edit preservation (regression for #1600 data-loss bug)
// ---------------------------------------------------------------------------

describe('mergeMetadataIntoXmp — partial edits preserve untouched fields', () => {
  test('editing only city preserves existing GPS', () => {
    // WITH_EXISTING_META has GPS + photoshop:City="New York".
    const merged = mergeMetadataIntoXmp(WITH_EXISTING_META, { city: 'Rome' });
    const parsed = parseXmpMetadata(merged);
    expect(parsed.city).toBe('Rome'); // updated
    expect(parsed.gpsLatitude).toBeCloseTo(40.7128, 3); // untouched, preserved
    expect(parsed.gpsLongitude).toBeCloseTo(-74.006, 3);
  });

  test('editing only GPS preserves existing city', () => {
    const merged = mergeMetadataIntoXmp(WITH_EXISTING_META, {
      gpsLatitude: 48.8566,
      gpsLongitude: 2.3522,
    });
    const parsed = parseXmpMetadata(merged);
    expect(parsed.gpsLatitude).toBeCloseTo(48.8566, 3); // updated
    expect(parsed.city).toBe('New York'); // untouched, preserved
  });

  test('editing one nested field preserves an existing nested field', () => {
    // Seed a sidecar with both a title and a creator, then edit only the title.
    const seeded = mergeMetadataIntoXmp(EMPTY_XMP, {
      title: 'Old Title',
      creator: 'Ansel Adams',
    });
    const merged = mergeMetadataIntoXmp(seeded, { title: 'New Title' });
    const parsed = parseXmpMetadata(merged);
    expect(parsed.title).toBe('New Title'); // updated
    expect(parsed.creator).toBe('Ansel Adams'); // untouched, preserved
  });

  test('explicit null clears only that field, leaving others intact', () => {
    const merged = mergeMetadataIntoXmp(WITH_EXISTING_META, { city: null });
    const parsed = parseXmpMetadata(merged);
    expect(parsed.city).toBeUndefined(); // cleared
    expect(parsed.gpsLatitude).toBeCloseTo(40.7128, 3); // preserved
  });
});

// ---------------------------------------------------------------------------
// metadataOnly option — video sidecar (M5, #1635)
// ---------------------------------------------------------------------------

describe('mergeMetadataIntoXmp with metadataOnly: true', () => {
  test('creates a sidecar with no Camera Raw Settings attributes for a new video sidecar', () => {
    const meta: XmpMetadataInput = {
      gpsLatitude: 37.7749,
      gpsLongitude: -122.4194,
    };
    const merged = mergeMetadataIntoXmp('', meta, { metadataOnly: true });
    // No CRS namespace declaration.
    expect(merged).not.toContain('camera-raw-settings');
    expect(merged).not.toContain('crs:Version');
    expect(merged).not.toContain('crs:HasSettings');
    // Metadata fields are present.
    expect(merged).toContain('exif:GPSLatitude');
    expect(merged).toContain('exif:GPSLongitude');
  });

  test('metadata-only sidecar round-trips through parseXmpMetadata', () => {
    const meta: XmpMetadataInput = {
      gpsLatitude: 51.5074,
      gpsLongitude: -0.1278,
      city: 'London',
      country: 'United Kingdom',
      creator: 'Jane Doe',
      copyrightNotice: '© 2026 Jane Doe',
    };
    const merged = mergeMetadataIntoXmp('', meta, { metadataOnly: true });
    const parsed = parseXmpMetadata(merged);
    expect(parsed.gpsLatitude).toBeCloseTo(51.5074, 3);
    expect(parsed.gpsLongitude).toBeCloseTo(-0.1278, 3);
    expect(parsed.city).toBe('London');
    expect(parsed.country).toBe('United Kingdom');
    expect(parsed.creator).toBe('Jane Doe');
    expect(parsed.copyrightNotice).toBe('© 2026 Jane Doe');
  });

  test('metadataOnly: true is ignored when existingXml is non-empty (existing sidecar preserved)', () => {
    // Even for video, if a sidecar already exists we preserve it rather than
    // swapping in a new stub.
    const existingVideoSidecar = mergeMetadataIntoXmp(
      '',
      { city: 'Tokyo' },
      { metadataOnly: true },
    );
    const merged = mergeMetadataIntoXmp(
      existingVideoSidecar,
      { city: 'Osaka' },
      { metadataOnly: true },
    );
    const parsed = parseXmpMetadata(merged);
    expect(parsed.city).toBe('Osaka');
    // Still no CRS in the output (the existing sidecar already lacked it).
    expect(merged).not.toContain('crs:HasSettings');
  });

  test('metadataOnly: false (default) uses the adjustment-carrying STUB_XMP for new sidecars', () => {
    const merged = mergeMetadataIntoXmp('', { city: 'Paris' });
    // Default path: STUB_XMP includes CRS HasSettings.
    expect(merged).toContain('crs:HasSettings');
  });
});

// ---------------------------------------------------------------------------
// Culling round-trip
// ---------------------------------------------------------------------------

describe('culling round-trip', () => {
  test('rating survives round-trip', () => {
    const meta: XmpMetadataInput = { rating: 4 };
    const merged = mergeMetadataIntoXmp(EMPTY_XMP, meta);
    const parsed = parseXmpMetadata(merged);
    expect(parsed.rating).toBe(4);
  });

  test('rating 0 is treated as clear (removes existing rating)', () => {
    const withRating = mergeMetadataIntoXmp(EMPTY_XMP, {
      rating: 5,
    } as XmpMetadataInput);
    const cleared = mergeMetadataIntoXmp(withRating, {
      rating: 0,
    } as XmpMetadataInput);
    const parsed = parseXmpMetadata(cleared);
    expect(parsed.rating).toBeUndefined();
  });

  test('out-of-range rating is ignored, never written as an unreadable attr', () => {
    // Defense-in-depth: the batch route 422s out-of-range ratings, but a
    // non-route caller could pass one. The serializer must never write a value
    // the 1–5 parser can't read back. (A touched out-of-range rating, like any
    // touched culling field, first strips the prior attr in the merge; the clamp
    // then declines to re-add the bad value, so the result carries no rating.)
    const merged = mergeMetadataIntoXmp(EMPTY_XMP, { rating: 7 } as XmpMetadataInput);
    expect(merged).not.toContain('xmp:Rating="7"');
    expect(parseXmpMetadata(merged).rating).toBeUndefined();
    // A larger out-of-range value is also ignored.
    const big = mergeMetadataIntoXmp(EMPTY_XMP, { rating: 12 } as XmpMetadataInput);
    expect(parseXmpMetadata(big).rating).toBeUndefined();
  });

  test('flag=pick survives round-trip', () => {
    const meta: XmpMetadataInput = { flag: 'pick' };
    const merged = mergeMetadataIntoXmp(EMPTY_XMP, meta);
    const parsed = parseXmpMetadata(merged);
    expect(parsed.flag).toBe('pick');
  });

  test('flag=unflagged clears existing flag', () => {
    const withFlag = mergeMetadataIntoXmp(EMPTY_XMP, {
      flag: 'pick',
    } as XmpMetadataInput);
    const cleared = mergeMetadataIntoXmp(withFlag, {
      flag: 'unflagged',
    } as XmpMetadataInput);
    const parsed = parseXmpMetadata(cleared);
    expect(parsed.flag).toBeUndefined();
  });

  test('colorLabel=red survives round-trip', () => {
    const meta: XmpMetadataInput = { colorLabel: 'red' };
    const merged = mergeMetadataIntoXmp(EMPTY_XMP, meta);
    const parsed = parseXmpMetadata(merged);
    expect(parsed.colorLabel).toBe('red');
  });

  // #1657 — the vocabulary used to be inconsistent: the batch/XMP path
  // recognised red|orange|yellow|green|blue (no purple) while search
  // recognised red|yellow|green|blue|purple (no orange). `orange` and
  // `purple` are the two values that were previously mishandled by one
  // side or the other, so they get explicit round-trip coverage here
  // through the real parser (`parseXmpMetadata`) and serializer
  // (`mergeMetadataIntoXmp`) — no mocks.
  test('colorLabel=orange survives round-trip (#1657)', () => {
    const meta: XmpMetadataInput = { colorLabel: 'orange' };
    const merged = mergeMetadataIntoXmp(EMPTY_XMP, meta);
    expect(merged).toContain('papp:ColorLabel="orange"');
    const parsed = parseXmpMetadata(merged);
    expect(parsed.colorLabel).toBe('orange');
  });

  test('colorLabel=purple survives round-trip (#1657)', () => {
    const meta: XmpMetadataInput = { colorLabel: 'purple' };
    const merged = mergeMetadataIntoXmp(EMPTY_XMP, meta);
    expect(merged).toContain('papp:ColorLabel="purple"');
    const parsed = parseXmpMetadata(merged);
    expect(parsed.colorLabel).toBe('purple');
  });

  test('colorLabel=null clears existing color label', () => {
    const withLabel = mergeMetadataIntoXmp(EMPTY_XMP, {
      colorLabel: 'green',
    } as XmpMetadataInput);
    const cleared = mergeMetadataIntoXmp(withLabel, {
      colorLabel: null,
    } as XmpMetadataInput);
    const parsed = parseXmpMetadata(cleared);
    expect(parsed.colorLabel).toBeUndefined();
  });

  test('culling fields do not disturb existing IPTC metadata', () => {
    const withCity = mergeMetadataIntoXmp(EMPTY_XMP, {
      city: 'Paris',
    } as XmpMetadataInput);
    const withCulling = mergeMetadataIntoXmp(withCity, {
      rating: 3,
    } as XmpMetadataInput);
    const parsed = parseXmpMetadata(withCulling);
    expect(parsed.city).toBe('Paris');
    expect(parsed.rating).toBe(3);
  });

  test('existing papp:Flag in sidecar is preserved when flag not in input', () => {
    const withFlag = mergeMetadataIntoXmp(EMPTY_XMP, {
      flag: 'reject',
    } as XmpMetadataInput);
    // Apply city change without touching flag
    const withCity = mergeMetadataIntoXmp(withFlag, {
      city: 'Berlin',
    } as XmpMetadataInput);
    const parsed = parseXmpMetadata(withCity);
    expect(parsed.flag).toBe('reject');
    expect(parsed.city).toBe('Berlin');
  });
});
