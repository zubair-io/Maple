/**
 * Server-side XMP metadata parser — Bun-compatible, no DOMParser.
 *
 * The web `XmpParserService.parseMetadata()` uses `DOMParser` (browser API),
 * which is not available in Bun. This module implements the same field
 * semantics using regex-based attribute and nested-element extraction.
 *
 * Canonical field definitions: `src/web/projects/maple-common/src/lib/xmp/xmp-metadata.ts`.
 * The GPS/altitude/copyright decode functions below are copied from that module
 * (pure math, ~30 lines) to avoid a cross-project import. If those functions
 * change, update here and bump `METADATA_PARSER_VERSION`.
 *
 * Spec: docs/superpowers/specs/2026-06-26-batch-metadata-editor-design.md
 */

import type { MetadataOverride } from '../db/schema.ts';

/** Version sentinel — bump when parse semantics change to invalidate cached overrides. */
export const METADATA_PARSER_VERSION = 1;

/**
 * Parsed metadata result: all fields from XmpMetadata + keywords (keyword
 * bag lives in culling but is needed by sidecar-metadata-index). Fields are
 * undefined when absent in the sidecar.
 */
export interface XmpMetadataResult {
  gpsLatitude?: number;
  gpsLongitude?: number;
  gpsAltitude?: number;
  dateTimeOriginal?: string;
  timeZone?: string;
  sublocation?: string;
  city?: string;
  state?: string;
  country?: string;
  countryCode?: string;
  title?: string;
  caption?: string;
  headline?: string;
  instructions?: string;
  creator?: string;
  creatorJobTitle?: string;
  copyrightNotice?: string;
  copyrightStatus?: 'unknown' | 'copyrighted' | 'public-domain';
  usageTerms?: string;
  credit?: string;
  source?: string;
  keywords?: string[];
}

// ---------------------------------------------------------------------------
// Decode helpers (copied from xmp-metadata.ts — pure math, no browser deps)
// ---------------------------------------------------------------------------

/** Decode `DDD,MM.mmmm{N|S|E|W}` → signed decimal degrees; `null` if malformed. */
function gpsFromXmp(s: string): number | null {
  const m = /^(\d+),(\d+(?:\.\d+)?)([NSEW])$/.exec(s.trim());
  if (!m) return null;
  const deg = Number(m[1]);
  const min = Number(m[2]);
  const sign = m[3] === 'S' || m[3] === 'W' ? -1 : 1;
  const result = sign * (deg + min / 60);
  return result === 0 ? 0 : result;
}

/** Decode altitude rational + ref to signed meters; `null` if malformed. */
function altitudeFromXmp(value: string, ref: string): number | null {
  const m = /^(\d+)\/(\d+)$/.exec(value.trim());
  if (!m) return null;
  const denom = Number(m[2]);
  if (denom === 0) return null;
  const meters = Number(m[1]) / denom;
  return ref === '1' ? -meters : meters;
}

const MARKED_TO_COPYRIGHT: Record<string, 'copyrighted' | 'public-domain'> = {
  True: 'copyrighted',
  False: 'public-domain',
};

/** Map `xmpRights:Marked` value to tri-state; `null` for absent/unrecognised. */
function copyrightStatusFromMarked(
  marked: string | null,
): 'unknown' | 'copyrighted' | 'public-domain' | null {
  if (marked === null) return null;
  return MARKED_TO_COPYRIGHT[marked] ?? null;
}

// ---------------------------------------------------------------------------
// Attribute extraction — regex over the rdf:Description opening tag
// ---------------------------------------------------------------------------

/**
 * Extract all `name="value"` pairs from the opening `<rdf:Description …>` tag.
 * Returns a Map of attribute name → raw string value (XML-unescaped by
 * `unescapeXml`).
 *
 * The regex matches both namespaced (`ns:Local`) and unqualified names.
 * It intentionally does NOT traverse the full DOM — we only need the
 * rdf:Description attributes and a handful of nested elements.
 */
function extractAttributes(xml: string): Map<string, string> {
  // Find the rdf:Description opening tag (or the root element if no wrapper).
  // The tag may span multiple lines due to pretty-printing.
  const descMatch =
    /<rdf:Description([^>]*(?:>[^<]*<[^>]+>[^>]*)*)?>/.exec(xml) ??
    /<Description([^>]*)>/.exec(xml);
  const attrStr = descMatch ? (descMatch[1] ?? '') : xml;

  const attrs = new Map<string, string>();
  // Match name="value" pairs; value may contain escaped entities but not unescaped quotes.
  const attrRe = /([\w:.-]+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(attrStr)) !== null) {
    if (!m[1].startsWith('xmlns')) {
      attrs.set(m[1], unescapeXml(m[2]));
    }
  }
  return attrs;
}

/** Unescape minimal XML entities used in attribute values and text content. */
function unescapeXml(s: string): string {
  return s
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'");
}

// ---------------------------------------------------------------------------
// Nested element extraction (lang-alt / seq / bag)
// ---------------------------------------------------------------------------

/**
 * Extract the first `<rdf:li>` text content from a named nested element.
 * Handles both `dc:title` and `dc:description` forms.
 * Returns `undefined` when the element is absent or empty.
 */
function extractNestedText(xml: string, tagName: string): string | undefined {
  // Match: <tagName[attrs]>...<rdf:li[attrs]>text</rdf:li>...</tagName>
  // The `s` (dotAll) flag lets `.` match newlines for multi-line XML.
  const blockRe = new RegExp(
    `<${tagName}[\\s>][\\s\\S]*?<rdf:li[^>]*>([\\s\\S]*?)<\\/rdf:li>`,
    's',
  );
  const m = blockRe.exec(xml);
  if (!m) return undefined;
  const text = unescapeXml(m[1]).trim();
  return text.length > 0 ? text : undefined;
}

/**
 * Extract all `<rdf:li>` text values from a `<dc:subject><rdf:Bag>…</rdf:Bag></dc:subject>`
 * block. Returns de-duplicated, non-empty values in source order.
 */
function extractKeywords(xml: string): string[] | undefined {
  // Find the dc:subject block.
  const subjectRe = /<dc:subject[\s>][\s\S]*?<\/dc:subject>/s;
  const subjectMatch = subjectRe.exec(xml);
  if (!subjectMatch) return undefined;

  const block = subjectMatch[0];
  const liRe = /<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/g;
  const keywords: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = liRe.exec(block)) !== null) {
    const kw = unescapeXml(m[1]).trim();
    if (kw.length > 0 && !seen.has(kw)) {
      seen.add(kw);
      keywords.push(kw);
    }
  }
  return keywords.length > 0 ? keywords : undefined;
}

// ---------------------------------------------------------------------------
// Public parse function
// ---------------------------------------------------------------------------

/**
 * Parse the metadata block from an XMP sidecar string.
 *
 * Returns only the fields that are present and non-empty; absent fields are
 * left `undefined`. Never throws — malformed or empty XML returns `{}`.
 *
 * Mirrors `XmpParserService.parseMetadata()` from the web layer.
 */
export function parseXmpMetadata(xml: string): XmpMetadataResult {
  if (!xml || xml.trim().length === 0) return {};

  const attrs = extractAttributes(xml);
  const result: XmpMetadataResult = {};

  const str = (key: string): string | undefined => {
    const v = attrs.get(key);
    if (v === undefined) return undefined;
    const trimmed = v.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };

  // GPS
  const latStr = str('exif:GPSLatitude');
  if (latStr !== undefined) {
    const v = gpsFromXmp(latStr);
    if (v !== null) result.gpsLatitude = v;
  }
  const lonStr = str('exif:GPSLongitude');
  if (lonStr !== undefined) {
    const v = gpsFromXmp(lonStr);
    if (v !== null) result.gpsLongitude = v;
  }
  const altStr = str('exif:GPSAltitude');
  if (altStr !== undefined) {
    const v = altitudeFromXmp(altStr, str('exif:GPSAltitudeRef') ?? '0');
    if (v !== null) result.gpsAltitude = v;
  }

  // Simple string attrs
  result.dateTimeOriginal = str('exif:DateTimeOriginal');
  result.timeZone = str('papp:TimeZone');
  result.sublocation = str('Iptc4xmpCore:Location');
  result.city = str('photoshop:City');
  result.state = str('photoshop:State');
  result.country = str('photoshop:Country');
  result.countryCode = str('Iptc4xmpCore:CountryCode');
  result.headline = str('photoshop:Headline');
  result.instructions = str('photoshop:Instructions');
  result.creatorJobTitle = str('photoshop:AuthorsPosition');
  result.credit = str('photoshop:Credit');
  result.source = str('photoshop:Source');

  // Copyright status
  const markedStr = str('xmpRights:Marked') ?? null;
  const status = copyrightStatusFromMarked(markedStr !== undefined ? markedStr : null);
  if (status !== null) result.copyrightStatus = status;

  // Nested lang-alt / seq elements
  result.title = extractNestedText(xml, 'dc:title');
  result.creator = extractNestedText(xml, 'dc:creator');
  result.caption = extractNestedText(xml, 'dc:description');
  result.copyrightNotice = extractNestedText(xml, 'dc:rights');
  result.usageTerms = extractNestedText(xml, 'xmpRights:UsageTerms');

  // Keywords bag
  result.keywords = extractKeywords(xml);

  // Strip undefined keys so consumers can use `key in result` cleanly.
  for (const k of Object.keys(result) as (keyof XmpMetadataResult)[]) {
    if (result[k] === undefined) delete result[k];
  }

  return result;
}

// ---------------------------------------------------------------------------
// Converter: XmpMetadataResult → MetadataOverride patch fields
// ---------------------------------------------------------------------------

/**
 * Map parsed XMP metadata to the `metadata_override` subdoc shape.
 * Returns a partial override (only the fields present in the parsed result).
 * `edited_at` and `touched_fields` are set by the caller.
 */
export function xmpMetadataToOverridePatch(
  parsed: XmpMetadataResult,
): Omit<MetadataOverride, 'edited_at' | 'touched_fields'> {
  const patch: Omit<MetadataOverride, 'edited_at' | 'touched_fields'> = {};

  if (parsed.gpsLatitude !== undefined && parsed.gpsLongitude !== undefined) {
    patch.gps = {
      lat: parsed.gpsLatitude,
      lng: parsed.gpsLongitude,
      ...(parsed.gpsAltitude !== undefined ? { alt: parsed.gpsAltitude } : {}),
    };
  }

  if (parsed.dateTimeOriginal !== undefined) patch.captured_at = parsed.dateTimeOriginal;
  if (parsed.timeZone !== undefined) patch.time_zone = parsed.timeZone;

  // Place text — only set when at least one field present.
  const hasPlaceText =
    parsed.sublocation !== undefined ||
    parsed.city !== undefined ||
    parsed.state !== undefined ||
    parsed.country !== undefined ||
    parsed.countryCode !== undefined;
  if (hasPlaceText) {
    patch.place_text = {
      ...(parsed.sublocation !== undefined ? { sublocation: parsed.sublocation } : {}),
      ...(parsed.city !== undefined ? { city: parsed.city } : {}),
      ...(parsed.state !== undefined ? { state: parsed.state } : {}),
      ...(parsed.country !== undefined ? { country: parsed.country } : {}),
      ...(parsed.countryCode !== undefined ? { country_code: parsed.countryCode } : {}),
    };
  }

  if (parsed.keywords !== undefined) patch.keywords = parsed.keywords;
  if (parsed.title !== undefined) patch.title = parsed.title;
  if (parsed.caption !== undefined) patch.caption = parsed.caption;
  if (parsed.headline !== undefined) patch.headline = parsed.headline;
  if (parsed.instructions !== undefined) patch.instructions = parsed.instructions;
  if (parsed.creator !== undefined) patch.creator = parsed.creator;
  if (parsed.creatorJobTitle !== undefined) patch.creator_job_title = parsed.creatorJobTitle;
  if (parsed.copyrightNotice !== undefined) patch.copyright_notice = parsed.copyrightNotice;
  if (parsed.copyrightStatus !== undefined) patch.copyright_status = parsed.copyrightStatus;
  if (parsed.usageTerms !== undefined) patch.usage_terms = parsed.usageTerms;
  if (parsed.credit !== undefined) patch.credit = parsed.credit;
  if (parsed.source !== undefined) patch.source = parsed.source;

  return patch;
}
