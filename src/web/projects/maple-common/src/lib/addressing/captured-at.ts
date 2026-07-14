// Capture-timestamp derivation for the Hosted-mode `maple_id` primary form
// (#1995).
//
// DELIBERATE DUPLICATE, ported verbatim: `asIsoDate` below is byte-for-byte
// the same function as `asIsoDate` in `src/api/src/indexer/exif.ts`, and
// `capturedAtFromExif` mirrors ONLY the `captured_at` derivation line of that
// file's `normalizeExif` (`asIsoDate(raw['DateTimeOriginal']) ??
// asIsoDate(raw['CreateDate'])`) — not the rest of `normalizeExif` (camera
// make/model, lens, ISO, aperture, GPS, …), which has nothing to do with
// `maple_id` and would be dead code here. Kept in sync with `exif.ts` by
// convention, same category as `maple-id.ts`'s port of `id.ts` — see that
// file's module doc for why `src/api` can't be imported directly from
// `src/web` (separate packages/runtimes; `exif.ts` additionally pulls in
// Node-only `node:fs/promises` and the `exifr` Node-path parse overload).
// `captured-at.spec.ts` proves parity against `exif.ts`'s real `asIsoDate`
// for concrete (raw EXIF value) -> (expected ISO string) pairs.

/**
 * EXIF DateTimeOriginal can be a Date (exifr's default) or a string.
 *
 * [P0, caught in review]: EXIF's DateTimeOriginal/CreateDate tags carry NO
 * timezone offset per spec — a bare "YYYY:MM:DD HH:MM:SS". An earlier
 * version of this function built that into a string like
 * "2026-07-12T10:30:00" and passed it to `new Date(...)`; per the ECMAScript
 * spec, a date-TIME string with no trailing `Z`/offset is parsed in the
 * JS engine's LOCAL timezone, not UTC. Since this feeds the cross-platform
 * `maple_id` hash directly (via `capturedAtFromExif` -> `primary()`), that
 * ambiguity meant the SAME photo's EXIF timestamp hashed to a DIFFERENT
 * `maple_id` depending on which timezone the browser happened to be
 * running in — completely defeating the point of a cross-platform cache
 * key. `Date.UTC(...)`'s numeric-component constructor has no string-
 * parsing ambiguity at all: it is always UTC, matching the Apple port's
 * same explicit choice (`ExifCaptureDate.swift`) and the server's
 * `src/api/src/indexer/exif.ts`, fixed in lockstep with this file.
 */
export function asIsoDate(v: unknown): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return v.toISOString();
  }
  if (typeof v === 'string') {
    // Try EXIF format "YYYY:MM:DD HH:MM:SS" first, then ISO.
    const exifMatch = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(v);
    if (exifMatch) {
      const [, y, mo, d, h, mi, s] = exifMatch;
      const t = new Date(
        Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)),
      );
      if (!Number.isNaN(t.getTime())) return t.toISOString();
    }
    const t = new Date(v);
    if (!Number.isNaN(t.getTime())) return t.toISOString();
  }
  return null;
}

/**
 * Pick a capture timestamp from a loose exifr parse result, preferring
 * `DateTimeOriginal` then falling back to `CreateDate` — the same precedence
 * `normalizeExif`'s `captured_at` field uses. Returns `null` when neither tag
 * is present or parseable, which is the `maple_id` primary/fallback branch
 * signal (`deriveId` in `maple-id.ts`): no capture timestamp means the
 * fallback (full-file-hash) form applies.
 */
export function capturedAtFromExif(raw: Record<string, unknown>): string | null {
  return asIsoDate(raw['DateTimeOriginal']) ?? asIsoDate(raw['CreateDate']);
}
