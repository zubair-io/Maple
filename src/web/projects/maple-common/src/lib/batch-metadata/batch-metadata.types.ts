// batch-metadata.types.ts — shared types for the Batch Metadata M2 web UI (#1606).
// Spec: docs/superpowers/specs/2026-06-26-batch-metadata-editor-design.md

import type { XmpMetadata } from '../xmp/xmp.types';

// ---------------------------------------------------------------------------
// Mixed-value sentinel
// ---------------------------------------------------------------------------

/**
 * Sentinel string marking a field whose value differs across the selected
 * assets. Components display "(mixed)" and do NOT touch the field on submit
 * unless the user edits it.
 */
export const MIXED = '__mixed__' as const;
export type MixedSentinel = typeof MIXED;

/** A field value that may be uniform (the typed value) or mixed. */
export type MixedOr<T> = T | MixedSentinel;

// ---------------------------------------------------------------------------
// Mixed-value map — one entry per editable field
// ---------------------------------------------------------------------------

/**
 * Per-field view of the current selection. Each key maps to either the
 * single consistent value across all selected assets or `MIXED` when values
 * differ. `undefined` means no asset in the selection has that field set.
 */
export interface MixedValueMap {
  gpsLatitude: MixedOr<number | null | undefined>;
  gpsLongitude: MixedOr<number | null | undefined>;
  gpsAltitude: MixedOr<number | null | undefined>;
  dateTimeOriginal: MixedOr<string | null | undefined>;
  timeZone: MixedOr<string | null | undefined>;
  sublocation: MixedOr<string | null | undefined>;
  city: MixedOr<string | null | undefined>;
  state: MixedOr<string | null | undefined>;
  country: MixedOr<string | null | undefined>;
  countryCode: MixedOr<string | null | undefined>;
  title: MixedOr<string | null | undefined>;
  caption: MixedOr<string | null | undefined>;
  headline: MixedOr<string | null | undefined>;
  keywords: MixedOr<string[] | undefined>;
  instructions: MixedOr<string | null | undefined>;
  creator: MixedOr<string | null | undefined>;
  creatorJobTitle: MixedOr<string | null | undefined>;
  copyrightNotice: MixedOr<string | null | undefined>;
  copyrightStatus: MixedOr<'unknown' | 'copyrighted' | 'public-domain' | null | undefined>;
  usageTerms: MixedOr<string | null | undefined>;
  credit: MixedOr<string | null | undefined>;
  source: MixedOr<string | null | undefined>;
}

// ---------------------------------------------------------------------------
// Asset metadata snapshot (selection at panel-open time)
// ---------------------------------------------------------------------------

/** Metadata for a single asset, snapshotted at the moment the panel opens. */
export interface AssetMetadataSnapshot {
  /** Absolute on-disk path — used as the key for the batch write payload. */
  path: string;
  metadata: Partial<XmpMetadata> & {
    keywords?: string[];
  };
}

// ---------------------------------------------------------------------------
// Geocode candidate (from GET /api/geocode/search)
// ---------------------------------------------------------------------------

export interface GeocodeCandidate {
  displayName: string;
  lat: number;
  lon: number;
  /** Structured address components from Nominatim (city, country, etc.). */
  address: Record<string, string>;
}

// ---------------------------------------------------------------------------
// computeMixedValues — pure function (no Angular, testable standalone)
// ---------------------------------------------------------------------------

/**
 * Compute per-field mixed-value status from a set of asset snapshots.
 * Exported as a pure function so it can be unit-tested without Angular DI.
 * `BatchMetadataService.computeMixedValues` delegates to this.
 */
export function computeMixedValues(snapshots: AssetMetadataSnapshot[]): MixedValueMap {
  if (snapshots.length === 0) {
    return _emptyMixedMap();
  }

  const first = snapshots[0]!;

  const scalar = <T>(getter: (s: AssetMetadataSnapshot) => T): T | typeof MIXED => {
    const base = getter(first);
    const allSame = snapshots.every((s) => {
      const v = getter(s);
      if (Array.isArray(base) && Array.isArray(v)) {
        return base.length === v.length && (base as unknown[]).every((k, i) => k === v[i]);
      }
      return v === base;
    });
    return allSame ? base : MIXED;
  };

  return {
    gpsLatitude: scalar((s) => s.metadata.gpsLatitude),
    gpsLongitude: scalar((s) => s.metadata.gpsLongitude),
    gpsAltitude: scalar((s) => s.metadata.gpsAltitude),
    dateTimeOriginal: scalar((s) => s.metadata.dateTimeOriginal),
    timeZone: scalar((s) => s.metadata.timeZone),
    sublocation: scalar((s) => s.metadata.sublocation),
    city: scalar((s) => s.metadata.city),
    state: scalar((s) => s.metadata.state),
    country: scalar((s) => s.metadata.country),
    countryCode: scalar((s) => s.metadata.countryCode),
    title: scalar((s) => s.metadata.title),
    caption: scalar((s) => s.metadata.caption),
    headline: scalar((s) => s.metadata.headline),
    keywords: scalar((s) => s.metadata.keywords),
    instructions: scalar((s) => s.metadata.instructions),
    creator: scalar((s) => s.metadata.creator),
    creatorJobTitle: scalar((s) => s.metadata.creatorJobTitle),
    copyrightNotice: scalar((s) => s.metadata.copyrightNotice),
    copyrightStatus: scalar((s) => s.metadata.copyrightStatus),
    usageTerms: scalar((s) => s.metadata.usageTerms),
    credit: scalar((s) => s.metadata.credit),
    source: scalar((s) => s.metadata.source),
  };
}

function _emptyMixedMap(): MixedValueMap {
  return {
    gpsLatitude: undefined,
    gpsLongitude: undefined,
    gpsAltitude: undefined,
    dateTimeOriginal: undefined,
    timeZone: undefined,
    sublocation: undefined,
    city: undefined,
    state: undefined,
    country: undefined,
    countryCode: undefined,
    title: undefined,
    caption: undefined,
    headline: undefined,
    keywords: undefined,
    instructions: undefined,
    creator: undefined,
    creatorJobTitle: undefined,
    copyrightNotice: undefined,
    copyrightStatus: undefined,
    usageTerms: undefined,
    credit: undefined,
    source: undefined,
  };
}

// ---------------------------------------------------------------------------
// Batch apply (maps to POST /api/xmp/batch)
// ---------------------------------------------------------------------------

export type BatchApplyMetadata = Partial<XmpMetadata> & {
  keywords?: string[];
};

export interface BatchApplyEntry {
  path: string;
  metadata: BatchApplyMetadata;
}

export interface BatchApplyResult {
  results: Array<{ path: string; ok: boolean; error?: string }>;
}
