// captured-at.spec.ts — proves `asIsoDate`/`capturedAtFromExif` match the
// server's real `src/api/src/indexer/exif.ts` (`asIsoDate` / the
// `captured_at` line of `normalizeExif`) for concrete (raw EXIF value) ->
// (expected ISO string) pairs, run through the actual `normalizeExif`
// function (via `bun run` against `src/api/src/indexer/exif.ts` — not
// hand-derived).
//
// Timezone note [P0, corrected in review]: an earlier version of this file
// had `asIsoDate`'s EXIF-format branch parsing via `new Date(iso)` on a
// timezone-LESS ISO string, which JS interprets as the process's LOCAL
// time — and this test file's own "expected" values were computed the
// SAME locally-ambiguous way, so the assertions held on any one machine
// but were not actually proving a fixed, portable, cross-platform-correct
// value. Since this feeds the cross-platform `maple_id` hash directly,
// that ambiguity meant the SAME EXIF timestamp hashed differently
// depending on the browser's timezone — a real bug, not a "genuine
// property of the shared algorithm" as this comment previously (wrongly)
// characterized it. `asIsoDate` now parses via `Date.UTC(...)`, which has
// no such ambiguity, so every case below asserts a fixed UTC-literal
// golden value — safe on any machine in any timezone, and actually
// meaningful (a machine in a non-UTC timezone would have caught the old
// bug immediately; the exact regression these fixed literals now guard
// against). `src/api/src/indexer/exif.timezone.test.ts` proves the same
// fix on the server side by spawning real child processes under different
// `TZ` values, which is the only reliable way to test this in Bun (a
// mid-process `process.env.TZ` mutation does not retroactively affect
// `Date` parsing there — see that file's module doc).

import { describe, it, expect } from 'vitest';
import { asIsoDate, capturedAtFromExif } from './captured-at';

describe('asIsoDate — timezone-independent inputs (parity with exif.ts)', () => {
  // [#2154] `Date` objects reaching `asIsoDate` are exifr's own local-
  // timezone-setter revival of a bare EXIF wall-clock string (see the
  // module doc above) — their LOCAL calendar fields are the value that
  // must survive, not their UTC ones. Building via the local-component
  // `Date` constructor is exactly how exifr's revival builds them, so this
  // asserts a fixed golden string regardless of which timezone the test
  // happens to run under: on the pre-fix code (`v.toISOString()`), this
  // would have produced a DIFFERENT string on any non-UTC host.
  it("a Date object's local wall-clock fields survive regardless of host timezone", () => {
    expect(asIsoDate(new Date(2026, 6, 12, 10, 30, 0))).toBe('2026-07-12T10:30:00.000Z');
  });

  it('zero-pads single-digit month/day/hour/minute/second fields', () => {
    expect(asIsoDate(new Date(2020, 0, 2, 3, 4, 5))).toBe('2020-01-02T03:04:05.000Z');
  });

  it('produces the identical golden string across widely different process timezones', () => {
    // Unlike `new Date(string)` parsing (which `exif.timezone.test.ts`
    // documents Bun does NOT re-read `TZ` for mid-process), local-component
    // construction (`new Date(y, mo, d, ...)`) plus local getters DOES pick
    // up a mid-process `process.env.TZ` change on both Node and Bun — verified
    // directly before writing this test. Pacific/Kiritimati (UTC+14) and
    // America/New_York (UTC-4/-5) are picked to be about as far apart as IANA
    // zones get, matching the spread `exif.timezone.test.ts` uses server-side.
    const original = process.env['TZ'];
    try {
      for (const tz of ['UTC', 'America/New_York', 'Pacific/Kiritimati']) {
        process.env['TZ'] = tz;
        expect(asIsoDate(new Date(2020, 0, 2, 3, 4, 5))).toBe('2020-01-02T03:04:05.000Z');
      }
    } finally {
      if (original === undefined) delete process.env['TZ'];
      else process.env['TZ'] = original;
    }
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
  // Fixed UTC-literal golden values — see the module doc's [P0] note for
  // why this is now safe (and load-bearing) rather than the earlier
  // locally-ambiguous `new Date(...).toISOString()` comparison.
  it('parses the space-separated EXIF format', () => {
    expect(asIsoDate('2026:07:12 10:30:00')).toBe('2026-07-12T10:30:00.000Z');
  });

  it('parses the T-separated EXIF format', () => {
    expect(asIsoDate('2026:07:12T10:30:00')).toBe('2026-07-12T10:30:00.000Z');
  });

  it('accepts trailing sub-second data after the matched prefix', () => {
    expect(asIsoDate('2026:07:12 10:30:00.500')).toBe('2026-07-12T10:30:00.000Z');
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
    const raw = { CreateDate: new Date(2019, 4, 5, 5, 5, 5) };
    expect(capturedAtFromExif(raw)).toBe('2019-05-05T05:05:05.000Z');
  });
});
