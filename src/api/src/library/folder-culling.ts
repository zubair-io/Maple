import { adobeLabelColor, VALID_COLOR_LABELS, type ColorLabel } from '../xmp/color-label.ts';
import { parseXmpMetadata } from '../xmp/metadata-parser.ts';
import { descriptions, xmlSpans, type XmlSpan } from '../xmp/transfer-document.ts';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const XML = 'http://www.w3.org/XML/1998/namespace';
const XMP = 'http://ns.adobe.com/xap/1.0/';
const MAPLE = 'https://maple.app/ns/1.0/';
const PAPP = ['http://ns.justmaple.app/photo/1.0/', 'http://ns.justmaple.app/1.0/'];

export interface FolderCulling {
  rating?: number;
  flag?: 'pick' | 'reject';
  colorLabel?: ColorLabel;
}

function attr(block: XmlSpan, uri: string, local: string): string | undefined {
  return Object.values(block.tag.attributes).find(
    (value) => value.uri === uri && value.local === local,
  )?.value;
}

function subjectTier(block: XmlSpan): number {
  if (attr(block, RDF, 'nodeID') !== undefined) return 0;
  const about = attr(block, RDF, 'about');
  return about === '' ? 2 : about === undefined ? 1 : 0;
}

function sameSubject(block: XmlSpan, primary: XmlSpan): boolean {
  const about = attr(primary, RDF, 'about');
  const node = attr(primary, RDF, 'nodeID');
  return (
    (about !== undefined || node !== undefined) &&
    attr(block, RDF, 'about') === about &&
    attr(block, RDF, 'nodeID') === node &&
    attr(block, XML, 'lang') === attr(primary, XML, 'lang') &&
    attr(block, XML, 'base') === attr(primary, XML, 'base')
  );
}

/** The first value of each expanded attribute name wins across descriptions. */
function mergedAttributes(blocks: XmlSpan[], primary: XmlSpan): Map<string, string> {
  const merged = new Map<string, string>();
  for (const block of blocks) {
    if (block !== primary && !sameSubject(block, primary)) continue;
    for (const value of Object.values(block.tag.attributes)) {
      const key = `${value.uri}\0${value.local}`;
      if (!merged.has(key)) merged.set(key, value.value);
    }
  }
  return merged;
}

/** Match Preview's RDF subject and namespace semantics without a browser DOM. */
export function parseFolderCulling(xml: string): FolderCulling {
  const blocks = (() => {
    try {
      return descriptions(xmlSpans(xml));
    } catch {
      // Some old sidecars are incomplete fragments; retain the tolerant reader.
      return [];
    }
  })();
  if (blocks.length === 0) {
    const parsed = parseXmpMetadata(xml);
    return { rating: parsed.rating, flag: parsed.flag, colorLabel: parsed.colorLabel };
  }
  const primary = blocks.reduce((best, block) => {
    const tier = subjectTier(block) - subjectTier(best);
    if (tier !== 0) return tier > 0 ? block : best;
    const score = (candidate: XmlSpan) =>
      Object.values(candidate.tag.attributes).filter((value) => value.uri !== RDF).length +
      candidate.children.length;
    return score(block) > score(best) ? block : best;
  });
  const values = mergedAttributes(blocks, primary);
  const get = (uri: string, local: string) => values.get(`${uri}\0${local}`);
  const ratingText = get(XMP, 'Rating') ?? get('', 'Rating');
  const ratingNumber = ratingText === undefined ? undefined : Number(ratingText);
  const rating =
    ratingNumber !== undefined &&
    Number.isFinite(ratingNumber) &&
    ratingNumber >= 0 &&
    ratingNumber <= 5
      ? Math.round(ratingNumber)
      : undefined;
  const flagText =
    get(MAPLE, 'Flag') ??
    PAPP.map((uri) => get(uri, 'Flag')).find((v) => v !== undefined) ??
    get('', 'Flag');
  const flag = flagText === 'pick' || flagText === 'reject' ? flagText : undefined;
  const mapleColor =
    get(MAPLE, 'ColorLabel') ??
    PAPP.map((uri) => get(uri, 'ColorLabel')).find((v) => v !== undefined) ??
    get('', 'ColorLabel');
  const colorLabel =
    mapleColor !== undefined && VALID_COLOR_LABELS.has(mapleColor)
      ? (mapleColor as ColorLabel)
      : adobeLabelColor(get(XMP, 'Label') ?? get('', 'Label') ?? '');
  return { rating, flag, colorLabel };
}
