import { adobeLabelColor, VALID_COLOR_LABELS, type ColorLabel } from '../xmp/color-label.ts';
import { parseXmpMetadata } from '../xmp/metadata-parser.ts';
import { SaxesParser, type SaxesAttributeNS, type SaxesTagNS } from 'saxes';

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

/** What the culling read needs of an `rdf:Description`: its attributes and how many child elements it has. */
interface DescriptionBlock {
  attributes: Readonly<Record<string, SaxesAttributeNS>>;
  childCount: number;
}

interface OpenElement {
  rdf: boolean;
  /** An `rdf:RDF` with no `rdf:RDF` ancestor: the only kind whose child descriptions are read. */
  readableRdf: boolean;
  insideRdf: boolean;
  block?: DescriptionBlock;
}

function openElement(tag: SaxesTagNS, parent: OpenElement | undefined): OpenElement {
  const inRdfNamespace = tag.uri === RDF;
  const rdf = inRdfNamespace && tag.local === 'RDF';
  const insideRdf = parent !== undefined && (parent.insideRdf || parent.rdf);
  const isReadDescription = inRdfNamespace && tag.local === 'Description' && parent?.readableRdf;
  return {
    rdf,
    readableRdf: rdf && !insideRdf,
    insideRdf,
    block: isReadDescription ? { attributes: tag.attributes, childCount: 0 } : undefined,
  };
}

/** The `rdf:Description` children of every outermost `rdf:RDF`, in document order. The whole
 * document is still parsed, so a malformed sidecar throws exactly as a full span walk would, but
 * no span, namespace map or text offset is built for the (large) nested adjustment data. */
function descriptionBlocks(xml: string): DescriptionBlock[] {
  const parser = new SaxesParser({ xmlns: true });
  const blocks: DescriptionBlock[] = [];
  const open: OpenElement[] = [];
  parser.on('doctype', () => {
    throw new Error('DOCTYPE is not supported in an XMP sidecar');
  });
  parser.on('opentag', (tag) => {
    const parent = open.at(-1);
    if (parent?.block) parent.block.childCount += 1;
    const element = openElement(tag, parent);
    if (element.block) blocks.push(element.block);
    open.push(element);
  });
  parser.on('closetag', () => {
    open.pop();
  });
  parser.write(xml).close();
  return blocks;
}

function attr(block: DescriptionBlock, uri: string, local: string): string | undefined {
  return Object.values(block.attributes).find((value) => value.uri === uri && value.local === local)
    ?.value;
}

function subjectTier(block: DescriptionBlock): number {
  if (attr(block, RDF, 'nodeID') !== undefined) return 0;
  const about = attr(block, RDF, 'about');
  return about === '' ? 2 : about === undefined ? 1 : 0;
}

function sameSubject(block: DescriptionBlock, primary: DescriptionBlock): boolean {
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
function mergedAttributes(
  blocks: DescriptionBlock[],
  primary: DescriptionBlock,
): Map<string, string> {
  const merged = new Map<string, string>();
  for (const block of blocks) {
    if (block !== primary && !sameSubject(block, primary)) continue;
    for (const value of Object.values(block.attributes)) {
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
      return descriptionBlocks(xml);
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
    const score = (candidate: DescriptionBlock) =>
      Object.values(candidate.attributes).filter((value) => value.uri !== RDF).length +
      candidate.childCount;
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
