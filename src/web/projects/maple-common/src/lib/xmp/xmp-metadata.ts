// xmp-metadata.ts — standard-XMP encodings + field tables for the IPTC/EXIF
// metadata block (Batch Metadata, spec 2026-06-26). Kept separate from the
// adjustment/culling field tables so the serializer/parser stay focused.

/** Axis selector for GPS encoding (picks the N/S vs E/W hemisphere suffix). */
export type GpsAxis = 'lat' | 'lon';

/**
 * Encode a signed decimal degree to the Adobe XMP `exif:GPSLatitude/Longitude`
 * form: `DDD,MM.mmmm{N|S|E|W}` (degrees, decimal-minutes, hemisphere). Minutes
 * are formatted to 4 decimal places — Lightroom's precision (~2cm).
 */
export function gpsToXmp(value: number, axis: GpsAxis): string {
  const positive = value >= 0;
  const abs = Math.abs(value);
  const deg = Math.floor(abs);
  const min = (abs - deg) * 60;
  const hemi = axis === 'lat' ? (positive ? 'N' : 'S') : positive ? 'E' : 'W';
  return `${deg},${min.toFixed(4)}${hemi}`;
}

/**
 * Decode an `exif:GPSLatitude/Longitude` string back to signed decimal
 * degrees. Accepts the canonical `DDD,MM.mmmm{N|S|E|W}` form. Returns `null`
 * if the string does not match (so a hand-edited sidecar never throws).
 */
export function gpsFromXmp(s: string): number | null {
  const m = /^(\d+),(\d+(?:\.\d+)?)([NSEW])$/.exec(s.trim());
  if (!m) return null;
  const deg = Number(m[1]);
  const min = Number(m[2]);
  const sign = m[3] === 'S' || m[3] === 'W' ? -1 : 1;
  return sign * (deg + min / 60);
}
