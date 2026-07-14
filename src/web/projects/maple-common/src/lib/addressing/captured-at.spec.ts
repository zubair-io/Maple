// captured-at.spec.ts — proves `asIsoDate`/`capturedAtFromExif` match the
// server's real `src/api/src/indexer/exif.ts` (`asIsoDate` / the
// `captured_at` line of `normalizeExif`) for concrete (raw EXIF value) ->
// (expected ISO string) pairs, run through the actual `normalizeExif`
// function (via `bun run` against `src/api/src/indexer/exif.ts` — not
// hand-derived).
//
// Timezone note: `asIsoDate`'s EXIF-format branch (`"YYYY:MM:DD HH:MM:SS"`)
// parses via `new Date(iso)` on a timezone-LESS ISO string, which JS
// interprets as LOCAL time — this is a genuine property of the shared
// algorithm (present in the server's real function too), not something this
// port introduces. Hardcoding that branch's expected output as a fixed UTC
// string would make this spec flaky across machines in different timezones.
// The cases below split into two groups: (1) inputs that are timezone-
// independent (a `Date` object, or a string with an explicit UTC offset) —
// asserted against a fixed literal; (2) the EXIF-colon-format branch —
// asserted against `new Date(...).toISOString()` computed the SAME way in
// the test, so the assertion holds under any local timezone while still
// exercising the real regex-rewrite-then-parse code path.

import { describe, it, expect } from 'vitest';
import { asIsoDate, capturedAtFromExif } from './captured-at';

describe('asIsoDate — timezone-independent inputs (parity with exif.ts)', () => {
  it('a Date object round-trips via toISOString', () => {
    expect(asIsoDate(new Date('2026-07-12T10:30:00.000Z'))).toBe('2026-07-12T10:30:00.000Z');
  });

  it('an invalid Date object returns null', () => {
    expect(asIsoDate(new Date('not-a-date'))).toBeNull();
  });

  it('a full ISO-8601 string with an explicit UTC offset passes through', () => {
    expect(asIsoDate('2026-07-12T10:30:00.000Z')).toBe('2026-07-12T10:30:00.000Z');
  });

  it('an unparseable string returns null', () => {
    expect(asIsoDate('not-a-date')).toBeNull();
  });

  it('a non-string, non-Date value returns null', () => {
    expect(asIsoDate(42)).toBeNull();
    expect(asIsoDate(undefined)).toBeNull();
    expect(asIsoDate(null)).toBeNull();
  });
});

describe('asIsoDate — EXIF colon-format branch ("YYYY:MM:DD HH:MM:SS")', () => {
  // Expected values computed via the SAME local-time Date parse the real
  // function performs (`new Date('YYYY-MM-DDTHH:MM:SS').toISOString()`) —
  // portable across timezones while still proving the regex rewrite
  // (":" -> "-" in the date portion, space/`T` separator accepted) lands on
  // the exact same parseable ISO string the server's function builds.
  it('parses the space-separated EXIF format', () => {
    const expected = new Date('2026-07-12T10:30:00').toISOString();
    expect(asIsoDate('2026:07:12 10:30:00')).toBe(expected);
  });

  it('parses the T-separated EXIF format', () => {
    const expected = new Date('2026-07-12T10:30:00').toISOString();
    expect(asIsoDate('2026:07:12T10:30:00')).toBe(expected);
  });

  it('accepts trailing sub-second data after the matched prefix', () => {
    const expected = new Date('2026-07-12T10:30:00').toISOString();
    expect(asIsoDate('2026:07:12 10:30:00.500')).toBe(expected);
  });
});

describe('capturedAtFromExif — precedence (parity with normalizeExif)', () => {
  it('prefers DateTimeOriginal over CreateDate when both are present', () => {
    const raw = {
      DateTimeOriginal: '2026-07-12T10:30:00.000Z',
      CreateDate: '2020-01-01T00:00:00.000Z',
    };
    expect(capturedAtFromExif(raw)).toBe('2026-07-12T10:30:00.000Z');
  });

  it('falls back to CreateDate when DateTimeOriginal is absent', () => {
    const raw = { CreateDate: '2025-01-02T08:04:05.000Z' };
    expect(capturedAtFromExif(raw)).toBe('2025-01-02T08:04:05.000Z');
  });

  it('falls back to CreateDate when DateTimeOriginal is unparseable', () => {
    const raw = { DateTimeOriginal: 'garbage', CreateDate: '2025-01-02T08:04:05.000Z' };
    expect(capturedAtFromExif(raw)).toBe('2025-01-02T08:04:05.000Z');
  });

  it('returns null when neither tag is present', () => {
    expect(capturedAtFromExif({})).toBeNull();
  });

  it('accepts a Date object for CreateDate', () => {
    const raw = { CreateDate: new Date('2019-05-05T05:05:05.000Z') };
    expect(capturedAtFromExif(raw)).toBe('2019-05-05T05:05:05.000Z');
  });
});
