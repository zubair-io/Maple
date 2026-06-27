/**
 * Effective-metadata resolver (#1580 — Batch Metadata M1).
 *
 * Computes the "user-visible" value for each search/sort/geo field by
 * applying `metadata_override` on top of immutable `exif.*`:
 *
 *   effective.field = override.field ?? exif.field ?? null
 *
 * Display panels, search/faceting, date sort, and the geo-organised backup
 * layout all read **effective** values — not `exif.*` directly.
 *
 * `captured_year` / `captured_month` are re-derived from the effective
 * `captured_at` string so a time-shift edit doesn't require a separate
 * re-index step; the override-ingest stage writes them into the asset doc.
 *
 * Spec: docs/superpowers/specs/2026-06-26-batch-metadata-editor-design.md
 * §"Storage & data-flow model" / "Effective resolver".
 */

import type { AssetDoc, MetadataOverride } from '../db/schema.ts';

/** The resolved "what the app sees" view of an asset's metadata. */
export interface EffectiveMetadata {
  /** ISO 8601 capture time; `null` when unknown. */
  captured_at: string | null;
  /** UTC year extracted from effective captured_at; `null` when no timestamp. */
  captured_year: number | null;
  /** UTC month (1..12) extracted from effective captured_at; `null` when no timestamp. */
  captured_month: number | null;
  /** GPS in `{ lat, lng }` form; `null` when unknown or explicitly cleared. */
  gps: { lat: number; lng: number } | null;
  /** IANA time zone name from the override; `null` when not set. */
  time_zone: string | null;
  /** IPTC place text from the override; `null` when not set. */
  place_text: MetadataOverride['place_text'];
}

/**
 * Parse the UTC year and month (1..12) from an ISO 8601 timestamp string.
 * Returns `{ year: null, month: null }` when the string is absent or
 * un-parseable — mirrors the exif-stage's handling of bad DateTimeOriginal.
 */
export function parseYearMonth(isoString: string | null | undefined): {
  year: number | null;
  month: number | null;
} {
  if (!isoString) return { year: null, month: null };
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return { year: null, month: null };
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

/**
 * Compute the effective metadata for an asset.
 *
 * `doc` only needs `exif` and `metadata_override`; callers may pass any
 * superset (e.g. a full `AssetDoc`) without issue.
 */
export function effectiveMetadata(
  doc: Pick<AssetDoc, 'exif' | 'metadata_override'>,
): EffectiveMetadata {
  const override = doc.metadata_override ?? null;
  const exif = doc.exif ?? null;

  // Spec resolver formula: effective = override ?? exif. A nullish override
  // value (absent OR explicit null) falls back to the exif file-original — so
  // clearing an override reverts to the original (matches "Reset to original").
  const captured_at: string | null = override?.captured_at ?? exif?.captured_at ?? null;

  const { year, month } = parseYearMonth(captured_at);

  const overrideGps = override?.gps;
  const gps: { lat: number; lng: number } | null = overrideGps
    ? { lat: overrideGps.lat, lng: overrideGps.lng }
    : (exif?.gps ?? null);

  return {
    captured_at,
    captured_year: year,
    captured_month: month,
    gps,
    time_zone: override?.time_zone ?? null,
    place_text: override?.place_text ?? null,
  };
}
