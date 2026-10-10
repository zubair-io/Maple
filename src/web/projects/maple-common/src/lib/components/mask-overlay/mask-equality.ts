// mask-equality.ts — fast structural equality for local adjustments (#4416).
//
// Replaces `JSON.stringify` over large dab arrays during brush painting so that
// pointermove events evaluate identity in nanoseconds rather than serializing
// thousands of dabs into strings on every frame.

import type {
  BitmapMask,
  BrushMask,
  LinearMask,
  LocalAdjustment,
  LocalMask,
  MaskGroup,
  PartialAdjustments,
  RadialMask,
  RangeRefinement,
} from '../../models/local-adjustment';

function isSameAdjustments(a: PartialAdjustments, b: PartialAdjustments): boolean {
  if (a === b) return true;
  const aKeys = Object.keys(a) as Array<keyof PartialAdjustments>;
  const bKeys = Object.keys(b) as Array<keyof PartialAdjustments>;
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

function isSameRange(a?: RangeRefinement, b?: RangeRefinement): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.kind === b.kind &&
    a.hueDeg === b.hueDeg &&
    a.hueHalfWidthDeg === b.hueHalfWidthDeg &&
    a.chromaMin === b.chromaMin &&
    a.lMin === b.lMin &&
    a.lMax === b.lMax &&
    a.feather === b.feather
  );
}

function isSameMask(a: LocalMask, b: LocalMask): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'brush': {
      const bBrush = b as BrushMask;
      return (
        a.rasterId === bBrush.rasterId &&
        a.digest === bBrush.digest &&
        a.dabs.length === bBrush.dabs.length &&
        (a.dabs === bBrush.dabs || a.digest !== '' || a.dabs.length === 0)
      );
    }
    case 'linear': {
      const bLinear = b as LinearMask;
      return (
        a.start.x === bLinear.start.x &&
        a.start.y === bLinear.start.y &&
        a.end.x === bLinear.end.x &&
        a.end.y === bLinear.end.y &&
        a.feather === bLinear.feather
      );
    }
    case 'radial': {
      const bRadial = b as RadialMask;
      return (
        a.center.x === bRadial.center.x &&
        a.center.y === bRadial.center.y &&
        a.radii.x === bRadial.radii.x &&
        a.radii.y === bRadial.radii.y &&
        a.angle === bRadial.angle &&
        a.feather === bRadial.feather &&
        a.invert === bRadial.invert
      );
    }
    case 'bitmap':
      return a.rasterId === (b as BitmapMask).rasterId;
    case 'everywhere':
      return true;
    case 'group': {
      const bGroup = b as MaskGroup;
      if (a.opacity !== bGroup.opacity || a.invert !== bGroup.invert) return false;
      if (a.components.length !== bGroup.components.length) return false;
      for (let i = 0; i < a.components.length; i++) {
        const ac = a.components[i];
        const bc = bGroup.components[i];
        if (ac.combine !== bc.combine || ac.invert !== bc.invert) return false;
        if (!isSameMask(ac.mask, bc.mask)) return false;
      }
      return true;
    }
  }
}

/** Fast structural equality for one layer — avoiding JSON.stringify on brush dab arrays (#4416). */
export function isSameLayer(a: LocalAdjustment, b: LocalAdjustment): boolean {
  if (a === b) return true;
  if (a.xmpGroupSlot !== b.xmpGroupSlot) return false;
  if (!isSameAdjustments(a.adjustments, b.adjustments)) return false;
  if (!isSameRange(a.range, b.range)) return false;
  return isSameMask(a.mask, b.mask);
}
