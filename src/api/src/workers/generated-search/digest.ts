/**
 * Library digest for the generated-search prompt — the small block of facts
 * the model cannot infer (who exists, what years have photos, what themes
 * ran recently).
 *
 * This file holds the pure shaping rules; the Mongo aggregations that feed
 * them live with the worker.
 */

/**
 * Timestamps that are not photograph dates but software defaults leaking out
 * of unparseable EXIF. They must be dropped by name, because they arrive in
 * volume: the live library carries 1,931 assets stamped 1899 (the OLE /
 * Excel epoch, 1899-12-30). Any threshold that catches those would also
 * discard real years.
 *
 *   1899 — OLE Automation / Excel epoch
 *   1900 — Lotus/Excel serial-date origin
 *   1904 — classic Mac OS epoch
 *   1970 — Unix epoch
 *
 * A personal digital photo library has no genuine assets in these years.
 * Scanned film from e.g. 1980 is plausible and is deliberately NOT listed —
 * it is governed by the volume floor below instead.
 */
const EPOCH_SENTINEL_YEARS: ReadonlySet<number> = new Set([1899, 1900, 1904, 1970]);

/**
 * Fewest assets a year needs before it can anchor a collection.
 *
 * Sized against the observed junk tail (1971×1, 1988×1, 1992×2, 1995×5)
 * versus the smallest plausible real year (1980×61). Anything under this is
 * too thin to build a themed collection from even when the timestamps are
 * genuine.
 */
export const MIN_YEAR_ASSETS = 50;

export interface YearCount {
  year: number;
  count: number;
}

/**
 * Years worth showing the model, ascending.
 *
 * Two independent filters — neither subsumes the other. Sentinels arrive in
 * volume so no threshold catches them; thin years are unremarkable so no
 * name list catches them.
 */
export function credibleYears(counts: readonly YearCount[]): number[] {
  return counts
    .filter(({ year, count }) => !EPOCH_SENTINEL_YEARS.has(year) && count >= MIN_YEAR_ASSETS)
    .map(({ year }) => year)
    .sort((a, b) => a - b);
}
