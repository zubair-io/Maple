/**
 * Fallback capture-time parser for filenames written by a camera/phone's
 * default naming convention, for use when an asset has no EXIF
 * `DateTimeOriginal`/`CreateDate`. Currently recognizes the Android
 * stock-camera convention: `IMG_YYYYMMDD_HHMMSS[_NNN].<ext>`.
 *
 * Used by the `refile-legacy-daydir` migration, where old backup-format
 * assets can have null EXIF but a filename that still encodes the true
 * capture time — see `workers/migration/refile-legacy-daydir.ts`.
 */

const ANDROID_IMG_FILENAME_RE =
  /^img_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})(?:_\d+)?\.[a-z0-9]+$/i;

/** Earliest plausible year for a digital-camera-era filename date — bounds
 * out an all-zero or otherwise garbage match rather than returning a
 * nonsensical date. */
const MIN_PLAUSIBLE_YEAR = 1995;
const MAX_PLAUSIBLE_YEAR = 2100;

export function parseFilenameCapturedAt(filename: string): Date | null {
  const m = ANDROID_IMG_FILENAME_RE.exec(filename);
  if (!m) return null;

  const [, yStr, moStr, dStr, hStr, miStr, sStr] = m;
  const year = Number(yStr);
  const month = Number(moStr);
  const day = Number(dStr);
  const hour = Number(hStr);
  const minute = Number(miStr);
  const second = Number(sStr);

  if (year < MIN_PLAUSIBLE_YEAR || year > MAX_PLAUSIBLE_YEAR) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  // Date.UTC silently rolls an invalid day-in-month over into the next month
  // (e.g. Feb 30 -> Mar 2) instead of throwing — reject anything that rolled.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}
