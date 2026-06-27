/**
 * Server-side XMP metadata serializer (#1580 — Batch Metadata M1).
 *
 * Merges a set of metadata field edits into an existing XMP sidecar string
 * (or creates a stub sidecar when none exists). Preserves all existing
 * content (adjustment fields, passthrough attributes/elements, culling) —
 * only the managed metadata attributes and nested elements are replaced.
 *
 * Design:
 * - Re-use the encode helpers from `xmp-metadata.ts` (web layer) verbatim.
 *   They are pure functions with no browser/Angular deps so they import fine
 *   in Bun.
 * - For the attribute-injection path: replace managed attribute key=value
 *   pairs in the rdf:Description opening tag via regex substitution, then
 *   append new ones.
 * - For nested elements (lang-alt/seq/bag): remove old managed blocks, then
 *   append new ones inside rdf:Description.
 * - Namespace declarations are added as needed.
 *
 * This is intentionally NOT byte-identical to the web serializer — that
 * parity is tracked as a separate KTLO ticket. The output is semantically
 * correct and round-trips through `parseXmpMetadata`.
 *
 * Canonical source for the metadata field definitions:
 *   src/web/projects/maple-common/src/lib/xmp/xmp-metadata.ts
 */

import type { XmpMetadataInput } from './metadata-input.ts';

// ---------------------------------------------------------------------------
// Encode helpers (copied from xmp-metadata.ts — pure math, no browser deps)
// ---------------------------------------------------------------------------

type GpsAxis = 'lat' | 'lon';

function gpsToXmp(value: number, axis: GpsAxis): string {
  const abs = Math.abs(value);
  const roundedMinutes = Math.round(abs * 60 * 1e4) / 1e4;
  const deg = Math.floor(roundedMinutes / 60);
  const min = roundedMinutes - deg * 60;
  const positive = roundedMinutes === 0 ? true : value >= 0;
  const hemi = axis === 'lat' ? (positive ? 'N' : 'S') : positive ? 'E' : 'W';
  return `${deg},${min.toFixed(4)}${hemi}`;
}

function altitudeToXmp(meters: number): { value: string; ref: '0' | '1' } {
  const ref: '0' | '1' = meters < 0 ? '1' : '0';
  const thousandths = Math.round(Math.abs(meters) * 1000);
  return { value: `${thousandths}/1000`, ref };
}

function escapeAttr(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function escapeText(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Build lang-alt nested element block. */
function langAltBlock(qname: string, text: string): string {
  return [
    `  <${qname}>`,
    '   <rdf:Alt>',
    `    <rdf:li xml:lang="x-default">${escapeText(text)}</rdf:li>`,
    '   </rdf:Alt>',
    `  </${qname}>`,
  ].join('\n');
}

/** Build rdf:Seq nested element for a single-value field (e.g. dc:creator). */
function seqBlock(qname: string, text: string): string {
  return [
    `  <${qname}>`,
    '   <rdf:Seq>',
    `    <rdf:li>${escapeText(text)}</rdf:li>`,
    '   </rdf:Seq>',
    `  </${qname}>`,
  ].join('\n');
}

/** Build rdf:Bag nested element for a multi-value field (e.g. dc:subject). */
function bagBlock(qname: string, values: string[]): string {
  const lis = values.map((v) => `    <rdf:li>${escapeText(v)}</rdf:li>`).join('\n');
  return [`  <${qname}>`, '   <rdf:Bag>', lis, '   </rdf:Bag>', `  </${qname}>`].join('\n');
}

// ---------------------------------------------------------------------------
// Managed field registry
// ---------------------------------------------------------------------------

/**
 * Map each input field to the managed attribute key(s) it owns. ONLY keys for
 * fields present in the edit are removed/rewritten, so untouched fields in an
 * existing sidecar survive a partial edit (spec: untouched fields unchanged).
 */
// `satisfies` enforces every key is a real XmpMetadataInput field, so a rename
// or typo can't silently drop a field from the touched-set and reintroduce the
// partial-edit data-loss bug.
const FIELD_TO_ATTR_KEYS = {
  gpsLatitude: ['exif:GPSLatitude'],
  gpsLongitude: ['exif:GPSLongitude'],
  gpsAltitude: ['exif:GPSAltitude', 'exif:GPSAltitudeRef'],
  dateTimeOriginal: ['exif:DateTimeOriginal'],
  timeZone: ['papp:TimeZone'],
  sublocation: ['Iptc4xmpCore:Location'],
  city: ['photoshop:City'],
  state: ['photoshop:State'],
  country: ['photoshop:Country'],
  countryCode: ['Iptc4xmpCore:CountryCode'],
  headline: ['photoshop:Headline'],
  instructions: ['photoshop:Instructions'],
  creatorJobTitle: ['photoshop:AuthorsPosition'],
  credit: ['photoshop:Credit'],
  source: ['photoshop:Source'],
  copyrightStatus: ['xmpRights:Marked'],
} satisfies Partial<Record<keyof XmpMetadataInput, readonly string[]>>;

/** Map each input field to the managed nested element tag it owns. */
const FIELD_TO_NESTED_TAG = {
  title: 'dc:title',
  creator: 'dc:creator',
  caption: 'dc:description',
  copyrightNotice: 'dc:rights',
  usageTerms: 'xmpRights:UsageTerms',
  keywords: 'dc:subject',
} satisfies Partial<Record<keyof XmpMetadataInput, string>>;

/** Namespace prefix → URI (only prefixes used by managed metadata fields). */
const NS_MAP: Record<string, string> = {
  exif: 'http://ns.adobe.com/exif/1.0/',
  photoshop: 'http://ns.adobe.com/photoshop/1.0/',
  Iptc4xmpCore: 'http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/',
  xmpRights: 'http://ns.adobe.com/xap/1.0/rights/',
  dc: 'http://purl.org/dc/elements/1.1/',
  // Align to the web serializer's papp URI (M0a) so sidecars this route writes
  // match what the web layer writes; the Swift/Rust variant is tracked in #1577.
  papp: 'http://ns.justmaple.app/photo/1.0/',
};

// ---------------------------------------------------------------------------
// Attribute builder
// ---------------------------------------------------------------------------

function buildMetadataAttrParts(m: XmpMetadataInput): string[] {
  const parts: string[] = [];
  const push = (key: string, value: string) => parts.push(`${key}="${escapeAttr(value)}"`);

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
  if (m.copyrightStatus === 'copyrighted') push('xmpRights:Marked', 'True');
  else if (m.copyrightStatus === 'public-domain') push('xmpRights:Marked', 'False');
  return parts;
}

function buildMetadataNestedBlocks(m: XmpMetadataInput): string[] {
  const blocks: string[] = [];
  if (m.title) blocks.push(langAltBlock('dc:title', m.title));
  if (m.creator) blocks.push(seqBlock('dc:creator', m.creator));
  if (m.caption) blocks.push(langAltBlock('dc:description', m.caption));
  if (m.copyrightNotice) blocks.push(langAltBlock('dc:rights', m.copyrightNotice));
  if (m.usageTerms) blocks.push(langAltBlock('xmpRights:UsageTerms', m.usageTerms));
  if (m.keywords && m.keywords.length > 0) blocks.push(bagBlock('dc:subject', m.keywords));
  return blocks;
}

function requiredNamespacePrefixes(m: XmpMetadataInput): Set<string> {
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
  if (m.keywords && m.keywords.length > 0) used.add('dc');
  if (m.timeZone) used.add('papp');
  return used;
}

// ---------------------------------------------------------------------------
// Stub sidecar (for assets with no existing sidecar)
// ---------------------------------------------------------------------------

const STUB_XMP = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 7.0">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
   xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   crs:Version="11.0"
   crs:ProcessVersion="11.0"
   crs:HasSettings="True">
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

// ---------------------------------------------------------------------------
// Core merge function
// ---------------------------------------------------------------------------

/**
 * Merge metadata edits into an existing XMP sidecar string.
 *
 * - Existing adjustment/culling/passthrough content is preserved.
 * - Old managed metadata attribute values are removed from the rdf:Description tag.
 * - New managed attribute values are appended to the rdf:Description tag.
 * - Old managed nested element blocks are removed.
 * - New managed nested element blocks are injected inside rdf:Description.
 * - Required namespace declarations are added to the rdf:Description tag.
 *
 * Returns the modified XMP string. Never throws on malformed XML — falls
 * back to returning the original unchanged string.
 */
export function mergeMetadataIntoXmp(xml: string, meta: XmpMetadataInput): string {
  const base = xml.trim().length > 0 ? xml : STUB_XMP;

  try {
    return applyMerge(base, meta);
  } catch {
    // Defensive: if anything goes wrong, return the base unchanged.
    return base;
  }
}

function applyMerge(xml: string, meta: XmpMetadataInput): string {
  // Determine which managed keys/tags this edit TOUCHES — only fields present
  // in the input (by key, so an explicit `null` clear counts; an omitted field
  // does not). Untouched fields in the existing sidecar are left intact.
  const touchedAttrKeys = new Set<string>();
  const touchedTags = new Set<string>();
  for (const [field, keys] of Object.entries(FIELD_TO_ATTR_KEYS)) {
    if (field in meta) for (const k of keys) touchedAttrKeys.add(k);
  }
  for (const [field, tag] of Object.entries(FIELD_TO_NESTED_TAG)) {
    if (field in meta) touchedTags.add(tag);
  }

  // 1. Remove ONLY the touched managed attribute keys from rdf:Description.
  let result = xml;
  for (const key of touchedAttrKeys) {
    // Match: whitespace? key="value" (with possible entity sequences in value)
    const re = new RegExp(`\\s*${escapeRegex(key)}="[^"]*"`, 'g');
    result = result.replace(re, '');
  }

  // 2. Remove ONLY the touched managed nested element blocks.
  for (const tag of touchedTags) {
    // Match the full element including its content, across lines.
    const re = new RegExp(`\\s*<${escapeRegex(tag)}[\\s\\S]*?<\\/${escapeRegex(tag)}>`, 'g');
    result = result.replace(re, '');
  }

  // 3. Build new attribute parts.
  const newAttrs = buildMetadataAttrParts(meta);

  // 4. Build new nested blocks.
  const newBlocks = buildMetadataNestedBlocks(meta);

  // 5. Inject new namespace declarations (only those not already present).
  const neededPrefixes = requiredNamespacePrefixes(meta);
  const nsDecls: string[] = [];
  for (const prefix of neededPrefixes) {
    const uri = NS_MAP[prefix];
    if (uri && !result.includes(`xmlns:${prefix}=`)) {
      nsDecls.push(`xmlns:${prefix}="${uri}"`);
    }
  }

  // 6. Inject namespace declarations + new attributes into the rdf:Description opening tag.
  // Strategy: find the closing `>` (or `/>`) of the rdf:Description tag and inject before it.
  if (newAttrs.length > 0 || nsDecls.length > 0) {
    // The opening tag may end with `>` (has children) or `/>` (self-closing).
    // We want the first `>` after `<rdf:Description`.
    const descTagEnd = findDescriptionTagEnd(result);
    if (descTagEnd !== -1) {
      const insertPoint = descTagEnd;
      const toInsert =
        (nsDecls.length > 0 ? '\n   ' + nsDecls.join('\n   ') : '') +
        (newAttrs.length > 0 ? '\n   ' + newAttrs.join('\n   ') : '');
      result = result.slice(0, insertPoint) + toInsert + result.slice(insertPoint);
    }
  }

  // 7. Inject nested blocks inside rdf:Description, before its closing tag.
  if (newBlocks.length > 0) {
    const closingTag = '</rdf:Description>';
    const idx = result.lastIndexOf(closingTag);
    if (idx !== -1) {
      const insertion = '\n' + newBlocks.join('\n') + '\n';
      result = result.slice(0, idx) + insertion + result.slice(idx);
    }
  }

  return result;
}

/** Find the position of the closing `>` of the `<rdf:Description …>` opening tag. */
function findDescriptionTagEnd(xml: string): number {
  const startIdx = xml.indexOf('<rdf:Description');
  if (startIdx === -1) return -1;

  // Scan forward from startIdx for the first unquoted `>`.
  let inQuote = false;
  let quoteChar = '';
  for (let i = startIdx + 1; i < xml.length; i++) {
    const ch = xml[i];
    if (inQuote) {
      if (ch === quoteChar) inQuote = false;
    } else if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
