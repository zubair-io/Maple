// XMP types — culling fields (P5) + passthrough bucket (P6).

export type XmpFlag = 'pick' | 'reject' | 'unflagged';

export type XmpColorLabel = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | null;

export interface XmpCulling {
  rating: number; // 0..5, defaults to 0
  flag: XmpFlag;
  colorLabel: XmpColorLabel;
  /**
   * IPTC keywords (#632). Round-tripped through the XMP `dc:subject`
   * element as `<dc:subject><rdf:Bag><rdf:li>kw</rdf:li>…</rdf:Bag></dc:subject>`
   * per the Dublin Core schema. Optional so callers that don't carry
   * keyword data (legacy snapshots, mock fixtures) don't have to touch
   * an empty array — the parser/serializer treat `undefined` and `[]`
   * identically: emit no element on write, parse-back to empty.
   */
  keywords?: string[];
}

/** Copyright status (`xmpRights:Marked`): tri-state. `unknown` omits the attribute. */
export type CopyrightStatus = 'unknown' | 'copyrighted' | 'public-domain';

/**
 * User-authored capture/IPTC metadata persisted to the XMP sidecar (Batch
 * Metadata, spec 2026-06-26). All fields optional; `null`/`undefined` mean
 * "not set" and emit nothing. Values are in native units (signed decimal
 * degrees, ISO-8601 datetime with offset, plain strings) — the standard-XMP
 * text encodings live in `xmp-metadata.ts`.
 */
export interface XmpMetadata {
  gpsLatitude?: number | null;
  gpsLongitude?: number | null;
  gpsAltitude?: number | null;
  dateTimeOriginal?: string | null;
  timeZone?: string | null;
  sublocation?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  countryCode?: string | null;
  title?: string | null;
  caption?: string | null;
  headline?: string | null;
  instructions?: string | null;
  creator?: string | null;
  creatorJobTitle?: string | null;
  copyrightNotice?: string | null;
  copyrightStatus?: CopyrightStatus;
  usageTerms?: string | null;
  credit?: string | null;
  source?: string | null;
}

/**
 * Unknown attributes and nested elements from a source sidecar that Maple
 * does not model (ToneCurve, MaskGroupBasedCorrections, etc.).
 * Preserved verbatim on writes so Lightroom round-trips are non-destructive.
 */
export interface PassthroughBucket {
  /** Attributes on rdf:Description that are not in Maple's known set. */
  unknownAttributes: Array<{ name: string; value: string }>;
  /** Serialized XML of child elements of rdf:Description Maple doesn't model. */
  unknownNodes: string[];
}
