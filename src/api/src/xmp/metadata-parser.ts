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
import { VALID_COLOR_LABELS, type ColorLabel } from './color-label.ts';

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
  /** Star rating 1–5 (0 is treated as absent). */
  rating?: number;
  /** Pick/reject flag. Absent means unflagged. */
  flag?: 'pick' | 'reject';
  /** Color label string. */
  colorLabel?: ColorLabel;
  isScreenshot?: boolean;
  hidden?: boolean;
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

/** XMP-standard `xmp:Label` colour words (Adobe Lightroom/Bridge) → Maple's
 * `ColorLabel` vocabulary — mirrors the web `XmpParserService`'s `LABEL_MAP`
 * (`xmp-culling.ts`). #2201: this API-side parser only recognised Maple's
 * own `papp:ColorLabel` before, so a sidecar authored purely by Lightroom
 * (which writes `xmp:Label`, never `papp:ColorLabel`) showed its color label
 * in the web editor but was invisible to search/timeline color filtering,
 * which reads the DB `color_label` field this parser populates. */
const XMP_LABEL_WORD_MAP: Record<string, ColorLabel> = {
  Red: 'red',
  Orange: 'orange',
  Yellow: 'yellow',
  Green: 'green',
  Blue: 'blue',
  Purple: 'purple',
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
// Public parse function — split into one sub-parser per field group
// (GPS, simple string attrs, copyright status, nested elements, culling) so
// `parseXmpMetadata` itself stays a flat compose-and-clean rather than
// re-accumulating every group's branching into one function (fallow-audit
// complexity gate).
// ---------------------------------------------------------------------------

type StrGetter = (key: string) => string | undefined;

/** Attribute-map lookup, trimmed and undefined-if-empty. */
function strGetter(attrs: Map<string, string>): StrGetter {
  return (key: string) => {
    const v = attrs.get(key);
    if (v === undefined) return undefined;
    const trimmed = v.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };
}

function parseGps(
  str: StrGetter,
): Pick<XmpMetadataResult, 'gpsLatitude' | 'gpsLongitude' | 'gpsAltitude'> {
  const out: Pick<XmpMetadataResult, 'gpsLatitude' | 'gpsLongitude' | 'gpsAltitude'> = {};
  const latStr = str('exif:GPSLatitude');
  if (latStr !== undefined) {
    const v = gpsFromXmp(latStr);
    if (v !== null) out.gpsLatitude = v;
  }
  const lonStr = str('exif:GPSLongitude');
  if (lonStr !== undefined) {
    const v = gpsFromXmp(lonStr);
    if (v !== null) out.gpsLongitude = v;
  }
  const altStr = str('exif:GPSAltitude');
  if (altStr !== undefined) {
    const v = altitudeFromXmp(altStr, str('exif:GPSAltitudeRef') ?? '0');
    if (v !== null) out.gpsAltitude = v;
  }
  return out;
}

type SimpleTextFields =
  | 'dateTimeOriginal'
  | 'timeZone'
  | 'sublocation'
  | 'city'
  | 'state'
  | 'country'
  | 'countryCode'
  | 'headline'
  | 'instructions'
  | 'creatorJobTitle'
  | 'credit'
  | 'source';

function parseSimpleTextAttrs(str: StrGetter): Pick<XmpMetadataResult, SimpleTextFields> {
  return {
    dateTimeOriginal: str('exif:DateTimeOriginal'),
    timeZone: str('papp:TimeZone'),
    sublocation: str('Iptc4xmpCore:Location'),
    city: str('photoshop:City'),
    state: str('photoshop:State'),
    country: str('photoshop:Country'),
    countryCode: str('Iptc4xmpCore:CountryCode'),
    headline: str('photoshop:Headline'),
    instructions: str('photoshop:Instructions'),
    creatorJobTitle: str('photoshop:AuthorsPosition'),
    credit: str('photoshop:Credit'),
    source: str('photoshop:Source'),
  };
}

function parseCopyrightStatus(str: StrGetter): Pick<XmpMetadataResult, 'copyrightStatus'> {
  const status = copyrightStatusFromMarked(str('xmpRights:Marked') ?? null);
  return status !== null ? { copyrightStatus: status } : {};
}

type NestedTextFields = 'title' | 'creator' | 'caption' | 'copyrightNotice' | 'usageTerms';

function parseNestedElements(xml: string): Pick<XmpMetadataResult, NestedTextFields> {
  return {
    title: extractNestedText(xml, 'dc:title'),
    creator: extractNestedText(xml, 'dc:creator'),
    caption: extractNestedText(xml, 'dc:description'),
    copyrightNotice: extractNestedText(xml, 'dc:rights'),
    usageTerms: extractNestedText(xml, 'xmpRights:UsageTerms'),
  };
}

function parseRatingAndFlag(str: StrGetter): Pick<XmpMetadataResult, 'rating' | 'flag'> {
  const out: Pick<XmpMetadataResult, 'rating' | 'flag'> = {};
  const ratingStr = str('xmp:Rating');
  if (ratingStr !== undefined) {
    const n = Number(ratingStr);
    if (Number.isInteger(n) && n >= 1 && n <= 5) out.rating = n;
  }
  const flagStr = str('papp:Flag');
  if (flagStr === 'pick' || flagStr === 'reject') out.flag = flagStr;
  return out;
}

/** `papp:ColorLabel` (Maple's own key) wins when both are present; falls
 * back to the XMP-standard `xmp:Label` word Lightroom/Bridge write when
 * `papp:ColorLabel` is absent or out-of-vocabulary (#2201). */
function parseColorLabel(str: StrGetter): Pick<XmpMetadataResult, 'colorLabel'> {
  const colorLabelStr = str('papp:ColorLabel');
  if (colorLabelStr !== undefined && VALID_COLOR_LABELS.has(colorLabelStr)) {
    return { colorLabel: colorLabelStr as ColorLabel };
  }
  const xmpLabelStr = str('xmp:Label');
  if (xmpLabelStr !== undefined && xmpLabelStr in XMP_LABEL_WORD_MAP) {
    return { colorLabel: XMP_LABEL_WORD_MAP[xmpLabelStr] };
  }
  return {};
}

function parseScreenshotAndHidden(
  str: StrGetter,
): Pick<XmpMetadataResult, 'isScreenshot' | 'hidden'> {
  const out: Pick<XmpMetadataResult, 'isScreenshot' | 'hidden'> = {};
  const isScrStr = str('papp:IsScreenshot');
  if (isScrStr === 'true') out.isScreenshot = true;
  else if (isScrStr === 'false') out.isScreenshot = false;
  const hiddenStr = str('papp:Hidden');
  if (hiddenStr === 'true' || hiddenStr === 'false') out.hidden = hiddenStr === 'true';
  return out;
}

/** `xmp:Rating` / `papp:Flag` / the two color-label attribute forms /
 * `papp:IsScreenshot` / `papp:Hidden`. */
function parseCulling(
  str: StrGetter,
): Pick<XmpMetadataResult, 'rating' | 'flag' | 'colorLabel' | 'isScreenshot' | 'hidden'> {
  return {
    ...parseRatingAndFlag(str),
    ...parseColorLabel(str),
    ...parseScreenshotAndHidden(str),
  };
}

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
  const str = strGetter(attrs);

  const result: XmpMetadataResult = {
    ...parseGps(str),
    ...parseSimpleTextAttrs(str),
    ...parseCopyrightStatus(str),
    ...parseNestedElements(xml),
    keywords: extractKeywords(xml),
    ...parseCulling(str),
  };

  // Strip undefined keys so consumers can use `key in result` cleanly.
  for (const k of Object.keys(result) as (keyof XmpMetadataResult)[]) {
    if (result[k] === undefined) delete result[k];
  }

  return result;
}

// ---------------------------------------------------------------------------
// Converter: XmpMetadataResult → MetadataOverride patch fields — split into
// one sub-mapper per group (GPS, place text, plain scalars, culling) so the
// public function stays a flat merge rather than one function carrying all
// ~20 fields' branching (fallow-audit complexity gate).
// ---------------------------------------------------------------------------

type OverridePatch = Omit<MetadataOverride, 'edited_at' | 'touched_fields'>;

function gpsPatch(parsed: XmpMetadataResult): Pick<OverridePatch, 'gps'> {
  if (parsed.gpsLatitude === undefined || parsed.gpsLongitude === undefined) return {};
  return {
    gps: {
      lat: parsed.gpsLatitude,
      lng: parsed.gpsLongitude,
      ...(parsed.gpsAltitude !== undefined ? { alt: parsed.gpsAltitude } : {}),
    },
  };
}

/** Only set when at least one place-text field is present. */
/** Drops every `undefined`-valued entry, so the caller can build a
 * candidate object with every field present up front and let this decide
 * which ones actually survive — replaces a chain of individual
 * `x !== undefined ? {...} : {}` conditional spreads (each one its own
 * branch for the complexity gate) with a single pass. */
function definedEntries<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

function placeTextPatch(parsed: XmpMetadataResult): Pick<OverridePatch, 'place_text'> {
  const place_text = definedEntries({
    sublocation: parsed.sublocation,
    city: parsed.city,
    state: parsed.state,
    country: parsed.country,
    country_code: parsed.countryCode,
  });
  return Object.keys(place_text).length > 0 ? { place_text } : {};
}

/** Direct `parsed.x !== undefined -> patch.y = parsed.x` mapping for the
 * text/date/keyword fields with no special composition (GPS and place text
 * are handled separately above). Split across two halves purely to keep
 * each function's branch count low. */
function textFieldsPatch(
  parsed: XmpMetadataResult,
): Pick<
  OverridePatch,
  'captured_at' | 'time_zone' | 'keywords' | 'title' | 'caption' | 'headline'
> {
  const patch: Pick<
    OverridePatch,
    'captured_at' | 'time_zone' | 'keywords' | 'title' | 'caption' | 'headline'
  > = {};
  if (parsed.dateTimeOriginal !== undefined) patch.captured_at = parsed.dateTimeOriginal;
  if (parsed.timeZone !== undefined) patch.time_zone = parsed.timeZone;
  if (parsed.keywords !== undefined) patch.keywords = parsed.keywords;
  if (parsed.title !== undefined) patch.title = parsed.title;
  if (parsed.caption !== undefined) patch.caption = parsed.caption;
  if (parsed.headline !== undefined) patch.headline = parsed.headline;
  return patch;
}

function rightsFieldsPatch(
  parsed: XmpMetadataResult,
): Pick<
  OverridePatch,
  | 'instructions'
  | 'creator'
  | 'creator_job_title'
  | 'copyright_notice'
  | 'copyright_status'
  | 'usage_terms'
  | 'credit'
  | 'source'
> {
  const patch: Pick<
    OverridePatch,
    | 'instructions'
    | 'creator'
    | 'creator_job_title'
    | 'copyright_notice'
    | 'copyright_status'
    | 'usage_terms'
    | 'credit'
    | 'source'
  > = {};
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

function cullingPatch(
  parsed: XmpMetadataResult,
): Pick<OverridePatch, 'rating' | 'flag' | 'color_label' | 'is_screenshot' | 'hidden'> {
  const patch: Pick<OverridePatch, 'rating' | 'flag' | 'color_label' | 'is_screenshot' | 'hidden'> =
    {};
  if (parsed.rating !== undefined) patch.rating = parsed.rating;
  if (parsed.flag !== undefined) patch.flag = parsed.flag;
  if (parsed.colorLabel !== undefined) patch.color_label = parsed.colorLabel;
  if (parsed.isScreenshot !== undefined) patch.is_screenshot = parsed.isScreenshot;
  if (parsed.hidden !== undefined) patch.hidden = parsed.hidden;
  return patch;
}

/**
 * Map parsed XMP metadata to the `metadata_override` subdoc shape.
 * Returns a partial override (only the fields present in the parsed result).
 * `edited_at` and `touched_fields` are set by the caller.
 */
export function xmpMetadataToOverridePatch(parsed: XmpMetadataResult): OverridePatch {
  return {
    ...gpsPatch(parsed),
    ...placeTextPatch(parsed),
    ...textFieldsPatch(parsed),
    ...rightsFieldsPatch(parsed),
    ...cullingPatch(parsed),
  };
}
