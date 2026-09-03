// xmp-local-adjustments.ts — nested-element XMP I/O for local adjustments
// (#358): the canonical Adobe Camera Raw `crs:GradientBasedCorrections`
// (linear masks) / `crs:CircularGradientBasedCorrections` (radial masks)
// containers, each an `rdf:Seq` of `rdf:li` → `rdf:Description` corrections
// carrying the `crs:Local*2012` sliders and one nested `crs:CorrectionMasks`
// mask leaf. `docs/xmp-canonical-format.md` § "Local adjustments" is the
// contract; `raw-core/src/xmp/local_adjustments/` is the reference
// implementation this mirrors byte-for-byte on the write side and
// semantically on the read side.
//
// Read-side tolerance matches every other TypeScript reader in this
// directory rather than raw-core's hard-error posture: a correction whose
// mask isn't a shape Maple models, that is inactive (`CorrectionActive=
// "False"`), or whose required geometry is missing or non-numeric is
// DROPPED — never silently placed at an invented `0`/`1` — and the rest of
// the document still loads. A corrupt slider value on an otherwise valid
// correction reads as "not set", the same `NaN`-means-absent rule
// `xmp-adjustment-walk.ts` applies to the flat sliders.

import type { AdjustmentModel } from '../models/adjustment-model';
import type {
  LocalAdjustment,
  LocalMask,
  MaskPoint,
  PartialAdjustments,
} from '../models/local-adjustment';
import { numericSerializer } from './xmp-fields';
import { attrOf, managedXmpName } from './xmp-dom-utils';

export type LocalAdjustmentContainerKind = 'linear' | 'radial';

/** Container element per mask kind, in canonical emit order. */
const CONTAINERS: ReadonlyArray<{ tag: string; kind: LocalAdjustmentContainerKind }> = [
  { tag: 'crs:GradientBasedCorrections', kind: 'linear' },
  { tag: 'crs:CircularGradientBasedCorrections', kind: 'radial' },
];

const MASKS_ELEMENT = 'crs:CorrectionMasks';

const MASK_WHAT: Readonly<Record<LocalAdjustmentContainerKind, string>> = {
  linear: 'Mask/Gradient',
  radial: 'Mask/CircularGradient',
};

/**
 * Slider attribute → model field, in canonical emit order. Every field has a
 * direct Adobe key except `vibrance`: Adobe's local-correction struct has no
 * vibrance control, so it rides Maple's own `papp:LocalVibrance`.
 */
const SLIDER_KEYS: ReadonlyArray<readonly [string, keyof PartialAdjustments]> = [
  ['crs:LocalExposure2012', 'exposure'],
  ['crs:LocalContrast2012', 'contrast'],
  ['crs:LocalHighlights2012', 'highlights'],
  ['crs:LocalShadows2012', 'shadows'],
  ['crs:LocalWhites2012', 'whites'],
  ['crs:LocalBlacks2012', 'blacks'],
  ['crs:LocalSaturation', 'saturation'],
  ['papp:LocalVibrance', 'vibrance'],
  ['crs:LocalTemperature', 'temperature'],
  ['crs:LocalTint', 'tint'],
];

/** Which container `child` is, or undefined when it is not one. */
export function localAdjustmentContainerKind(
  child: Element,
): LocalAdjustmentContainerKind | undefined {
  const name = managedXmpName(child);
  return CONTAINERS.find((c) => name === c.tag)?.kind;
}

// ── Parse ──────────────────────────────────────────────────────────────────

/** RDF structural elements are matched on local name only, like raw-core's
 * `is_seq` / `is_li` / `is_description` — a sidecar may bind RDF to any prefix. */
const childrenNamed = (el: Element, local: string): Element[] =>
  Array.from(el.children).filter((c) => c.localName === local);

const finiteAttr = (el: Element, name: string): number | undefined => {
  const raw = attrOf(el, [name]);
  if (raw === null || raw.trim().length === 0) return undefined;
  const v = Number(raw);
  return Number.isFinite(v) ? v : undefined;
};

/** Adobe's boolean spellings, case-insensitive; undefined for anything else. */
const xmpBool = (raw: string | null): boolean | undefined => {
  const lower = raw?.trim().toLowerCase();
  if (lower === '1' || lower === 'true' || lower === 'on') return true;
  if (lower === '0' || lower === 'false' || lower === 'off') return false;
  return undefined;
};

const point = (x: number, y: number): MaskPoint => ({ x, y });

function parseLinearLeaf(leaf: Element): LocalMask | undefined {
  const zx = finiteAttr(leaf, 'crs:ZeroX');
  const zy = finiteAttr(leaf, 'crs:ZeroY');
  const fx = finiteAttr(leaf, 'crs:FullX');
  const fy = finiteAttr(leaf, 'crs:FullY');
  if (zx === undefined || zy === undefined || fx === undefined || fy === undefined)
    return undefined;
  return {
    kind: 'linear',
    start: point(zx, zy),
    end: point(fx, fy),
    feather: finiteAttr(leaf, 'papp:LocalFeather') ?? 0.5,
  };
}

function parseRadialLeaf(leaf: Element): LocalMask | undefined {
  const top = finiteAttr(leaf, 'crs:Top');
  const left = finiteAttr(leaf, 'crs:Left');
  const bottom = finiteAttr(leaf, 'crs:Bottom');
  const right = finiteAttr(leaf, 'crs:Right');
  if (top === undefined || left === undefined || bottom === undefined || right === undefined) {
    return undefined;
  }
  const angleDeg = finiteAttr(leaf, 'crs:Angle') ?? 0;
  const featherPct = finiteAttr(leaf, 'crs:Feather') ?? 50;
  return {
    kind: 'radial',
    center: point((left + right) / 2, (top + bottom) / 2),
    radii: point((right - left) / 2, (bottom - top) / 2),
    angle: (angleDeg * Math.PI) / 180,
    feather: Math.min(1, Math.max(0, featherPct / 100)),
    invert: xmpBool(attrOf(leaf, ['crs:Flipped'])) ?? false,
  };
}

/** The first `crs:CorrectionMasks` leaf whose `crs:What` this container models. */
function parseMask(
  description: Element,
  kind: LocalAdjustmentContainerKind,
): LocalMask | undefined {
  const masks = Array.from(description.children).find((c) => managedXmpName(c) === MASKS_ELEMENT);
  const seq = masks ? childrenNamed(masks, 'Seq')[0] : undefined;
  const leaves = seq ? childrenNamed(seq, 'li') : [];
  return leaves
    .filter((leaf) => attrOf(leaf, ['crs:What']) === MASK_WHAT[kind])
    .map((leaf) => (kind === 'linear' ? parseLinearLeaf(leaf) : parseRadialLeaf(leaf)))
    .find((mask) => mask !== undefined);
}

function parseCorrection(
  description: Element,
  kind: LocalAdjustmentContainerKind,
): LocalAdjustment | undefined {
  // Absent or unrecognized `CorrectionActive` means active, matching Adobe's
  // own convention; an explicit "False" is a disabled pin and is dropped.
  if (!(xmpBool(attrOf(description, ['crs:CorrectionActive'])) ?? true)) return undefined;
  const mask = parseMask(description, kind);
  if (!mask) return undefined;
  // `CorrectionAmount` is Adobe's 0–1 overall-strength dial: it scales every
  // stored slider at parse time, exactly as Adobe's own Amount slider does.
  const amount = finiteAttr(description, 'crs:CorrectionAmount') ?? 1;
  const adjustments = Object.fromEntries(
    SLIDER_KEYS.flatMap(([key, field]) => {
      const v = finiteAttr(description, key);
      return v === undefined ? [] : [[field, amount === 1 ? v : v * amount] as const];
    }),
  ) as PartialAdjustments;
  return { mask, adjustments };
}

/**
 * Read one container element's corrections into layers, in document order.
 * Corrections the reader can't model are dropped (see the file header).
 */
export function parseLocalAdjustmentsContainer(
  container: Element,
  kind: LocalAdjustmentContainerKind,
): LocalAdjustment[] {
  const seq = childrenNamed(container, 'Seq')[0];
  if (!seq) return [];
  return childrenNamed(seq, 'li').flatMap((li) => {
    const description = childrenNamed(li, 'Description')[0];
    const layer = description ? parseCorrection(description, kind) : undefined;
    return layer ? [layer] : [];
  });
}

// ── Serialize ──────────────────────────────────────────────────────────────

function maskLines(mask: LocalMask, indent: string): string[] {
  const n = numericSerializer;
  if (mask.kind === 'linear') {
    return [
      `${indent}<rdf:li`,
      `${indent}  crs:What="${MASK_WHAT.linear}"`,
      `${indent}  crs:MaskValue="1"`,
      `${indent}  crs:ZeroX="${n(mask.start.x)}" crs:ZeroY="${n(mask.start.y)}"`,
      `${indent}  crs:FullX="${n(mask.end.x)}" crs:FullY="${n(mask.end.y)}"`,
      `${indent}  papp:LocalFeather="${n(mask.feather)}"/>`,
    ];
  }
  const top = n(mask.center.y - mask.radii.y);
  const left = n(mask.center.x - mask.radii.x);
  const bottom = n(mask.center.y + mask.radii.y);
  const right = n(mask.center.x + mask.radii.x);
  return [
    `${indent}<rdf:li`,
    `${indent}  crs:What="${MASK_WHAT.radial}"`,
    `${indent}  crs:MaskValue="1"`,
    `${indent}  crs:Top="${top}" crs:Left="${left}" crs:Bottom="${bottom}" crs:Right="${right}"`,
    `${indent}  crs:Angle="${n((mask.angle * 180) / Math.PI)}" crs:Midpoint="50" crs:Roundness="0"`,
    `${indent}  crs:Feather="${n(mask.feather * 100)}" crs:Flipped="${mask.invert ? 'True' : 'False'}"/>`,
  ];
}

function containerBlock(tag: string, layers: readonly LocalAdjustment[], indent: string): string {
  const [i1, i2, i3, i4, i5, i6] = [2, 4, 6, 8, 10, 12].map((n) => indent + ' '.repeat(n));
  const layerLines = layers.flatMap((layer) => {
    const attrs = [
      `${i4}crs:What="Correction"`,
      `${i4}crs:CorrectionAmount="1"`,
      `${i4}crs:CorrectionActive="True"`,
      ...SLIDER_KEYS.flatMap(([key, field]) => {
        const v = layer.adjustments[field];
        // Only fields actually set are written; a non-finite value is not
        // representable in XMP and is skipped like every other slider.
        return typeof v === 'number' && Number.isFinite(v)
          ? [`${i4}${key}="${numericSerializer(v)}"`]
          : [];
      }),
    ];
    return [
      `${i2}<rdf:li>`,
      `${i3}<rdf:Description`,
      `${attrs.join('\n')}>`,
      `${i4}<crs:CorrectionMasks>`,
      `${i5}<rdf:Seq>`,
      ...maskLines(layer.mask, i6),
      `${i5}</rdf:Seq>`,
      `${i4}</crs:CorrectionMasks>`,
      `${i3}</rdf:Description>`,
      `${i2}</rdf:li>`,
    ];
  });
  return [
    `${indent}<${tag}>`,
    `${i1}<rdf:Seq>`,
    ...layerLines,
    `${i1}</rdf:Seq>`,
    `${indent}</${tag}>`,
  ].join('\n');
}

/**
 * Emit the canonical container blocks for `model.localAdjustments`, each
 * line prefixed so the container sits at `indent`. Byte-identical to
 * raw-core's `serialize_local_adjustments` and Swift's
 * `_buildLocalAdjustmentsBlock` for the same layers — the cross-language
 * parity fixture in `local-adjustments.spec.ts` pins that.
 *
 * Adobe keeps linear and radial corrections in two separate arrays, so an
 * interleaved model stack round-trips as two contiguous runs (all linear,
 * then all radial). Returns the empty string when there are no layers, so
 * an unedited model adds nothing to the document.
 */
export function localAdjustmentBlocks(model: Partial<AdjustmentModel>, indent: string): string {
  const layers = model.localAdjustments ?? [];
  return CONTAINERS.map(({ tag, kind }) => {
    const ofKind = layers.filter((l) => l.mask.kind === kind);
    return ofKind.length === 0 ? '' : containerBlock(tag, ofKind, indent);
  })
    .filter((b) => b.length > 0)
    .join('\n');
}
