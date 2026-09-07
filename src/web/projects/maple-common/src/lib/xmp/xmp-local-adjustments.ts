// xmp-local-adjustments.ts — nested-element XMP I/O for local adjustments
// (#358, #3300): the canonical Adobe Camera Raw `crs:GradientBasedCorrections`
// (linear masks) / `crs:CircularGradientBasedCorrections` (radial masks) /
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
// mask isn't a shape Maple models (a brush, or a Lightroom AI `Mask/Image`
// with no `papp:` recipe), that is inactive (`CorrectionActive="False"`), or
// whose required geometry (or, for a person/skin mask, its `papp:MaskDigest`)
// is missing or non-numeric is DROPPED — never silently placed at an
// invented `0`/`1` — and the rest of the document still loads. A corrupt
// slider value on an otherwise valid correction reads as "not set", the same
// `NaN`-means-absent rule `xmp-adjustment-walk.ts` applies to the flat
// sliders. Group-container corrections omitted from the model survive in
// xmp-mask-group-passthrough.ts, including foreign/composite AI masks.

import type { AdjustmentModel } from '../models/adjustment-model';
import type {
  LocalAdjustment,
  LocalMask,
  MaskPoint,
  PartialAdjustments,
  RangeRefinement,
} from '../models/local-adjustment';
import { numericSerializer } from './xmp-fields';
import { attrOf, managedXmpName } from './xmp-dom-utils';

export type LocalAdjustmentContainerKind = 'linear' | 'radial' | 'group';

/** Container element per mask kind, in canonical emit order. */
const CONTAINERS: ReadonlyArray<{ tag: string; kind: LocalAdjustmentContainerKind }> = [
  { tag: 'crs:GradientBasedCorrections', kind: 'linear' },
  { tag: 'crs:CircularGradientBasedCorrections', kind: 'radial' },
  { tag: 'crs:MaskGroupBasedCorrections', kind: 'group' },
];

const MASKS_ELEMENT = 'crs:CorrectionMasks';

const MASK_WHAT: Readonly<Record<LocalAdjustmentContainerKind, string>> = {
  linear: 'Mask/Gradient',
  radial: 'Mask/CircularGradient',
  group: 'Mask/Image',
};

/** Which container a mask rides: bitmap and everywhere share the group container. */
const containerKindOf = (mask: LocalMask): LocalAdjustmentContainerKind =>
  mask.kind === 'linear' || mask.kind === 'radial' ? mask.kind : 'group';

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

/**
 * A `Mask/Image` leaf is recognized by its Maple-private `papp:MaskSource`
 * (#3271): Lightroom's own AI masks carry the same `crs:What` with a
 * `crs:MaskDigest` but no `papp:` recipe, and Maple can't regenerate pixels it
 * never computed, so those remain opaque in group passthrough. A person/skin
 * mask without `papp:MaskDigest` can never resolve to a raster, so it drops
 * too (raw-core hard-errors there; this reader is tolerant like its siblings).
 * The recipe's other fields default the way raw-core's parser defaults them.
 */
function parseGroupLeaf(leaf: Element): LocalMask | undefined {
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
  Record<LocalAdjustmentContainerKind, (leaf: Element) => LocalMask | undefined>
> = { linear: parseLinearLeaf, radial: parseRadialLeaf, group: parseGroupLeaf };

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
    .map((leaf) => LEAF_PARSERS[kind](leaf))
    .find((mask) => mask !== undefined);
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
  return range ? { mask, adjustments, range } : { mask, adjustments };
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
    const layer = description ? parseLocalCorrection(description, kind) : undefined;
    return layer ? [layer] : [];
  });
}

// ── Serialize ──────────────────────────────────────────────────────────────

/**
 * The `FRACTION_SCALED` keys ride Adobe's ±1 scale, so the canonical
 * two-decimal codec (`numericSerializer`) would quantise Maple's ±100 slider
 * to whole units and drift a fractional value on every round-trip (−42.5 →
 * "-0.43" → −43). Four decimals keep two decimals of the ±100 value —
 * mirrors raw-core's `fmt4` and Swift's `fmtNum4` so all four writers stay
 * byte-identical (#3400, #3407). Rounded away from zero like both of those —
 * `Math.round` alone rounds a negative tie toward +∞ (−2.5 → −2), which
 * would split the writers at an exact four-decimal midpoint.
 */
const fractionSerializer = (v: number): string =>
  ((Math.sign(v) * Math.round(Math.abs(v) * 10_000)) / 10_000).toString();

/**
 * Exactly raw-core's `escape_attr` (`&`, `<`, `"` — and nothing else, so the
 * bytes stay identical): the two free-text recipe fields are the only place
 * a `crs:`/`papp:` attribute value here could legally carry one of those.
 */
const escapeRecipeAttr = (s: string): string =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

function rangeLines(range: RangeRefinement | undefined, indent: string): string[] {
  if (!range || RANGE_KEYS.some(([, field]) => !Number.isFinite(range[field]))) return [];
  return [
    `${indent}papp:RangeKind="Color"`,
    ...RANGE_KEYS.map(([key, field]) => `${indent}${key}="${numericSerializer(range[field])}"`),
  ];
}

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
  if (mask.kind === 'bitmap') {
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
  if (mask.kind === 'everywhere') {
    return [
      `${indent}<rdf:li`,
      `${indent}  crs:What="${MASK_WHAT.group}"`,
      `${indent}  crs:MaskValue="1"`,
      `${indent}  papp:MaskSource="Everywhere"/>`,
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
 * parity fixtures in `local-adjustments.spec.ts` (linear + radial) and
 * `local-adjustments-bitmap.spec.ts` (bitmap + everywhere) pin that.
 *
 * Adobe keeps each mask kind in its own array, so an interleaved model
 * stack round-trips as up to three contiguous runs (all linear, then all
 * radial, then all bitmap/everywhere). Returns the empty string when there
 * are no layers, so an unedited model adds nothing to the document.
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
