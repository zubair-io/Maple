// xmp-retouch.ts — nested-element XMP I/O for clone / heal repair spots
// (#3409): Adobe's `crs:RetouchAreas` container, an `rdf:Seq` of `rdf:li` →
// `rdf:Description` corrections naming the spot type and the source point,
// each carrying one nested `crs:Masks` circular leaf for the destination
// disc. `docs/xmp-canonical-format.md` § "Repair spots" is the contract and
// `raw-core/src/xmp/retouch/` is the reference implementation this mirrors
// byte-for-byte on the write side and semantically on the read side.
//
// Read-side tolerance matches the other TypeScript readers here rather than
// raw-core's hard-error posture: a correction whose `crs:SpotType` this
// build does not model, or whose mask leaf is not the circular form (a
// Lightroom brush stroke), is DROPPED and the rest of the document still
// loads. The legacy `crs:RetouchInfo` string form older Lightroom versions
// wrote is read and never written; when a document carries both, the struct
// form wins.

import type { AdjustmentModel } from '../models/adjustment-model';
import type { RetouchKind, RetouchPoint, RetouchSpot } from '../models/retouch-spot';
import { RETOUCH_DEFAULT_FEATHER } from '../models/retouch-spot';
import { attrOf, managedXmpName } from './xmp-dom-utils';
import {
  correctionDescriptions,
  childrenNamed,
  finiteAttr,
  firstRecognisedLeaf,
  maskLeaves,
} from './xmp-crs-corrections';

const RETOUCH_AREAS_ELEMENT = 'crs:RetouchAreas';
const RETOUCH_INFO_ELEMENT = 'crs:RetouchInfo';
const MASKS_LOCAL_NAME = 'Masks';
const MASK_WHAT_CIRCULAR = 'Mask/CircularGradient';

/** Which retouch container `child` is, or undefined when it is neither. */
export function retouchContainerKind(child: Element): 'areas' | 'legacy' | undefined {
  const name = managedXmpName(child);
  if (name === RETOUCH_AREAS_ELEMENT) return 'areas';
  if (name === RETOUCH_INFO_ELEMENT) return 'legacy';
  return undefined;
}

// ── Parse ──────────────────────────────────────────────────────────────────
// The container walk and the attribute codecs live in
// `xmp-crs-corrections.ts`, shared with the local-adjustment reader (#358);
// only the spot semantics below are this container's own.

const spotKind = (raw: string | null): RetouchKind | undefined =>
  raw === 'heal' || raw === 'clone' ? raw : undefined;

/** The destination disc a `crs:Masks` leaf describes. */
interface RetouchDisc {
  center: RetouchPoint;
  radius: number;
  /** A leaf-level `crs:Feather`, which overrides the correction's. */
  feather?: number;
}

/** The destination disc from a `crs:Masks` leaf, or undefined if unmodelled. */
function parseMaskLeaf(leaf: Element): RetouchDisc | undefined {
  if (attrOf(leaf, ['crs:What']) !== MASK_WHAT_CIRCULAR) return undefined;
  const x = finiteAttr(leaf, 'crs:X');
  const y = finiteAttr(leaf, 'crs:Y');
  const radius = finiteAttr(leaf, 'crs:Radius');
  if (x === undefined || y === undefined || radius === undefined) return undefined;
  return { center: { x, y }, radius, feather: finiteAttr(leaf, 'crs:Feather') };
}

/**
 * Where the spot samples from. Adobe writes it either absolutely
 * (`crs:SourceX`/`Y`) or as a delta from the destination
 * (`crs:OffsetX`/`Y`); both spellings resolve to the same stored point, and
 * the absolute pair wins when a document carries both.
 */
function parseSource(description: Element, center: RetouchPoint): RetouchPoint | undefined {
  for (const [xKey, yKey, originX, originY] of [
    ['crs:SourceX', 'crs:SourceY', 0, 0],
    ['crs:OffsetX', 'crs:OffsetY', center.x, center.y],
  ] as const) {
    const x = finiteAttr(description, xKey);
    const y = finiteAttr(description, yKey);
    if (x !== undefined && y !== undefined) return { x: originX + x, y: originY + y };
  }
  return undefined;
}

/** One `rdf:Description` correction under `crs:RetouchAreas`. */
function parseRetouchCorrection(description: Element): RetouchSpot | undefined {
  const kind = spotKind(attrOf(description, ['crs:SpotType']));
  if (!kind) return undefined;
  const disc = firstRecognisedLeaf(maskLeaves(description, MASKS_LOCAL_NAME), parseMaskLeaf);
  if (!disc) return undefined;
  const source = parseSource(description, disc.center);
  if (!source) return undefined;
  return {
    kind,
    center: disc.center,
    source,
    radius: disc.radius,
    feather: disc.feather ?? finiteAttr(description, 'crs:Feather') ?? RETOUCH_DEFAULT_FEATHER,
    opacity: finiteAttr(description, 'crs:Opacity') ?? 1,
  };
}

/** Every modelled spot in a `crs:RetouchAreas` container element. */
export function parseRetouchAreasContainer(container: Element): RetouchSpot[] {
  return correctionDescriptions(container)
    .map(parseRetouchCorrection)
    .filter((s): s is RetouchSpot => s !== undefined);
}

/** The legacy string form's numeric keys, in the order they compose a spot. */
const LEGACY_NUMERIC_KEYS = ['centerX', 'centerY', 'sourceX', 'sourceY', 'radius'] as const;

/**
 * One legacy `crs:RetouchInfo` `rdf:li` body — a comma-separated
 * `key = value` list. Tolerant: a missing coordinate, radius, or modelled
 * spot type drops that entry.
 */
function parseLegacyRetouchInfo(body: string): RetouchSpot | undefined {
  const fields = new Map<string, string>();
  for (const field of body.split(',')) {
    const eq = field.indexOf('=');
    if (eq >= 0) fields.set(field.slice(0, eq).trim(), field.slice(eq + 1).trim());
  }
  const kind = spotKind(fields.get('spotType') ?? null);
  if (!kind) return undefined;
  const numbers = LEGACY_NUMERIC_KEYS.map((key) => Number(fields.get(key)));
  if (!numbers.every((v) => Number.isFinite(v))) return undefined;
  const [cx, cy, sx, sy, radius] = numbers;
  return {
    kind,
    center: { x: cx, y: cy },
    source: { x: sx, y: sy },
    radius,
    feather: RETOUCH_DEFAULT_FEATHER,
    opacity: 1,
  };
}

/** Every modelled spot in a legacy `crs:RetouchInfo` container element. */
export function parseRetouchInfoContainer(container: Element): RetouchSpot[] {
  return childrenNamed(container, 'Seq')
    .flatMap((seq) => childrenNamed(seq, 'li'))
    .map((li) => parseLegacyRetouchInfo(li.textContent ?? ''))
    .filter((s): s is RetouchSpot => s !== undefined);
}

// ── Serialize ──────────────────────────────────────────────────────────────

/** Six-decimal wire precision — see the module doc. */
const n6 = (v: number): string => v.toFixed(6);

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

function correctionBlock(spot: RetouchSpot, indent: string): string {
  const [i1, i2, i3, i4] = [2, 4, 6, 8].map((k) => indent + ' '.repeat(k));
  const attrs = [
    `${i2}crs:SpotType="${spot.kind}"`,
    `${i2}crs:SourceState="sourceSetExplicitly"`,
    `${i2}crs:Method="circle"`,
    `${i2}crs:SourceX="${n6(spot.source.x)}"`,
    `${i2}crs:SourceY="${n6(spot.source.y)}"`,
    `${i2}crs:Opacity="${n6(clamp01(spot.opacity))}"`,
    `${i2}crs:Feather="${n6(clamp01(spot.feather))}"`,
    `${i2}crs:Seed="0"`,
  ];
  return [
    `${indent}<rdf:li>`,
    `${i1}<rdf:Description`,
    `${attrs.join('\n')}>`,
    `${i2}<crs:Masks>`,
    `${i3}<rdf:Seq>`,
    `${i4}<rdf:li`,
    `${i4}  crs:What="${MASK_WHAT_CIRCULAR}"`,
    `${i4}  crs:MaskValue="1"`,
    `${i4}  crs:X="${n6(spot.center.x)}"`,
    `${i4}  crs:Y="${n6(spot.center.y)}"`,
    `${i4}  crs:Radius="${n6(spot.radius)}"`,
    `${i4}  crs:Flow="1"`,
    `${i4}  crs:CenterWeight="0"/>`,
    `${i3}</rdf:Seq>`,
    `${i2}</crs:Masks>`,
    `${i1}</rdf:Description>`,
    `${indent}</rdf:li>`,
  ].join('\n');
}

/**
 * Emit the `crs:RetouchAreas` container for `model.retouchSpots`, each line
 * prefixed so the container sits at `indent`. Byte-identical to raw-core's
 * `serialize_retouch_areas` and Swift's `_buildRetouchAreasBlock` for the
 * same spots — `retouch.spec.ts` pins that against the shared literal.
 * Returns the empty string when there are no spots, so an unedited model
 * adds nothing to the document.
 */
export function retouchAreasBlock(model: Partial<AdjustmentModel>, indent: string): string {
  const spots = model.retouchSpots ?? [];
  if (spots.length === 0) return '';
  const [i1, i2] = [2, 4].map((k) => indent + ' '.repeat(k));
  return [
    `${indent}<${RETOUCH_AREAS_ELEMENT}>`,
    `${i1}<rdf:Seq>`,
    ...spots.map((spot) => correctionBlock(spot, i2)),
    `${i1}</rdf:Seq>`,
    `${indent}</${RETOUCH_AREAS_ELEMENT}>`,
  ].join('\n');
}
