/**
 * EXIF extraction from image/RAW files.
 *
 * Uses the `exifr` npm package to parse JPEG, TIFF, DNG, and most RAW
 * container formats (CR2, CR3, NEF, ARW, RAF, ORF, RW2, etc). Some
 * proprietary RAW formats have weak/absent metadata — those leave the
 * `exif` field null and downstream stages keep advancing.
 *
 * The XMP sidecar is consulted in dedicated stages — this module focuses
 * on parsing only.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AssetExif } from '../db/schema.ts';
import exifr from 'exifr';
import { readHeicExifTiff } from './heic-exif.ts';
import { readWebpExifTiff } from './webp-exif.ts';
import { VIDEO_EXTS, STUB_IMAGE_EXTS, AUDIO_EXTS } from './media-types.ts';
import { readVideoMetadata } from './video-metadata.ts';

/** HEIC/HEIF containers — exifr's `canHandle` rejects modern (>50-byte ftyp)
 * variants, so these go through our own box walker in `heic-exif.ts`, which
 * slices the embedded TIFF and feeds it back to exifr. */
const HEIC_EXTS = new Set(['.heic', '.heif']);

/** WebP containers — exifr 7.1.3 has no WebP parser, so it rejects `.webp`
 * with "Unknown file format" before reaching any tag extraction. WebP can
 * carry a full EXIF block in a RIFF `EXIF` chunk, so these go through our own
 * RIFF walker in `webp-exif.ts`, which slices the embedded TIFF and feeds it
 * back to exifr (same strategy as HEIC). */
const WEBP_EXTS = new Set(['.webp']);

/** Extensions with no extractable EXIF that we nonetheless ingest (via the
 * backup route, which has no extension filter, or a library that holds mixed
 * media). exifr can't parse them, so a parse attempt would throw "Unknown
 * file format" and dead-letter the asset as if it were damaged. Instead we
 * return null without attempting a parse — terminal and warning-free, the
 * expected "this kind of file simply has no camera metadata" outcome.
 *
 * Three buckets:
 *   - Video containers — never carried EXIF the exif stage reads.
 *   - Raster formats exifr has no parser for and that in practice carry no
 *     usable EXIF: animated/static GIF (incl. the `*-ANIMATION.gif` Motion
 *     Photo exports) and BMP. (WebP is handled above; PNG is parsed by exifr
 *     directly and is deliberately NOT here.)
 *   - Stub-image and audio formats (#1835) — eip/braw/afphoto/ai have no
 *     rawler/sharp decode path, and mp3/wav/m4a/aac are a wholly new asset
 *     category with no EXIF concept at all. exifr has no parser for any of
 *     these; attempting a parse would throw "Unknown file format".
 */
const NO_EXIF_EXTS = new Set([
  // Video containers — never carried EXIF the exif stage reads. Sourced from
  // the shared VIDEO_EXTS set so the describe / preview / exif stages can't
  // disagree on what counts as a video.
  ...VIDEO_EXTS,
  // Raster formats with no usable EXIF and no exifr parser
  '.gif',
  '.bmp',
  // Metadata-only stub images + audio (#1835) — sourced from media-types.ts
  // so the exif stage can't drift from the thumb/preview/describe guards.
  ...STUB_IMAGE_EXTS,
  ...AUDIO_EXTS,
]);

/**
 * exifr's parse result is a loose record. We pluck the fields we want and
 * narrow them ourselves rather than slurping the whole tag dump (some files
 * pull in maker-notes blobs that are tens of KB).
 *
 * GPSLatitudeRef / GPSLongitudeRef MUST stay in this list. exifr converts
 * GPSLatitude/GPSLongitude into the signed `latitude`/`longitude` shortcut
 * by multiplying by -1 when the ref is "S" or "W" — but its internal
 * conversion only sees the ref tags if they pass through the pick filter.
 * Drop them and every western-hemisphere coord comes back positive.
 */
export const EXIF_PICK_TAGS = [
  'DateTimeOriginal',
  'CreateDate',
  'Make',
  'Model',
  'LensModel',
  'LensInfo',
  'Lens',
  'ISO',
  'ISOSpeedRatings',
  'FNumber',
  'ApertureValue',
  'ExposureTime',
  'ShutterSpeedValue',
  'FocalLength',
  'latitude',
  'longitude',
  'GPSLatitude',
  'GPSLongitude',
  'GPSLatitudeRef',
  'GPSLongitudeRef',
] as const;

type LooseRecord = Record<string, unknown>;

function asString(v: unknown): string | null {
  if (typeof v === 'string') {
    const s = v.trim();
    return s.length > 0 ? s : null;
  }
  return null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * EXIF DateTimeOriginal can be a Date (exifr's default) or a string.
 *
 * [P0, caught in review on the web port of this function,
 * `src/web/projects/maple-common/src/lib/addressing/captured-at.ts`]:
 * EXIF's DateTimeOriginal/CreateDate tags carry NO timezone offset per
 * spec — a bare "YYYY:MM:DD HH:MM:SS". An earlier version of this
 * function built that into a string like "2026-07-12T10:30:00" and passed
 * it to `new Date(...)`; per the ECMAScript spec, a date-TIME string with
 * no trailing `Z`/offset is parsed in the JS engine's LOCAL timezone, not
 * UTC. This process is deployed with `TZ=UTC` by convention today, so the
 * ambiguity was latent, not actively wrong — but it was never enforced by
 * this code, only by deployment configuration, and this value feeds the
 * cross-platform `maple_id` hash directly. `Date.UTC(...)`'s numeric-
 * component constructor has no string-parsing ambiguity at all: it is
 * always UTC regardless of process timezone, matching the Apple port's
 * same explicit choice (`ExifCaptureDate.swift`), fixed in lockstep with
 * the web port above.
 */
function asIsoDate(v: unknown): string | null {
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
 * Format ExposureTime (seconds) into a human-friendly string.
 * - >= 1s: decimal with one fraction digit when needed (e.g. "0.5", "2", "30")
 * - < 1s: 1/N rounded to nearest integer (e.g. "1/250")
 */
function formatShutter(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return String(seconds);
  if (seconds >= 1) {
    // Trim trailing zeros: 2.0 -> "2", 0.5 -> "0.5".
    return Number.isInteger(seconds) ? String(seconds) : String(Number(seconds.toFixed(2)));
  }
  return `1/${Math.max(1, Math.round(1 / seconds))}`;
}

/** Build an `AssetExif` from a loose exifr parse result. */
export function normalizeExif(raw: LooseRecord): AssetExif {
  const captured_at = asIsoDate(raw['DateTimeOriginal']) ?? asIsoDate(raw['CreateDate']);
  // Pre-compute year + month (UTC) at index time so the buckets endpoint
  // can $group without parsing captured_at per-document. The timeline view
  // already operates in UTC; doing the same here keeps results consistent.
  let captured_year: number | null = null;
  let captured_month: number | null = null;
  if (captured_at) {
    const d = new Date(captured_at);
    if (!Number.isNaN(d.getTime())) {
      captured_year = d.getUTCFullYear();
      captured_month = d.getUTCMonth() + 1;
    }
  }
  const camera_make = asString(raw['Make']);
  const camera_model = asString(raw['Model']);
  const lens = asString(raw['LensModel']) ?? asString(raw['Lens']) ?? asString(raw['LensInfo']);
  const iso = asNumber(raw['ISO']) ?? asNumber(raw['ISOSpeedRatings']);
  const aperture = asNumber(raw['FNumber']) ?? asNumber(raw['ApertureValue']);
  const exposureTime = asNumber(raw['ExposureTime']);
  const shutter = exposureTime != null ? formatShutter(exposureTime) : null;
  const focal_length = asNumber(raw['FocalLength']);

  // exifr returns decimal lat/lng on the top level when `gps: true`.
  const lat = asNumber(raw['latitude']);
  const lng = asNumber(raw['longitude']);
  const gps =
    lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;

  return {
    captured_at,
    captured_year,
    captured_month,
    camera_make,
    camera_model,
    lens,
    iso,
    aperture,
    shutter,
    focal_length,
    gps,
  };
}

const EXIFR_PARSE_OPTS = {
  pick: EXIF_PICK_TAGS as unknown as string[],
  gps: true,
  // Keep dates as Date objects so we can format them ourselves.
  // exifr's default `reviveValues` already does this.
};

/**
 * Parse EXIF for one file.
 *
 * Returns null for the *expected* no-metadata cases: an unsupported
 * extension, or a file the parser read cleanly but that simply carries no
 * EXIF. Those are terminal — the stage records `exif: null` and advances.
 *
 * It deliberately does NOT swallow parse/IO failures any more. A throw here
 * (truncated header from a half-copied file, a transient FS error like EBUSY)
 * is propagated so the stage runner's retry/backoff path gets another pass
 * once the file settles, instead of permanently stamping `exif: null` on a
 * file that will read fine seconds later. Genuinely unreadable files still
 * dead-letter after `maxAttempts`, which surfaces them rather than silently
 * dropping their metadata.
 */
export async function readExif(absPath: string): Promise<AssetExif | null> {
  const ext = path.extname(absPath).toLowerCase();

  // Video containers carry no EXIF, but iPhone `.mov`/`.mp4` keep their capture
  // date + GPS in the QuickTime `moov` atom. Read those (pure-JS, seeks past the
  // media body) and map onto the same `AssetExif` shape so videos get dated and
  // geo-filed exactly like photos. `VIDEO_EXTS ⊂ NO_EXIF_EXTS`, so this branch
  // must precede the skip below.
  if (VIDEO_EXTS.has(ext)) {
    const meta = await readVideoMetadata(absPath);
    if (!meta) return null;
    return normalizeExif({
      CreateDate: meta.creationDate ?? undefined,
      latitude: meta.latitude ?? undefined,
      longitude: meta.longitude ?? undefined,
      Make: meta.make ?? undefined,
      Model: meta.model ?? undefined,
    });
  }

  if (NO_EXIF_EXTS.has(ext)) return null;

  // A real image is never 0 bytes. Handed an empty file, exifr's reader trips
  // over the absent TIFF header and throws the opaque "undefined is not an
  // object (evaluating 'this.dataView.getUint16')". Fail with a message that
  // names the cause instead. This is a library-level safety net: the exif
  // stage already short-circuits empty files to a `damaged` tag before calling
  // readExif (see workers/stages/exif.ts), but readExif is a standalone
  // function and must not surface exifr's opaque crash to any caller.
  const { size } = await fs.stat(absPath);
  if (size === 0) {
    throw new Error(
      `cannot read EXIF: file is empty (0 bytes), likely an incomplete copy: ${absPath}`,
    );
  }

  if (HEIC_EXTS.has(ext)) {
    // exifr can't get past its ftyp gate for these — extract the TIFF block
    // ourselves, then let exifr parse that as a bare TIFF.
    const tiff = await readHeicExifTiff(absPath);
    if (!tiff) return null;
    const raw = (await exifr.parse(tiff, EXIFR_PARSE_OPTS)) as LooseRecord | undefined;
    return raw ? normalizeExif(raw) : null;
  }

  if (WEBP_EXTS.has(ext)) {
    // exifr has no WebP parser — pull the TIFF out of the RIFF `EXIF` chunk
    // ourselves, then let exifr parse that as a bare TIFF.
    const tiff = await readWebpExifTiff(absPath);
    if (!tiff) return null;
    const raw = (await exifr.parse(tiff, EXIFR_PARSE_OPTS)) as LooseRecord | undefined;
    return raw ? normalizeExif(raw) : null;
  }

  const raw = (await exifr.parse(absPath, EXIFR_PARSE_OPTS)) as LooseRecord | undefined;
  if (!raw) return null;
  return normalizeExif(raw);
}
