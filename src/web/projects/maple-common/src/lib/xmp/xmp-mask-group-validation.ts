// A group is modeled only when every operation has supported semantics.
// Reject unknown booleans/geometry rather than changing the selected region.
import { attrOf } from './xmp-dom-utils';
import { finiteAttr, xmpBool } from './xmp-crs-corrections';
import { MASK_GROUP_VERSION } from '../generated/local-mask-wire.generated';
import type { MaskCombine, MaskComponent } from '../models/local-adjustment';

const validBooleans = (element: Element, keys: string[]): boolean =>
  keys.every(
    (key) => attrOf(element, [key]) === null || xmpBool(attrOf(element, [key])) !== undefined,
  );

export function validGroupComponentAttributes(leaf: Element): boolean {
  const numeric = [
    'crs:MaskBlendMode',
    'crs:MaskValue',
    'crs:Version',
    'crs:Angle',
    'crs:Feather',
    'papp:LocalFeather',
    'crs:Midpoint',
    'crs:Roundness',
  ];
  const version = finiteAttr(leaf, 'crs:Version') ?? 1;
  return (
    numeric.every((key) => attrOf(leaf, [key]) === null || finiteAttr(leaf, key) !== undefined) &&
    validBooleans(leaf, ['crs:MaskActive', 'crs:MaskInverted', 'crs:Flipped']) &&
    xmpBool(attrOf(leaf, ['crs:MaskActive'])) !== false &&
    (version === 1 || version === 2) &&
    (attrOf(leaf, ['crs:What']) !== 'Mask/CircularGradient' ||
      ((finiteAttr(leaf, 'crs:Midpoint') ?? 50) === 50 &&
        (finiteAttr(leaf, 'crs:Roundness') ?? 0) === 0))
  );
}

export function validGroupFlags(description: Element): boolean {
  const version = attrOf(description, ['papp:MaskGroupVersion']);
  const opacity = attrOf(description, ['papp:MaskGroupOpacity']);
  const rangeKind = attrOf(description, ['papp:RangeKind']);
  return (
    validBooleans(description, ['papp:MaskGroupInverted', 'crs:CorrectionActive']) &&
    (version === null || version === String(MASK_GROUP_VERSION)) &&
    (opacity === null || finiteAttr(description, 'papp:MaskGroupOpacity') !== undefined) &&
    (rangeKind === null || rangeKind === 'Color') &&
    ['Hue', 'HueWidth', 'ChromaMin', 'LMin', 'LMax', 'Feather'].every((suffix) => {
      const key = 'papp:Range' + suffix;
      return attrOf(description, [key]) === null || finiteAttr(description, key) !== undefined;
    })
  );
}

const MAPLE_OPERATIONS: Readonly<Record<string, { mode: number; combine: MaskCombine }>> = {
  Add: { mode: 0, combine: 'add' },
  Subtract: { mode: 1, combine: 'subtract' },
  Intersect: { mode: 1, combine: 'intersect' },
};

function adobeOperation(mode: number, value: number, inverted: boolean): MaskCombine | undefined {
  switch (`${mode}:${value}`) {
    case '0:1':
      return 'add';
    case '1:0':
      return inverted ? 'intersect' : 'subtract';
    default:
      return undefined;
  }
}

export function groupComponentOperation(
  leaf: Element,
): Pick<MaskComponent, 'combine' | 'invert'> | undefined {
  const mode = finiteAttr(leaf, 'crs:MaskBlendMode') ?? 0;
  const value = finiteAttr(leaf, 'crs:MaskValue') ?? 1;
  const inverted = xmpBool(attrOf(leaf, ['crs:MaskInverted'])) ?? false;
  const adobe = adobeOperation(mode, value, inverted);
  if (!adobe) return undefined;
  const maple = attrOf(leaf, ['papp:MaskCombine']);
  const explicit = maple === null ? undefined : MAPLE_OPERATIONS[maple];
  if (maple !== null && explicit?.mode !== mode) return undefined;
  const combine = explicit?.combine ?? adobe;
  return { combine, invert: inverted !== (combine === 'intersect') };
}
