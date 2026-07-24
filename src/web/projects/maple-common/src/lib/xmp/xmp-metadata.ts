// xmp-metadata.ts — standard-XMP encodings + field tables for the IPTC/EXIF
// metadata block (Batch Metadata, spec 2026-06-26). Kept separate from the
// adjustment/culling field tables so the serializer/parser stay focused.

import type { XmpMetadata, CopyrightStatus } from './xmp.types';

/** Axis selector for GPS encoding (picks the N/S vs E/W hemisphere suffix). */
export type GpsAxis = 'lat' | 'lon';

/**
 * Encode a signed decimal degree to the Adobe XMP `exif:GPSLatitude/Longitude`
 * form: `DDD,MM.mmmm{N|S|E|W}` (degrees, decimal-minutes, hemisphere). Minutes
 * are formatted to 4 decimal places — Lightroom's precision (~2cm).
 *
 * Round-trip-stable by construction: minutes are rounded to 4dp *first* so a
 * value within rounding distance of a degree boundary carries into the degrees
 * (never emits the invalid `89,60.0000`), and a magnitude that rounds to zero
 * always takes the positive hemisphere so `+0`/`-0` can't flip N/S↔E/W.
 */
export function gpsToXmp(value: number, axis: GpsAxis): string {
  const abs = Math.abs(value);
  const roundedMinutes = Math.round(abs * 60 * 1e4) / 1e4;
  const deg = Math.floor(roundedMinutes / 60);
  const min = roundedMinutes - deg * 60;
  const positive = roundedMinutes === 0 ? true : value >= 0;
  const hemi = axis === 'lat' ? (positive ? 'N' : 'S') : positive ? 'E' : 'W';
  return `${deg},${min.toFixed(4)}${hemi}`;
}

/**
 * Decode an `exif:GPSLatitude/Longitude` string back to signed decimal
 * degrees. Accepts the canonical `DDD,MM.mmmm{N|S|E|W}` form. Returns `null`
 * if the string does not match (so a hand-edited sidecar never throws).
 * Normalises `-0` to `0` so a zero-magnitude coordinate can't flip hemisphere
 * on the next encode.
 */
export function gpsFromXmp(s: string): number | null {
  const m = /^(\d+),(\d+(?:\.\d+)?)([NSEW])$/.exec(s.trim());
  if (!m) return null;
  const deg = Number(m[1]);
  const min = Number(m[2]);
  const sign = m[3] === 'S' || m[3] === 'W' ? -1 : 1;
  const result = sign * (deg + min / 60);
  return result === 0 ? 0 : result;
}

/** `exif:GPSAltitude` rational + `exif:GPSAltitudeRef` (0 = above, 1 = below). */
export interface XmpAltitude {
  value: string;
  ref: '0' | '1';
}

/** Encode signed meters as a `/1000` rational + altitude-ref flag. */
export function altitudeToXmp(meters: number): XmpAltitude {
  const ref: '0' | '1' = meters < 0 ? '1' : '0';
  const thousandths = Math.round(Math.abs(meters) * 1000);
  return { value: `${thousandths}/1000`, ref };
}

/** Decode an altitude rational + ref back to signed meters; `null` if malformed. */
export function altitudeFromXmp(value: string, ref: string): number | null {
  const m = /^(\d+)\/(\d+)$/.exec(value.trim());
  if (!m) return null;
  const denom = Number(m[2]);
  if (denom === 0) return null;
  const meters = Number(m[1]) / denom;
  return ref === '1' ? -meters : meters;
}

/** Minimal XML text-content escaping (matches the serializer's `_escapeText`). */
export function escapeXmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Build a lang-alt nested element:
 *   <prefix:Name><rdf:Alt><rdf:li xml:lang="x-default">text</rdf:li></rdf:Alt></prefix:Name>
 * Indentation mirrors the existing `dc:subject` block (2/3/4 spaces).
 */
export function langAltBlock(qname: string, text: string): string {
  return [
    `  <${qname}>`,
    '   <rdf:Alt>',
    `    <rdf:li xml:lang="x-default">${escapeXmlText(text)}</rdf:li>`,
    '   </rdf:Alt>',
    `  </${qname}>`,
  ].join('\n');
}

/** Build an rdf:Seq nested element holding a single entry (v1 single-creator). */
export function seqBlock(qname: string, text: string): string {
  return [
    `  <${qname}>`,
    '   <rdf:Seq>',
    `    <rdf:li>${escapeXmlText(text)}</rdf:li>`,
    '   </rdf:Seq>',
    `  </${qname}>`,
  ].join('\n');
}

/** Namespace declarations keyed by prefix (only emitted when used). */
export const METADATA_NAMESPACES: Record<string, string> = {
  dc: 'http://purl.org/dc/elements/1.1/',
  exif: 'http://ns.adobe.com/exif/1.0/',
  photoshop: 'http://ns.adobe.com/photoshop/1.0/',
  Iptc4xmpCore: 'http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/',
  xmpRights: 'http://ns.adobe.com/xap/1.0/rights/',
};

/** Attribute-content escaping (matches the serializer's `_escapeAttr`). */
function escapeXmlAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const COPYRIGHT_TO_MARKED: Record<CopyrightStatus, string | null> = {
  unknown: null,
  copyrighted: 'True',
  'public-domain': 'False',
};

/**
 * Build the ordered list of simple-attribute parts for the metadata block
 * (the nested lang-alt/seq elements are handled separately in the serializer).
 * Order is fixed for per-platform byte-stability.
 */
export function metadataAttrParts(m: XmpMetadata): string[] {
  const parts: string[] = [];
  const push = (key: string, value: string) => parts.push(`${key}="${escapeXmlAttr(value)}"`);

  if (m.gpsLatitude != null) push('exif:GPSLatitude', gpsToXmp(m.gpsLatitude, 'lat'));
  if (m.gpsLongitude != null) push('exif:GPSLongitude', gpsToXmp(m.gpsLongitude, 'lon'));
  if (m.gpsAltitude != null) {
    const alt = altitudeToXmp(m.gpsAltitude);
    push('exif:GPSAltitude', alt.value);
    push('exif:GPSAltitudeRef', alt.ref);
  }
  if (m.dateTimeOriginal) push('exif:DateTimeOriginal', m.dateTimeOriginal);
  if (m.timeZone) push('papp:TimeZone', m.timeZone);
  if (m.sublocation) push('Iptc4xmpCore:Location', m.sublocation);
  if (m.city) push('photoshop:City', m.city);
  if (m.state) push('photoshop:State', m.state);
  if (m.country) push('photoshop:Country', m.country);
  if (m.countryCode) push('Iptc4xmpCore:CountryCode', m.countryCode);
  if (m.headline) push('photoshop:Headline', m.headline);
  if (m.instructions) push('photoshop:Instructions', m.instructions);
  if (m.creatorJobTitle) push('photoshop:AuthorsPosition', m.creatorJobTitle);
  if (m.credit) push('photoshop:Credit', m.credit);
  if (m.source) push('photoshop:Source', m.source);
  if (m.copyrightStatus) {
    const marked = COPYRIGHT_TO_MARKED[m.copyrightStatus];
    if (marked !== null) push('xmpRights:Marked', marked);
  }
  return parts;
}

/**
 * Build the nested lang-alt/seq element blocks for the metadata, in fixed
 * order (dc:title, dc:creator, dc:description, dc:rights, xmpRights:UsageTerms).
 * The `dc:subject` keyword bag is NOT here — it stays in the serializer's
 * culling path.
 */
export function metadataNestedBlocks(m: XmpMetadata): string[] {
  const blocks: string[] = [];
  if (m.title) blocks.push(langAltBlock('dc:title', m.title));
  if (m.creator) blocks.push(seqBlock('dc:creator', m.creator));
  if (m.caption) blocks.push(langAltBlock('dc:description', m.caption));
  if (m.copyrightNotice) blocks.push(langAltBlock('dc:rights', m.copyrightNotice));
  if (m.usageTerms) blocks.push(langAltBlock('xmpRights:UsageTerms', m.usageTerms));
  return blocks;
}

/**
 * Which namespace prefixes the metadata requires declared on rdf:Description.
 * Mirrors exactly what `metadataAttrParts` + `metadataNestedBlocks` emit.
 */
export function metadataNamespacePrefixes(m: XmpMetadata): Set<string> {
  const used = new Set<string>();
  if (
    m.gpsLatitude != null ||
    m.gpsLongitude != null ||
    m.gpsAltitude != null ||
    m.dateTimeOriginal
  )
    used.add('exif');
  if (
    m.city ||
    m.state ||
    m.country ||
    m.headline ||
    m.instructions ||
    m.creatorJobTitle ||
    m.credit ||
    m.source
  )
    used.add('photoshop');
  if (m.sublocation || m.countryCode) used.add('Iptc4xmpCore');
  if (m.title || m.creator || m.caption || m.copyrightNotice) used.add('dc');
  if (m.usageTerms) used.add('xmpRights');
  if (m.copyrightStatus && m.copyrightStatus !== 'unknown') used.add('xmpRights');
  return used;
}

const MARKED_TO_COPYRIGHT: Record<string, CopyrightStatus> = {
  True: 'copyrighted',
  False: 'public-domain',
};

/** Map `xmpRights:Marked` text to the tri-state; `null` for absent/unknown. */
export function copyrightStatusFromMarked(marked: string | null): CopyrightStatus | null {
  if (marked === null) return null;
  return MARKED_TO_COPYRIGHT[marked] ?? null;
}

/**
 * Parse the IPTC/EXIF metadata block from an already-located
 * `rdf:Description` element. Split out of `XmpParserService.parseMetadata`
 * (#2215) to keep the service under the file-size budget — this half is
 * pure (element in, `XmpMetadata` out) and lives alongside the metadata
 * write-side helpers above so the parse/serialize pair for this block stay
 * next to each other. Returns only the fields present; absent fields are
 * left undefined.
 */
export function parseMetadataBlock(desc: Element): XmpMetadata {
  const result: XmpMetadata = {};
  const attr = (names: string[]): string | null => {
    for (const name of names) {
      const val = desc.getAttribute(name);
      if (val !== null) return val;
    }
    return null;
  };

  // GPS
  const lat = attr(['exif:GPSLatitude']);
  if (lat !== null) {
    const v = gpsFromXmp(lat);
    if (v !== null) result.gpsLatitude = v;
  }
  const lon = attr(['exif:GPSLongitude']);
  if (lon !== null) {
    const v = gpsFromXmp(lon);
    if (v !== null) result.gpsLongitude = v;
  }
  const alt = attr(['exif:GPSAltitude']);
  if (alt !== null) {
    const v = altitudeFromXmp(alt, attr(['exif:GPSAltitudeRef']) ?? '0');
    if (v !== null) result.gpsAltitude = v;
  }

  // Simple string attributes. Empty / whitespace-only values read back as
  // `undefined` (not `""`) so parse matches the "absent field" contract and
  // the serializer's clear-semantics (empty = omitted), and stays consistent
  // with the nested lang-alt/seq text path below.
  const str = (keys: string[]): string | undefined => {
    const v = attr(keys);
    if (v === null) return undefined;
    const trimmed = v.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };
  result.dateTimeOriginal = str(['exif:DateTimeOriginal']);
  result.timeZone = str(['papp:TimeZone']);
  result.sublocation = str(['Iptc4xmpCore:Location']);
  result.city = str(['photoshop:City']);
  result.state = str(['photoshop:State']);
  result.country = str(['photoshop:Country']);
  result.countryCode = str(['Iptc4xmpCore:CountryCode']);
  result.headline = str(['photoshop:Headline']);
  result.instructions = str(['photoshop:Instructions']);
  result.creatorJobTitle = str(['photoshop:AuthorsPosition']);
  result.credit = str(['photoshop:Credit']);
  result.source = str(['photoshop:Source']);

  const status = copyrightStatusFromMarked(attr(['xmpRights:Marked']));
  if (status !== null) result.copyrightStatus = status;

  // Nested lang-alt / seq elements → first rdf:li text content.
  const DC = 'http://purl.org/dc/elements/1.1/';
  result.title = nestedText(desc, DC, 'title', 'dc:title');
  result.caption = nestedText(desc, DC, 'description', 'dc:description');
  result.creator = nestedText(desc, DC, 'creator', 'dc:creator');
  result.copyrightNotice = nestedText(desc, DC, 'rights', 'dc:rights');
  result.usageTerms = nestedText(
    desc,
    'http://ns.adobe.com/xap/1.0/rights/',
    'UsageTerms',
    'xmpRights:UsageTerms',
  );

  // Strip undefined keys so an empty edit yields {} (byte-stable round-trip).
  for (const k of Object.keys(result) as (keyof XmpMetadata)[]) {
    if (result[k] === undefined) delete result[k];
  }
  return result;
}

/** First `rdf:li` text content of a nested lang-alt/seq element, or undefined. */
function nestedText(desc: Element, ns: string, local: string, qname: string): string | undefined {
  const elsNS = desc.getElementsByTagNameNS(ns, local);
  const el = elsNS.length > 0 ? elsNS[0] : desc.getElementsByTagName(qname)[0];
  if (!el) return undefined;
  const liNS = el.getElementsByTagNameNS('http://www.w3.org/1999/02/22-rdf-syntax-ns#', 'li');
  const li = liNS.length > 0 ? liNS[0] : el.getElementsByTagName('rdf:li')[0];
  const text = (li?.textContent ?? '').trim();
  return text.length > 0 ? text : undefined;
}

/**
 * The managed metadata attribute keys (for KNOWN_ATTRIBUTES extension) and the
 * managed nested element local-names (for passthrough exclusion).
 */
export const METADATA_ATTR_KEYS: readonly string[] = [
  'exif:GPSLatitude',
  'exif:GPSLongitude',
  'exif:GPSAltitude',
  'exif:GPSAltitudeRef',
  'exif:DateTimeOriginal',
  'papp:TimeZone',
  'Iptc4xmpCore:Location',
  'photoshop:City',
  'photoshop:State',
  'photoshop:Country',
  'Iptc4xmpCore:CountryCode',
  'photoshop:Headline',
  'photoshop:Instructions',
  'photoshop:AuthorsPosition',
  'photoshop:Credit',
  'photoshop:Source',
  'xmpRights:Marked',
];

/** Managed nested elements `{ ns, local, tag }` — excluded from passthrough. */
export const METADATA_NESTED_ELEMENTS: ReadonlyArray<{ ns: string; local: string; tag: string }> = [
  { ns: METADATA_NAMESPACES['dc'], local: 'title', tag: 'dc:title' },
  { ns: METADATA_NAMESPACES['dc'], local: 'creator', tag: 'dc:creator' },
  { ns: METADATA_NAMESPACES['dc'], local: 'description', tag: 'dc:description' },
  { ns: METADATA_NAMESPACES['dc'], local: 'rights', tag: 'dc:rights' },
  { ns: METADATA_NAMESPACES['xmpRights'], local: 'UsageTerms', tag: 'xmpRights:UsageTerms' },
];
