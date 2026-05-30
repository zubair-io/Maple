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
