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
 * - The primary rdf:Description is located with the namespace-aware span
 *   parser from `transfer-document.ts`; only its opening tag is edited for
 *   attributes (either quote style), and a self-closing tag is opened before
 *   nested blocks are added (#4684).
 * - For nested elements (lang-alt/seq/bag): remove old managed blocks, then
 *   append new ones inside that rdf:Description.
 * - Namespace declarations are added as needed.
 * - The result is parsed before it is returned, so a malformed merge is
 *   surfaced to the caller instead of being published.
 *
 * This is intentionally NOT byte-identical to the web serializer — that
 * parity is tracked as a separate KTLO ticket. The output is semantically
 * correct and round-trips through `parseXmpMetadata`.
 *
 * Canonical source for the metadata field definitions:
 *   src/web/projects/maple-common/src/lib/xmp/xmp-metadata.ts
 */

import type { XmpMetadataInput } from './metadata-input.ts';
import { adobeLabelColor } from './color-label.ts';
import { parseXmpMetadata } from './metadata-parser.ts';
import { canonicalXmpName, descriptions, xmlSpans, type XmlSpan } from './transfer-document.ts';

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
  rating: ['xmp:Rating'],
  flag: ['papp:Flag'],
  colorLabel: ['papp:ColorLabel'],
  isScreenshot: ['papp:IsScreenshot'],
  hidden: ['papp:Hidden'],
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
  xmp: 'http://ns.adobe.com/xap/1.0/',
};

// ---------------------------------------------------------------------------
// Attribute builder
// ---------------------------------------------------------------------------

const TEXT_ATTRS = [
  ['dateTimeOriginal', 'exif:DateTimeOriginal'],
  ['timeZone', 'papp:TimeZone'],
  ['sublocation', 'Iptc4xmpCore:Location'],
  ['city', 'photoshop:City'],
  ['state', 'photoshop:State'],
  ['country', 'photoshop:Country'],
  ['countryCode', 'Iptc4xmpCore:CountryCode'],
  ['headline', 'photoshop:Headline'],
  ['instructions', 'photoshop:Instructions'],
  ['creatorJobTitle', 'photoshop:AuthorsPosition'],
  ['credit', 'photoshop:Credit'],
  ['source', 'photoshop:Source'],
] as const satisfies readonly (readonly [keyof XmpMetadataInput, string])[];

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
  for (const [field, key] of TEXT_ATTRS) {
    const value = m[field];
    if (value) push(key, value);
  }
  if (m.copyrightStatus === 'copyrighted') push('xmpRights:Marked', 'True');
  else if (m.copyrightStatus === 'public-domain') push('xmpRights:Marked', 'False');
  parts.push(...buildCullingAttrParts(m));
  return parts;
}

function buildCullingAttrParts(m: XmpMetadataInput): string[] {
  const parts: string[] = [];
  const push = (key: string, value: string) => parts.push(`${key}="${escapeAttr(value)}"`);
  // Rating is rounded and must land in the readable 1–5 range — a value
  // outside 0–5 (e.g. from a non-route caller; the batch route already 422s
  // these) is ignored rather than written as an attr the 1–5 parser can't read
  // back. 0 means cleared, so it emits nothing.
  if (m.rating != null) {
    const rounded = Math.round(m.rating);
    if (rounded >= 1 && rounded <= 5) push('xmp:Rating', String(rounded));
  }
  if (m.flag && m.flag !== 'unflagged') push('papp:Flag', m.flag);
  if (m.colorLabel) push('papp:ColorLabel', m.colorLabel);
  if (m.isScreenshot !== undefined && m.isScreenshot !== null) {
    push('papp:IsScreenshot', String(m.isScreenshot));
  }
  if (m.hidden != null) push('papp:Hidden', m.hidden ? 'true' : 'false');
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
  if (m.rating != null && m.rating > 0) used.add('xmp');
  if (
    (m.flag && m.flag !== 'unflagged') ||
    m.colorLabel ||
    (m.isScreenshot !== undefined && m.isScreenshot !== null) ||
    m.hidden != null
  )
    used.add('papp');
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

/**
 * Minimal XMP stub for assets with no pixel-edit model (videos, metadata-only
 * sidecars). Omits Camera Raw Settings attributes so the sidecar is not
 * misinterpreted as containing adjustments by ACR or Lightroom.
 */
const METADATA_ONLY_STUB_XMP = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 7.0">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="">
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

// ---------------------------------------------------------------------------
// Core merge function
// ---------------------------------------------------------------------------

export interface MergeMetadataOptions {
  /**
   * When true, use a metadata-only XMP stub as the base for new sidecars
   * (no Camera Raw Settings attributes). Set for video assets that have no
   * pixel-edit model — omitting CRS attrs prevents ACR/Lightroom from
   * treating the sidecar as containing adjustments.
   *
   * Ignored when `xml` is non-empty (the existing sidecar is preserved as-is).
   */
  metadataOnly?: boolean;
}

/**
 * Merge metadata edits into an existing XMP sidecar string.
 *
 * - Existing adjustment/culling/passthrough content is preserved.
 * - Old managed metadata attribute values are removed from the primary rdf:Description tag.
 * - New managed attribute values are appended to that tag.
 * - Old managed nested element blocks are removed.
 * - New managed nested element blocks are injected inside the primary rdf:Description;
 *   a self-closing `<rdf:Description …/>` is opened first so they have somewhere to live.
 * - Required namespace declarations are added to the rdf:Description tag.
 *
 * Throws when the existing sidecar is not well-formed XML, has no rdf:Description,
 * or the merged result would not parse — such a result must never be published.
 */
export function mergeMetadataIntoXmp(
  xml: string,
  meta: XmpMetadataInput,
  opts: MergeMetadataOptions = {},
): string {
  const stub = opts.metadataOnly ? METADATA_ONLY_STUB_XMP : STUB_XMP;
  const base = xml.trim().length > 0 ? xml : stub;
  const merged = applyMerge(base, meta);
  xmlSpans(merged);
  return merged;
}

/** Managed keys owned by the fields present in `meta` (by key, so an explicit `null` clear counts). */
function touchedKeys(
  registry: Record<string, readonly string[] | string>,
  meta: XmpMetadataInput,
): Set<string> {
  return new Set(
    Object.entries(registry)
      .filter(([field]) => field in meta)
      .flatMap(([, keys]) => (typeof keys === 'string' ? [keys] : [...keys])),
  );
}

function removeTouchedBlocks(xml: string, tags: Set<string>): string {
  return [...tags].reduce(
    (text, tag) =>
      text.replace(
        new RegExp(`\\s*<${escapeRegex(tag)}[\\s>][\\s\\S]*?<\\/${escapeRegex(tag)}>`, 'g'),
        '',
      ),
    xml,
  );
}

function stripTouchedAttrs(openingTag: string, keys: Set<string>): string {
  return [...keys].reduce(
    (tag, key) =>
      tag.replace(new RegExp(`\\s+${escapeRegex(key)}\\s*=\\s*(?:"[^"]*"|'[^']*')`, 'g'), ''),
    openingTag,
  );
}

function appendToOpeningTag(openingTag: string, additions: string[]): string {
  if (additions.length === 0) return openingTag;
  return openingTag.replace(
    /\s*(\/?>)$/,
    (_ending, close: string) => `\n   ${additions.join('\n   ')}${close}`,
  );
}

function applyMerge(xml: string, meta: XmpMetadataInput): string {
  const touchedAttrKeys = contradictsAuthoredAdobeLabel(xml, meta)
    ? new Set([...touchedKeys(FIELD_TO_ATTR_KEYS, meta), 'xmp:Label'])
    : touchedKeys(FIELD_TO_ATTR_KEYS, meta);
  const base = removeTouchedBlocks(xml, touchedKeys(FIELD_TO_NESTED_TAG, meta));

  const primary = primaryDescription(base);
  const nsDecls = [...requiredNamespacePrefixes(meta)]
    .filter((prefix) => NS_MAP[prefix] !== undefined && primary.namespaces[prefix] === undefined)
    .map((prefix) => `xmlns:${prefix}="${NS_MAP[prefix]}"`);
  const openingTag = appendToOpeningTag(
    stripTouchedAttrs(base.slice(primary.start, primary.openEnd), touchedAttrKeys),
    [...nsDecls, ...buildMetadataAttrParts(meta)],
  );

  const newBlocks = buildMetadataNestedBlocks(meta);
  const before = base.slice(0, primary.start);
  if (newBlocks.length === 0) return before + openingTag + base.slice(primary.openEnd);
  const blocks = newBlocks.join('\n');
  return primary.tag.isSelfClosing
    ? `${before}${openingTag.replace(/\/>$/, '>')}\n${blocks}\n</${primary.tag.name}>${base.slice(primary.openEnd)}`
    : `${before}${openingTag}${base.slice(primary.openEnd, primary.closeStart)}${blocks}\n${base.slice(primary.closeStart)}`;
}

/** The `rdf:about=""` description, else the first — the same choice `applyTransferPatch` makes. */
function primaryDescription(xml: string): XmlSpan {
  const all = descriptions(xmlSpans(xml));
  const about = (span: XmlSpan): string =>
    Object.values(span.tag.attributes).find((a) => canonicalXmpName(a.uri, a.local) === 'rdf:about')
      ?.value ?? '';
  const primary = all.find((span) => about(span) === '') ?? all[0];
  if (!primary) throw new Error('XMP has no rdf:Description to merge metadata into');
  return primary;
}

/**
 * `xmp:Label` belongs to the author (#4403, docs/xmp-canonical-format.md § Culling fields):
 * it is dropped only when this edit changes the colour label and the authored word is one
 * of Adobe's six colours, which would otherwise contradict the new `papp:ColorLabel`.
 */
function contradictsAuthoredAdobeLabel(xml: string, meta: XmpMetadataInput): boolean {
  if (!('colorLabel' in meta)) return false;
  const authoredWord = /\sxmp:Label=(["'])(.*?)\1/.exec(xml)?.[2];
  if (authoredWord === undefined || adobeLabelColor(authoredWord) === undefined) return false;
  return (meta.colorLabel || null) !== (parseXmpMetadata(xml).colorLabel ?? null);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
