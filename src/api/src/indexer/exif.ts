/**
 * EXIF extraction from image/RAW files.
 *
 * Uses the `exifr` npm package to parse JPEG, TIFF, DNG, and most RAW
 * container formats (CR2, CR3, NEF, ARW, RAF, ORF, RW2, etc). Some
 * proprietary RAW formats have weak/absent metadata — those leave the
 * `exif` field null and downstream stages keep advancing.
 *
 * The XMP sidecar is still consulted for Maple-side fields (rating, flag,
 * color label) since those are the editor's authoritative source.
 *
 * The exif subdoc and the XMP-derived fields are persisted in one Mongo
 * update keyed on `abs_path` (the asset row already exists by the time the
 * exif stage runs because the discover→hash chain has staged it).
 */

import { assetsCollection } from "../db/client.ts";
import type { AssetExif } from "../db/schema.ts";
import exifr from "exifr";

/**
 * exifr's parse result is a loose record. We pluck the fields we want and
 * narrow them ourselves rather than slurping the whole tag dump (some files
 * pull in maker-notes blobs that are tens of KB).
 */
const EXIF_PICK_TAGS = [
  "DateTimeOriginal",
  "CreateDate",
  "Make",
  "Model",
  "LensModel",
  "LensInfo",
  "Lens",
  "ISO",
  "ISOSpeedRatings",
  "FNumber",
  "ApertureValue",
  "ExposureTime",
  "ShutterSpeedValue",
  "FocalLength",
  "latitude",
  "longitude",
  "GPSLatitude",
  "GPSLongitude",
] as const;

type LooseRecord = Record<string, unknown>;

function asString(v: unknown): string | null {
  if (typeof v === "string") {
    const s = v.trim();
    return s.length > 0 ? s : null;
  }
  return null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** EXIF DateTimeOriginal can be a Date (exifr's default) or a string. */
function asIsoDate(v: unknown): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return v.toISOString();
  }
  if (typeof v === "string") {
    // Try EXIF format "YYYY:MM:DD HH:MM:SS" first, then ISO.
    const exifMatch = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(v);
    if (exifMatch) {
      const [, y, mo, d, h, mi, s] = exifMatch;
      const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
      const t = new Date(iso);
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
  const captured_at = asIsoDate(raw["DateTimeOriginal"]) ?? asIsoDate(raw["CreateDate"]);
  const camera_make = asString(raw["Make"]);
  const camera_model = asString(raw["Model"]);
  const lens =
    asString(raw["LensModel"]) ?? asString(raw["Lens"]) ?? asString(raw["LensInfo"]);
  const iso = asNumber(raw["ISO"]) ?? asNumber(raw["ISOSpeedRatings"]);
  const aperture = asNumber(raw["FNumber"]) ?? asNumber(raw["ApertureValue"]);
  const exposureTime = asNumber(raw["ExposureTime"]);
  const shutter = exposureTime != null ? formatShutter(exposureTime) : null;
  const focal_length = asNumber(raw["FocalLength"]);

  // exifr returns decimal lat/lng on the top level when `gps: true`.
  const lat = asNumber(raw["latitude"]);
  const lng = asNumber(raw["longitude"]);
  const gps =
    lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
      ? { lat, lng }
      : null;

  return {
    captured_at,
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

/**
 * Parse EXIF for one file. Returns null if the file has no readable EXIF
 * (parser threw, or returned undefined).
 */
export async function readExif(absPath: string): Promise<AssetExif | null> {
  try {
    const raw = (await exifr.parse(absPath, {
      pick: EXIF_PICK_TAGS as unknown as string[],
      gps: true,
      // Keep dates as Date objects so we can format them ourselves.
      // exifr's default `reviveValues` already does this.
    })) as LooseRecord | undefined;
    if (!raw) return null;
    return normalizeExif(raw);
  } catch (err) {
    console.warn(
      "[indexer:exif] exifr failed for",
      absPath,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/**
 * Backfill helper for the one-shot upgrade in `IndexerService`.
 *
 * Updates an existing asset row with freshly-parsed EXIF and sidecar fields.
 * Used to upgrade rows that were indexed before EXIF support landed (i.e.
 * `{ exif: { $exists: false } }`). Returns true if the document was matched
 * (so the caller can count progress).
 *
 * Pipeline jobs do NOT call this — they let the exif stage populate `job.exif`
 * and rely on the mongo stage's upsert to write it. Calling this from the
 * pipeline would race against the mongo stage's own `$set`.
 */
export async function backfillAssetExif(absPath: string): Promise<boolean> {
  const [exif, sidecar] = await Promise.all([
    readExif(absPath),
    (async () => {
      const { readXmp } = await import("../fs/xmp.ts");
      const result = await readXmp(absPath);
      if (!result.ok) return null;
      const xml = result.data!;
      const ratingMatch = xml.match(/xmp:Rating\s*=\s*["'](\d+)["']/);
      const rating = ratingMatch ? Math.min(5, Math.max(0, Number(ratingMatch[1]))) : 0;
      const flagMatch = xml.match(/maple:Flag\s*=\s*["'](-?\d+)["']/);
      const rawFlag = flagMatch ? Number(flagMatch[1]) : 0;
      const flag = (rawFlag === 1 ? 1 : rawFlag === -1 ? -1 : 0) as -1 | 0 | 1;
      const labelMatch = xml.match(/maple:ColorLabel\s*=\s*["']([^"']*)["']/);
      const color_label = labelMatch ? labelMatch[1] : "";
      return { rating, flag, color_label };
    })(),
  ]);

  const $set: Record<string, unknown> = { exif };
  if (sidecar) {
    $set.rating = sidecar.rating;
    $set.flag = sidecar.flag;
    $set.color_label = sidecar.color_label;
  }
  const coll = await assetsCollection();
  const r = await coll.updateOne({ abs_path: absPath }, { $set });
  return r.matchedCount > 0;
}
