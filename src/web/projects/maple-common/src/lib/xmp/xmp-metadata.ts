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
 */
export function gpsToXmp(value: number, axis: GpsAxis): string {
  const positive = value >= 0;
  const abs = Math.abs(value);
  const deg = Math.floor(abs);
  const min = (abs - deg) * 60;
  const hemi = axis === 'lat' ? (positive ? 'N' : 'S') : positive ? 'E' : 'W';
  return `${deg},${min.toFixed(4)}${hemi}`;
}

/**
 * Decode an `exif:GPSLatitude/Longitude` string back to signed decimal
 * degrees. Accepts the canonical `DDD,MM.mmmm{N|S|E|W}` form. Returns `null`
 * if the string does not match (so a hand-edited sidecar never throws).
 */
export function gpsFromXmp(s: string): number | null {
  const m = /^(\d+),(\d+(?:\.\d+)?)([NSEW])$/.exec(s.trim());
  if (!m) return null;
  const deg = Number(m[1]);
  const min = Number(m[2]);
  const sign = m[3] === 'S' || m[3] === 'W' ? -1 : 1;
  return sign * (deg + min / 60);
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
