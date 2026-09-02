// xmp-tone-curves.ts — nested-element XMP I/O for the eight point tone
// curves: the scene-linear family (#365) and the display-referred family
// (#2232).
//
// Every other field in the sidecar is a flat attribute on `rdf:Description`,
// which is why `ADJUSTMENT_FIELDS` is a flat table and the parser walks
// `desc.attributes`. A point curve is a list, so it takes the RDF container
// form:
//
//   <papp:SceneLinearToneCurve>
//     <rdf:Seq>
//       <rdf:li>0, 0</rdf:li>
//       <rdf:li>128, 140</rdf:li>
//       <rdf:li>255, 255</rdf:li>
//     </rdf:Seq>
//   </papp:SceneLinearToneCurve>
//
// Two families, two namespaces: Maple's own point curves are `papp:`;
// Adobe's are `crs:ToneCurvePV2012*`. Different quantities — #273's pipeline
// applies the `papp:` curves pre-AgX in scene-linear light, while a PV2012
// curve was authored against Lightroom's own display transform and only
// means anything after a view transform (`docs/xmp-canonical-format.md` §
// "Tone curves"). #2232 gives the `crs:` family its own pipeline slot
// (post-AgX, display-linear) and its own model fields, so both round-trip
// structurally — reading a Lightroom curve into the `papp:` fields would
// still apply a display-referred shape to scene-linear data and render it
// visibly wrong, which is why the two stay on separate elements/fields.
//
// Wire domain: control points are `[0, 1]` on the model and PV2012's
// `[0, 255]` on the wire, for BOTH families. Identity (the empty point list)
// emits no element at all — not an empty `rdf:Seq` — so unedited sidecars
// stay byte-clean.

import type { AdjustmentModel, ToneCurve, ToneCurvePoint } from '../models/adjustment-model';
import { numericSerializer } from './xmp-fields';
import { managedXmpName } from './xmp-dom-utils';

/** Model keys of the eight point curves, in canonical emit order. */
export type ToneCurveKey =
  | 'toneCurveLuma'
  | 'toneCurveRed'
  | 'toneCurveGreen'
  | 'toneCurveBlue'
  | 'displayToneCurveLuma'
  | 'displayToneCurveRed'
  | 'displayToneCurveGreen'
  | 'displayToneCurveBlue';

/** Curve parent element name → model key, in canonical emit order: the four
 * scene-linear `papp:` curves (#365) followed by the four display-referred
 * `crs:` curves (#2232). */
const TONE_CURVE_ELEMENTS: ReadonlyArray<{ tag: string; modelKey: ToneCurveKey }> = [
  { tag: 'papp:SceneLinearToneCurve', modelKey: 'toneCurveLuma' },
  { tag: 'papp:SceneLinearToneCurveRed', modelKey: 'toneCurveRed' },
  { tag: 'papp:SceneLinearToneCurveGreen', modelKey: 'toneCurveGreen' },
  { tag: 'papp:SceneLinearToneCurveBlue', modelKey: 'toneCurveBlue' },
  { tag: 'crs:ToneCurvePV2012', modelKey: 'displayToneCurveLuma' },
  { tag: 'crs:ToneCurvePV2012Red', modelKey: 'displayToneCurveRed' },
  { tag: 'crs:ToneCurvePV2012Green', modelKey: 'displayToneCurveGreen' },
  { tag: 'crs:ToneCurvePV2012Blue', modelKey: 'displayToneCurveBlue' },
];

/**
 * PV2012's coordinate domain. Kept for familiarity and for Lightroom-shaped
 * tooling that reads sidecars by eye.
 */
const WIRE_SCALE = 255;

/**
 * The curve element `child` belongs to, or undefined when it is not one.
 * Matched on the qualified tag name first (what every Maple writer emits) and
 * on the local name as a fallback, mirroring the prefix-tolerant matching the
 * `dc:subject` / metadata passthrough exclusions already use.
 */
export function toneCurveElementKey(child: Element): ToneCurveKey | undefined {
  const name = managedXmpName(child);
  return TONE_CURVE_ELEMENTS.find((element) => name === element.tag)?.modelKey;
}

/**
 * Decode one `<rdf:li>x, y</rdf:li>` body into a `[0, 1]` control point.
 * Returns undefined for anything that is not a finite numeric pair — a
 * malformed entry is dropped rather than failing the parse, matching how the
 * parser treats every other unrecognised construct in the document.
 */
function parsePoint(text: string): ToneCurvePoint | undefined {
  const comma = text.indexOf(',');
  if (comma < 0) return undefined;
  const x = Number(text.slice(0, comma).trim());
  const y = Number(text.slice(comma + 1).trim());
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return [x / WIRE_SCALE, y / WIRE_SCALE];
}

/**
 * Read a curve parent element's `rdf:Seq` / `rdf:li` children into a
 * `ToneCurve`. An element with no usable list items yields the identity
 * (empty) curve, which the serializer then omits entirely.
 */
export function parseToneCurveElement(el: Element): ToneCurve {
  const points = Array.from(el.getElementsByTagName('*'))
    .filter((n) => n.localName === 'li')
    .map((n) => parsePoint(n.textContent ?? ''))
    .filter((p): p is ToneCurvePoint => p !== undefined);
  return { points };
}

/**
 * Emit the nested tone-curve children for `model`, each line prefixed so the
 * parent element sits at `indent`.
 *
 * `indent` is a parameter because the three writers nest `rdf:Description`'s
 * children at different depths today; the block's internal shape is identical
 * everywhere, which is what the cross-language parity tests pin.
 *
 * Returns the empty string when all eight curves are identity, so an unedited
 * model adds nothing to the document.
 */
export function toneCurveBlocks(model: Partial<AdjustmentModel>, indent: string): string {
  return TONE_CURVE_ELEMENTS.map(({ tag, modelKey }) => {
    const curve = model[modelKey];
    if (!curve || curve.points.length === 0) return '';
    const items = curve.points.map(
      ([x, y]) =>
        `${indent}    <rdf:li>${numericSerializer(x * WIRE_SCALE)}, ` +
        `${numericSerializer(y * WIRE_SCALE)}</rdf:li>`,
    );
    return [
      `${indent}<${tag}>`,
      `${indent}  <rdf:Seq>`,
      ...items,
      `${indent}  </rdf:Seq>`,
      `${indent}</${tag}>`,
    ].join('\n');
  })
    .filter((b) => b.length > 0)
    .join('\n');
}
