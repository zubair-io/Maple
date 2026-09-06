import {
  ADJUSTMENT_TRANSFER_MODES,
  TRANSFER_XMP_ATTRIBUTES,
  TRANSFER_XMP_ELEMENTS,
} from '../generated/adjustment-transfer.generated.ts';
import {
  canonicalXmpName,
  descriptions,
  EMPTY_TRANSFER_XMP,
  patchedOpeningTag,
  xmlSpans,
  type XmlSpan,
} from './transfer-document.ts';

export interface XmpTransferPatch {
  attributes: Record<string, string | null>;
  elements: Record<string, string | null>;
}

const ALLOWED_ATTRIBUTES = new Set(
  Object.entries(TRANSFER_XMP_ATTRIBUTES)
    .filter(([field]) => ADJUSTMENT_TRANSFER_MODES[field] !== 'Unsupported')
    .flatMap(([, names]) => names)
    .concat('crs:WhiteBalance'),
);
const PROVENANCE_RESET = new Set(['papp:WbSampleX', 'papp:WbSampleY', 'papp:WbAlgorithmVersion']);
const ALLOWED_ELEMENTS = new Set(Object.values(TRANSFER_XMP_ELEMENTS));

function record(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Expected a patch object');
  return raw as Record<string, unknown>;
}

function allowedField(key: string, value: unknown, elements: boolean): boolean {
  if (elements) return ALLOWED_ELEMENTS.has(key);
  return ALLOWED_ATTRIBUTES.has(key) || (PROVENANCE_RESET.has(key) && value === null);
}

function parseEntries(raw: unknown, elements: boolean): Record<string, string | null> {
  const entries = Object.entries(record(raw));
  if (entries.length > (elements ? 8 : 160)) throw new Error('Too many transfer fields');
  return Object.fromEntries(
    entries.map(([key, value]) => {
      const allowed = allowedField(key, value, elements);
      if (!allowed) throw new Error(`Field cannot be transferred: ${key}`);
      if (
        value !== null &&
        (typeof value !== 'string' || value.length > (elements ? 16384 : 256))
      ) {
        throw new Error(`Invalid transfer value for ${key}`);
      }
      if (elements && typeof value === 'string') validateCurve(value, key);
      return [key, value];
    }),
  );
}

function validateCurve(value: string, key: string): void {
  const roots = xmlSpans(value);
  if (roots.length !== 1 || canonicalXmpName(roots[0].tag.uri, roots[0].tag.local) !== key)
    throw new Error(`Curve XML does not match ${key}`);
}

export function parseTransferPatch(raw: unknown): XmpTransferPatch {
  const input = record(raw);
  const patch = {
    attributes: parseEntries(input['attributes'], false),
    elements: parseEntries(input['elements'], true),
  };
  if (Object.keys(patch.attributes).length + Object.keys(patch.elements).length === 0)
    throw new Error('Empty transfer patch');
  return patch;
}

interface XmlEdit {
  start: number;
  end: number;
  value: string;
}

function replaceCurveNodes(
  span: XmlSpan,
  primary: XmlSpan,
  patch: XmpTransferPatch,
  pendingElements: Map<string, string | null>,
  edits: XmlEdit[],
): void {
  for (const child of span.children) {
    const name = canonicalXmpName(child.tag.uri, child.tag.local);
    if (!name || !Object.hasOwn(patch.elements, name)) continue;
    // Replace the first primary node in place. This keeps repeat application
    // byte-idempotent and removes duplicates without accumulating whitespace.
    const replacement = span === primary ? (pendingElements.get(name) ?? '') : '';
    edits.push({ start: child.start, end: child.end, value: replacement });
    if (span === primary) pendingElements.delete(name);
  }
}

/** All other fields, nested masks, comments, and sibling RDF resources survive byte-for-byte. */
export function applyTransferPatch(existing: string, patch: XmpTransferPatch): string {
  const xml = existing.length === 0 ? EMPTY_TRANSFER_XMP : existing;
  const allDescriptions = descriptions(xmlSpans(xml));
  if (allDescriptions.length === 0) throw new Error('XMP has no RDF description');
  const about = (span: (typeof allDescriptions)[number]) =>
    Object.values(span.tag.attributes).find((a) => canonicalXmpName(a.uri, a.local) === 'rdf:about')
      ?.value ?? '';
  const primary = allDescriptions.find((span) => about(span) === '') ?? allDescriptions[0];
  const subject = about(primary);
  const targets = allDescriptions.filter((span) => about(span) === subject);
  const pendingElements = new Map(Object.entries(patch.elements));
  const edits: XmlEdit[] = [];
  for (const span of targets) {
    // A sidecar explicitly marked unedited must become authored when settings
    // are pasted, just as the full-document writers always emit HasSettings=True.
    const opening = patchedOpeningTag(
      xml,
      span,
      { ...patch.attributes, 'crs:HasSettings': 'True' },
      span === primary,
    );
    replaceCurveNodes(span, primary, patch, pendingElements, edits);
    edits.push({ start: span.start, end: span.openEnd, value: opening });
  }
  const elements = [...pendingElements.values()]
    .filter((value): value is string => value !== null)
    .join('\n');
  if (elements.length > 0) {
    if (primary.tag.isSelfClosing) {
      const opening = edits.find((edit) => edit.start === primary.start)!;
      opening.value = opening.value.replace(/\/>$/, `>\n${elements}\n</${primary.tag.name}>`);
    } else
      edits.push({ start: primary.closeStart, end: primary.closeStart, value: `${elements}\n` });
  }
  const result = edits
    .sort((a, b) => b.start - a.start)
    .reduce((text, edit) => text.slice(0, edit.start) + edit.value + text.slice(edit.end), xml);
  xmlSpans(result); // A malformed edit is never written.
  return result;
}
