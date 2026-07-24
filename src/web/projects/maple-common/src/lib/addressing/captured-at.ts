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
 *
 * [#2154]: the `Date` branch below had the same underlying bug one layer
 * up. A `Date` reaching this branch is never a genuinely-correct UTC
 * instant — every producer in this codebase (exifr's own `reviveValues`
 * revival, and any future caller building one the obvious way via
 * `new Date(y, m - 1, d, h, mi, s)`) constructs it the same locally-biased
 * way exifr's bundled `ze` function does: a bare multi-argument `Date`
 * constructor call, which the ECMAScript spec resolves against the
 * process's LOCAL timezone. `v.toISOString()` reports the UTC instant that
 * biased epoch value corresponds to — on a non-UTC host that is NOT the
 * original wall-clock reading, shifted by the host's UTC offset. Reading
 * the same LOCAL calendar fields back out (`getFullYear`/`getMonth`/etc.,
 * the exact inverse of the local setters that built the value) undoes
 * that bias unconditionally: whatever offset the host applied going in is
 * the same offset applied coming back out, so the two cancel regardless
 * of what the offset actually is. This makes the wall clock the only
 * value this branch can ever recover — it is not a general-purpose
 * Date-to-ISO formatter for arbitrary already-correct UTC instants, only
 * for this domain's timezone-naive EXIF timestamps.
 */
export function asIsoDate(v: unknown): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const pad = (n: number): string => String(n).padStart(2, '0');
    const year = String(v.getFullYear()).padStart(4, '0');
    return `${year}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}T${pad(v.getHours())}:${pad(v.getMinutes())}:${pad(v.getSeconds())}.000Z`;
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
