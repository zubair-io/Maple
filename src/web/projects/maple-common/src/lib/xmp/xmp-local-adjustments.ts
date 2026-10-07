// xmp-local-adjustments.ts — nested-element XMP I/O for local adjustments
// (#358, #3300, #360): the canonical Adobe Camera Raw
// `crs:GradientBasedCorrections` (linear masks) /
// `crs:CircularGradientBasedCorrections` (radial masks) /
// `crs:PaintBasedCorrections` (brush masks) /
// `crs:MaskGroupBasedCorrections` (bitmap + everywhere masks, Lightroom 11+'s
// own container for its AI masks) containers, each an `rdf:Seq` of `rdf:li`
// → `rdf:Description` corrections carrying the `crs:Local*2012` sliders and
// one nested `crs:CorrectionMasks` mask leaf. `docs/xmp-canonical-format.md`
// § "Local adjustments" is the contract; `raw-core/src/xmp/local_adjustments/`
// is the reference implementation this mirrors byte-for-byte on the write
// side and semantically on the read side.
//
// Read-side tolerance matches every other TypeScript reader in this
// directory rather than raw-core's hard-error posture: a correction whose
// mask isn't a shape Maple models (a Lightroom range mask, or an AI
// `Mask/Image` with no `papp:` recipe), that is inactive
// (`CorrectionActive="False"`), or whose required geometry (or, for a
// person/skin mask, its `papp:MaskDigest`, or, for a brush, a well-formed
// `crs:Dabs` series) is missing or non-numeric is DROPPED — never silently
// placed at an invented `0`/`1` — and the rest of the document still loads.
// A corrupt slider value on an otherwise valid correction reads as "not
// set", the same `NaN`-means-absent rule `xmp-adjustment-walk.ts` applies to
// the flat sliders. Group-container corrections omitted from the model
// survive in xmp-mask-group-passthrough.ts, including foreign/composite AI
// masks.

import type { AdjustmentModel } from '../models/adjustment-model';
import type {
  LocalAdjustment,
  LocalMask,
  LeafMask,
  LinearMask,
  MaskComponent,
  MaskPoint,
  PartialAdjustments,
  RangeRefinement,
  RadialMask,
  BitmapMask,
} from '../models/local-adjustment';
import { MASK_GROUP_VERSION } from '../generated/local-mask-wire.generated';
import {
  componentMetadata,
  localMetadata,
  localMetadataAttributes,
  localMetadataNodes,
} from './xmp-local-metadata';
import { numericSerializer } from './xmp-fields';
import {
  validGroupComponentAttributes,
  validGroupFlags,
  groupComponentOperation,
} from './xmp-mask-group-validation';
import { attrOf, managedXmpName } from './xmp-dom-utils';
import {
  correctionDescriptions,
  finiteAttr,
  firstRecognisedLeaf,
  maskLeaves,
  xmpBool,
} from './xmp-crs-corrections';
// Paint codecs (#360): same sibling-file split as the mask-raster types.
import {
  MASK_WHAT_PAINT,
  brushLines,
  escapeRecipeAttr,
  fractionSerializer,
  maskCoord,
  parseBrushLeaf,
} from './xmp-local-adjustments-brush';

export type LocalAdjustmentContainerKind = 'linear' | 'radial' | 'paint' | 'group';

/** Container element per mask kind, in canonical emit order. */
const CONTAINERS: ReadonlyArray<{ tag: string; kind: LocalAdjustmentContainerKind }> = [
  { tag: 'crs:GradientBasedCorrections', kind: 'linear' },
  { tag: 'crs:CircularGradientBasedCorrections', kind: 'radial' },
  { tag: 'crs:PaintBasedCorrections', kind: 'paint' },
  { tag: 'crs:MaskGroupBasedCorrections', kind: 'group' },
];

const MASKS_ELEMENT = 'crs:CorrectionMasks';

const MASK_WHAT: Readonly<Record<LocalAdjustmentContainerKind, string>> = {
  linear: 'Mask/Gradient',
  radial: 'Mask/CircularGradient',
  paint: MASK_WHAT_PAINT,
  group: 'Mask/Image',
};

/**
 * Which container a mask rides: brush has the paint container to itself;
 * bitmap and everywhere share the group container.
 */
const containerKindOf = (mask: LocalMask): LocalAdjustmentContainerKind => {
  if (mask.kind === 'brush') return 'paint';
  if (mask.kind === 'linear' || mask.kind === 'radial') return mask.kind;
  return 'group';
};

/**
 * Slider attribute → model field, in canonical emit order. Every field has a
 * direct Adobe key except `vibrance`: Adobe's local-correction struct has no
 * vibrance control, so it rides Maple's own `papp:LocalVibrance`. The tail —
 * `hue` (#3269) plus the six spatial controls (#3407) — is the group Adobe
 * stores as a ±1 FRACTION of Maple's ±100 slider; see `FRACTION_SCALED`.
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
  ['crs:LocalHue', 'hue'],
  ['crs:LocalTexture', 'texture'],
  ['crs:LocalClarity2012', 'clarity'],
  ['crs:LocalDehaze', 'dehaze'],
  ['crs:LocalSharpness', 'sharpness'],
  ['crs:LocalLuminanceNoise', 'luminanceNoise'],
  ['crs:LocalDefringe', 'defringe'],
];

/**
 * The controls Adobe stores as a ±1 fraction rather than in Maple's own
 * units — `crs:LocalClarity2012="0.35"` is a Clarity of +35 in Lightroom's
 * own panel. They divide by 100 on the way out through `fractionSerializer`
 * and multiply by 100 on the way back in; the other ten sliders are stored
 * in Maple's units and ride `numericSerializer` unchanged.
 */
const FRACTION_SCALED: ReadonlySet<keyof PartialAdjustments> = new Set([
  'hue',
  'texture',
  'clarity',
  'dehaze',
  'sharpness',
  'luminanceNoise',
  'defringe',
]);

/** Canonical order and raw-core's defaults for missing Color range attributes. */
const RANGE_KEYS: ReadonlyArray<readonly [string, Exclude<keyof RangeRefinement, 'kind'>, number]> =
  [
    ['papp:RangeHue', 'hueDeg', 55],
    ['papp:RangeHueWidth', 'hueHalfWidthDeg', 25],
    ['papp:RangeChromaMin', 'chromaMin', 0.02],
    ['papp:RangeLMin', 'lMin', 0.15],
    ['papp:RangeLMax', 'lMax', 0.95],
    ['papp:RangeFeather', 'feather', 0.3],
  ];

const CORRECTION_ATTRIBUTES = new Set([
  'crs:What',
  'crs:CorrectionAmount',
  'crs:CorrectionActive',
  ...SLIDER_KEYS.map(([key]) => key),
  ...RANGE_KEYS.map(([key]) => key),
  'papp:RangeKind',
  'papp:MaskGroupVersion',
  'papp:MaskGroupOpacity',
  'papp:MaskGroupInverted',
]);

/** Which container `child` is, or undefined when it is not one. */
export function localAdjustmentContainerKind(
  child: Element,
): LocalAdjustmentContainerKind | undefined {
  const name = managedXmpName(child);
  return CONTAINERS.find((c) => name === c.tag)?.kind;
}

// ── Parse ──────────────────────────────────────────────────────────────────
// The container walk and the attribute codecs live in
// `xmp-crs-corrections.ts`, shared with the repair-spot reader (#3409);
// only the leaf semantics below are this container's own.

const point = (x: number, y: number): MaskPoint => ({ x, y });

function parseRange(description: Element): RangeRefinement | undefined {
  if (attrOf(description, ['papp:RangeKind']) !== 'Color') return undefined;
  const values = RANGE_KEYS.map(([key, field, fallback]) => {
    const value = attrOf(description, [key]) === null ? fallback : finiteAttr(description, key);
    return [field, value] as const;
  });
  // A corrupt range is absent; a missing numeric attribute uses raw-core's default.
  if (values.some(([, value]) => value === undefined)) return undefined;
  return { kind: 'color', ...Object.fromEntries(values) } as RangeRefinement;
}

function parseLinearLeaf(leaf: Element): LeafMask | undefined {
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

function radialBounds(leaf: Element): Pick<RadialMask, 'center' | 'radii'> | undefined {
  const top = finiteAttr(leaf, 'crs:Top');
  const left = finiteAttr(leaf, 'crs:Left');
  const bottom = finiteAttr(leaf, 'crs:Bottom');
  const right = finiteAttr(leaf, 'crs:Right');
  if (top === undefined || left === undefined || bottom === undefined || right === undefined)
    return undefined;
  return {
    center: point((left + right) / 2, (top + bottom) / 2),
    radii: point((right - left) / 2, (bottom - top) / 2),
  };
}

function radialVersion(leaf: Element): boolean | undefined {
  const version = finiteAttr(leaf, 'crs:Version') ?? 1;
  return version === 1 || version === 2 ? version === 2 : undefined;
}

function parseRadialLeaf(leaf: Element): LeafMask | undefined {
  const bounds = radialBounds(leaf);
  const modern = radialVersion(leaf);
  if (!bounds || modern === undefined) return undefined;
  const angleDeg = finiteAttr(leaf, 'crs:Angle') ?? 0;
  const featherPct = finiteAttr(leaf, 'crs:Feather') ?? 50;
  return {
    kind: 'radial',
    ...bounds,
    angle: (angleDeg * Math.PI) / 180,
    feather: Math.min(1, Math.max(0, featherPct / (modern ? 50 : 100))),
    invert: (xmpBool(attrOf(leaf, ['crs:Flipped'])) ?? false) !== modern,
  };
}

/**
 * A `Mask/Image` leaf is recognized by its Maple-private `papp:MaskSource`
 * (#3271): Lightroom's own AI masks carry the same `crs:What` with a
 * `crs:MaskDigest` but no `papp:` recipe, and Maple can't regenerate pixels it
 * never computed, so those remain opaque in group passthrough. A person/skin
 * mask without `papp:MaskDigest` can never resolve to a raster, so it drops
 * too (raw-core hard-errors there; this reader is tolerant like its siblings).
 * The recipe's other fields default the way raw-core's parser defaults them.
 */
function parseGroupLeaf(leaf: Element): LeafMask | undefined {
  const source = attrOf(leaf, ['papp:MaskSource']);
  if (source === 'Everywhere') return { kind: 'everywhere' };
  if (source !== 'PersonSkin') return undefined;
  const digest = attrOf(leaf, ['papp:MaskDigest']);
  if (digest === null || digest.length === 0) return undefined;
  return {
    kind: 'bitmap',
    recipe: {
      person: Math.max(0, Math.trunc(finiteAttr(leaf, 'papp:MaskPerson') ?? 0)),
      facialSkin: xmpBool(attrOf(leaf, ['papp:MaskFacialSkin'])) ?? true,
      bodySkin: xmpBool(attrOf(leaf, ['papp:MaskBodySkin'])) ?? true,
      model: attrOf(leaf, ['papp:MaskModel']) ?? '',
      digest,
    },
    // The sidecar never carries a raster id — the render worker's registry
    // resolves the digest at render time (`docs/xmp-canonical-format.md`).
    rasterId: 0,
  };
}

const LEAF_PARSERS: Readonly<
  Record<LocalAdjustmentContainerKind, (leaf: Element) => LeafMask | undefined>
> = {
  linear: parseLinearLeaf,
  radial: parseRadialLeaf,
  paint: parseBrushLeaf,
  group: parseGroupLeaf,
};

function parseGroupComponent(leaf: Element): MaskComponent | undefined {
  if (!validGroupComponentAttributes(leaf)) return undefined;
  const kind = (Object.keys(MASK_WHAT) as LocalAdjustmentContainerKind[]).find(
    (key) => MASK_WHAT[key] === attrOf(leaf, ['crs:What']),
  );
  // Brush is a top-level-only mask in this slice (#360): a paint leaf here
  // rejects the component, and the group with it, rather than half-modelling
  // a brush-in-group composition.
  if (!kind || kind === 'paint') return undefined;
  const mask = LEAF_PARSERS[kind](leaf);
  if (!mask) return undefined;
  const operation = groupComponentOperation(leaf);
  if (!operation) return undefined;
  const xmpMetadata = componentMetadata(leaf);
  return { mask, ...operation, ...(xmpMetadata ? { xmpMetadata } : {}) };
}

function standaloneLegacyLeaf(components: MaskComponent[]): LeafMask | undefined {
  if (components.length !== 1) return undefined;
  const [first] = components;
  if (first.combine !== 'add' || first.invert || first.xmpMetadata) return undefined;
  return ['bitmap', 'everywhere'].includes(first.mask.kind) ? first.mask : undefined;
}

function unmarkedGroup(description: Element, opacity: number, invert: boolean): boolean {
  return attrOf(description, ['papp:MaskGroupVersion']) === null && opacity === 1 && !invert;
}

function parseMaskGroup(description: Element, leaves: Element[]): LocalMask | undefined {
  if (!validGroupFlags(description)) return undefined;
  const components = leaves.map(parseGroupComponent);
  if (!components.length || components.some((c) => !c)) return undefined;
  const recognized = components as MaskComponent[];
  const opacity = finiteAttr(description, 'papp:MaskGroupOpacity') ?? 1;
  const invert = xmpBool(attrOf(description, ['papp:MaskGroupInverted'])) ?? false;
  if (unmarkedGroup(description, opacity, invert)) {
    const leaf = standaloneLegacyLeaf(recognized);
    if (leaf) return leaf;
  }
  return { kind: 'group', components: recognized, opacity, invert };
}

/** The first `crs:CorrectionMasks` leaf whose `crs:What` this container models. */
function parseMask(
  description: Element,
  kind: LocalAdjustmentContainerKind,
): LocalMask | undefined {
  // Matched through `managedXmpName` rather than the local name alone: the
  // masks element is a `crs:` node Maple owns, so a foreign element with the
  // same local name in another namespace must not be mistaken for it.
  const masksLocalName = Array.from(description.children).find(
    (c) => managedXmpName(c) === MASKS_ELEMENT,
  )?.localName;
  if (!masksLocalName) return undefined;
  const allLeaves = maskLeaves(description, masksLocalName);
  if (kind === 'group') return parseMaskGroup(description, allLeaves);
  const leaves = allLeaves.filter((leaf) => attrOf(leaf, ['crs:What']) === MASK_WHAT[kind]);
  return firstRecognisedLeaf(leaves, LEAF_PARSERS[kind]);
}

export function parseLocalCorrection(
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
      const raw = finiteAttr(description, key);
      const v = raw === undefined ? undefined : FRACTION_SCALED.has(field) ? raw * 100 : raw;
      return v === undefined ? [] : [[field, amount === 1 ? v : v * amount] as const];
    }),
  ) as PartialAdjustments;
  const range = parseRange(description);
  const xmpMetadata =
    kind === 'group'
      ? localMetadata(description, CORRECTION_ATTRIBUTES, new Set([MASKS_ELEMENT]))
      : undefined;
  return {
    mask,
    adjustments,
    ...(range ? { range } : {}),
    ...(xmpMetadata ? { xmpMetadata } : {}),
  };
}

/**
 * Read one container element's corrections into layers, in document order.
 * Corrections the reader can't model are dropped (see the file header).
 */
export function parseLocalAdjustmentsContainer(
  container: Element,
  kind: LocalAdjustmentContainerKind,
): LocalAdjustment[] {
  return correctionDescriptions(container).flatMap((description) => {
    const layer = parseLocalCorrection(description, kind);
    return layer ? [layer] : [];
  });
}

// ── Serialize ──────────────────────────────────────────────────────────────

function rangeLines(range: RangeRefinement | undefined, indent: string): string[] {
  if (!range || RANGE_KEYS.some(([, field]) => !Number.isFinite(range[field]))) return [];
  return [
    `${indent}papp:RangeKind="Color"`,
    ...RANGE_KEYS.map(([key, field]) => `${indent}${key}="${numericSerializer(range[field])}"`),
  ];
}

function componentLines(component: MaskComponent, indent: string): string[] {
  const subtract = component.combine !== 'add';
  const inverted = component.invert !== (component.combine === 'intersect');
  const lines = maskLines(component.mask, indent, true).map((line) =>
    line.replace('crs:MaskValue="1"', `crs:MaskValue="${subtract ? 0 : 1}"`).replace('/>', ''),
  );
  const combine = component.combine[0].toUpperCase() + component.combine.slice(1);
  return [
    ...lines,
    ...localMetadataAttributes(component.xmpMetadata, indent + '  '),
    `${indent}  papp:MaskCombine="${combine}"`,
    `${indent}  crs:MaskActive="True"`,
    `${indent}  crs:MaskBlendMode="${subtract ? 1 : 0}"`,
    `${indent}  crs:MaskInverted="${inverted ? 'True' : 'False'}"${component.xmpMetadata?.nodes.length ? '>' : '/>'}`,
    ...localMetadataNodes(component.xmpMetadata, indent + '  '),
    ...(component.xmpMetadata?.nodes.length ? [`${indent}</rdf:li>`] : []),
  ];
}

function bitmapLines(mask: BitmapMask, indent: string): string[] {
  // `rasterId` is deliberately NOT written — it is an in-process handle,
  // resolved from `papp:MaskDigest` on load, so the sidecar stays portable.
  const { recipe } = mask;
  return [
    `${indent}<rdf:li`,
    `${indent}  crs:What="${MASK_WHAT.group}"`,
    `${indent}  crs:MaskSubType="1"`,
    `${indent}  crs:MaskValue="1"`,
    `${indent}  papp:MaskSource="PersonSkin"`,
    `${indent}  papp:MaskPerson="${recipe.person}"`,
    `${indent}  papp:MaskFacialSkin="${recipe.facialSkin ? 'True' : 'False'}"`,
    `${indent}  papp:MaskBodySkin="${recipe.bodySkin ? 'True' : 'False'}"`,
    `${indent}  papp:MaskModel="${escapeRecipeAttr(recipe.model)}"`,
    `${indent}  papp:MaskDigest="${escapeRecipeAttr(recipe.digest)}"/>`,
  ];
}

function maskLines(mask: LocalMask, indent: string, modern = false): string[] {
  switch (mask.kind) {
    case 'group':
      return mask.components.flatMap((component) => componentLines(component, indent));
    case 'linear':
      return linearLines(mask, indent, modern);
    case 'radial':
      return radialLines(mask, indent, modern);
    case 'bitmap':
      return bitmapLines(mask, indent);
    case 'brush':
      return brushLines(mask, indent);
    case 'everywhere':
      return [
        `${indent}<rdf:li`,
        `${indent}  crs:What="${MASK_WHAT.group}"`,
        `${indent}  crs:MaskValue="1"`,
        `${indent}  papp:MaskSource="Everywhere"/>`,
      ];
  }
}

const modernNumber = (value: number): string => String(value);

function linearLines(mask: LinearMask, indent: string, modern: boolean): string[] {
  const n = modern ? modernNumber : numericSerializer;
  const coord = modern ? modernNumber : maskCoord;
  return [
    `${indent}<rdf:li`,
    `${indent}  crs:What="${MASK_WHAT.linear}"`,
    `${indent}  crs:MaskValue="1"`,
    `${indent}  crs:ZeroX="${coord(mask.start.x)}" crs:ZeroY="${coord(mask.start.y)}"`,
    `${indent}  crs:FullX="${coord(mask.end.x)}" crs:FullY="${coord(mask.end.y)}"`,
    `${indent}  papp:LocalFeather="${n(mask.feather)}"/>`,
  ];
}

function radialLines(mask: RadialMask, indent: string, modern: boolean): string[] {
  const n = modern ? modernNumber : numericSerializer;
  const coord = modern ? modernNumber : maskCoord;
  const top = coord(mask.center.y - mask.radii.y);
  const left = coord(mask.center.x - mask.radii.x);
  const bottom = coord(mask.center.y + mask.radii.y);
  const right = coord(mask.center.x + mask.radii.x);
  return [
    `${indent}<rdf:li`,
    `${indent}  crs:What="${MASK_WHAT.radial}"`,
    `${indent}  crs:MaskValue="1"`,
    `${indent}  crs:Top="${top}" crs:Left="${left}" crs:Bottom="${bottom}" crs:Right="${right}"`,
    `${indent}  crs:Angle="${n((mask.angle * 180) / Math.PI)}" crs:Midpoint="50" crs:Roundness="0"`,
    `${indent}  crs:Feather="${n(mask.feather * (modern ? 50 : 100))}" crs:Flipped="${mask.invert !== modern ? 'True' : 'False'}"${modern ? ' crs:Version="2"' : ''}/>`,
  ];
}

/** One correction, shared by canonical emission and opaque group slot replacement. */
export function localCorrectionBlock(layer: LocalAdjustment, indent: string): string {
  const [i1, i2, i3, i4] = [2, 4, 6, 8].map((n) => indent + ' '.repeat(n));
  const attrs = [
    `${i2}crs:What="Correction"`,
    `${i2}crs:CorrectionAmount="1"`,
    `${i2}crs:CorrectionActive="True"`,
    ...SLIDER_KEYS.flatMap(([key, field]) => {
      const v = layer.adjustments[field];
      // Only fields actually set are written; a non-finite value is not
      // representable in XMP and is skipped like every other slider.
      return typeof v === 'number' && Number.isFinite(v)
        ? [
            `${i2}${key}="${
              FRACTION_SCALED.has(field) ? fractionSerializer(v / 100) : numericSerializer(v)
            }"`,
          ]
        : [];
    }),
    ...rangeLines(layer.range, i2),
    ...localMetadataAttributes(layer.xmpMetadata, i2),
    ...(layer.mask.kind === 'group'
      ? [
          `${i2}papp:MaskGroupVersion="${MASK_GROUP_VERSION}"`,
          `${i2}papp:MaskGroupOpacity="${layer.mask.opacity}"`,
          `${i2}papp:MaskGroupInverted="${layer.mask.invert ? 'True' : 'False'}"`,
        ]
      : []),
  ];
  return [
    `${indent}<rdf:li>`,
    `${i1}<rdf:Description`,
    `${attrs.join('\n')}>`,
    `${i2}<crs:CorrectionMasks>`,
    `${i3}<rdf:Seq>`,
    ...maskLines(layer.mask, i4),
    `${i3}</rdf:Seq>`,
    `${i2}</crs:CorrectionMasks>`,
    ...localMetadataNodes(layer.xmpMetadata, i2),
    `${i1}</rdf:Description>`,
    `${indent}</rdf:li>`,
  ].join('\n');
}

function containerBlock(tag: string, layers: readonly LocalAdjustment[], indent: string): string {
  const [i1, i2] = [2, 4].map((n) => indent + ' '.repeat(n));
  const layerLines = layers.map((layer) => localCorrectionBlock(layer, i2));
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
 * parity fixtures in `local-adjustments.spec.ts` (linear + radial),
 * `local-adjustments-bitmap.spec.ts` (bitmap + everywhere) and
 * `local-adjustments-brush.spec.ts` (brush) pin that.
 *
 * Adobe keeps each mask kind in its own array, so an interleaved model
 * stack round-trips as up to four contiguous runs (all linear, then all
 * radial, then all brush, then all bitmap/everywhere). Returns the empty
 * string when there are no layers, so an unedited model adds nothing to the
 * document.
 */
export function localAdjustmentBlocks(model: Partial<AdjustmentModel>, indent: string): string {
  const layers = model.localAdjustments ?? [];
  return CONTAINERS.map(({ tag, kind }) => {
    const ofKind = layers.filter((l) => containerKindOf(l.mask) === kind);
    return ofKind.length === 0 ? '' : containerBlock(tag, ofKind, indent);
  })
    .filter((b) => b.length > 0)
    .join('\n');
}
