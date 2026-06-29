/**
 * Input type for batch metadata edits (#1580 — Batch Metadata M1).
 *
 * Mirrors `XmpMetadata` from the web layer (xmp.types.ts) with the addition
 * of a resolved `keywords` list. Inlined here (not imported from the web
 * project) because cross-project imports don't work cleanly in the API's
 * Bun/Node environment.
 */

/** Copyright status tri-state (mirrors CopyrightStatus from xmp.types.ts). */
export type CopyrightStatus = "unknown" | "copyrighted" | "public-domain";

/**
 * Metadata fields the batch route accepts per asset.
 * All fields are optional; only those present are written.
 * `null` means "explicitly clear this field".
 */
export interface XmpMetadataInput {
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
  copyrightStatus?: CopyrightStatus | null;
  usageTerms?: string | null;
  credit?: string | null;
  source?: string | null;
  /** Resolved keyword list (after applying the keyword op).
   * The batch route writes this directly as dc:subject bag. */
  keywords?: string[];
  /** Star rating 0–5. 0 means "no rating" / clear.
   * Written as `xmp:Rating` attribute. */
  rating?: number | null;
  /** Pick/reject flag. 'unflagged' means "clear".
   * Written as `papp:Flag` attribute. */
  flag?: "pick" | "reject" | "unflagged" | null;
  /** Color label. null means "clear".
   * Written as `papp:ColorLabel` attribute. */
  colorLabel?: "red" | "orange" | "yellow" | "green" | "blue" | null;
}
