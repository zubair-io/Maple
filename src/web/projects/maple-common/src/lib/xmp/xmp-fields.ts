// xmp-fields.ts — bidirectional field mapping table for AdjustmentModel ↔ XMP crs: attributes.
//
// Each entry describes one XMP attribute:
//   xmpKey       — the XML attribute name as written in the sidecar (e.g. 'crs:Exposure2012')
//   modelKey     — the AdjustmentModel property it maps to
//   serialize    — converts the model value to a string for the XML attribute
//   parse        — converts the XML attribute string to a model value
//   defaultValue — the "unset" sentinel; fields matching the default are omitted on write

import type { AdjustmentModel, WhiteBalancePreset } from '../models/adjustment-model';

/**
 * Bidirectional mapping for a single XMP attribute. `K` is the key in
 * `AdjustmentModel`; the serializer/parser/default are tied to its value type,
 * so every entry in `ADJUSTMENT_FIELDS` is statically type-checked.
 */
export interface XmpFieldMapping<K extends keyof AdjustmentModel = keyof AdjustmentModel> {
  xmpKey: string;
  modelKey: K;
  serialize: (value: AdjustmentModel[K]) => string;
  parse: (str: string) => AdjustmentModel[K];
  defaultValue: (m: AdjustmentModel) => AdjustmentModel[K];
}

/** Keys whose values are numeric adjustment sliders (all fields except the WB preset). */
export type NumericAdjustmentKey = {
  [K in keyof AdjustmentModel]: AdjustmentModel[K] extends number ? K : never;
}[keyof AdjustmentModel];

const numericSerializer = (v: number): string => {
  if (Number.isInteger(v)) return String(v);
  const rounded = Math.round(v * 100) / 100;
  return rounded.toString();
};

const numericParser = (s: string): number => Number(s);

export const ADJUSTMENT_FIELDS: XmpFieldMapping<NumericAdjustmentKey>[] = [
  {
    xmpKey: 'crs:Temperature',
    modelKey: 'temperature',
    serialize: numericSerializer,
    parse: numericParser,
    defaultValue: () => 6500,
  },
  {
    xmpKey: 'crs:Tint',
    modelKey: 'tint',
    serialize: numericSerializer,
    parse: numericParser,
    defaultValue: () => 0,
  },
  {
    xmpKey: 'crs:Exposure2012',
    modelKey: 'exposure',
    serialize: numericSerializer,
    parse: numericParser,
    defaultValue: () => 0,
  },
  {
    xmpKey: 'crs:Contrast2012',
    modelKey: 'contrast',
    serialize: numericSerializer,
    parse: numericParser,
    defaultValue: () => 0,
  },
  {
    xmpKey: 'crs:Highlights2012',
    modelKey: 'highlights',
    serialize: numericSerializer,
    parse: numericParser,
    defaultValue: () => 0,
  },
  {
    xmpKey: 'crs:Shadows2012',
    modelKey: 'shadows',
    serialize: numericSerializer,
    parse: numericParser,
    defaultValue: () => 0,
  },
  {
    xmpKey: 'crs:Whites2012',
    modelKey: 'whites',
    serialize: numericSerializer,
    parse: numericParser,
    defaultValue: () => 0,
  },
  {
    xmpKey: 'crs:Blacks2012',
    modelKey: 'blacks',
    serialize: numericSerializer,
    parse: numericParser,
    defaultValue: () => 0,
  },
  {
    xmpKey: 'crs:Vibrance',
    modelKey: 'vibrance',
    serialize: numericSerializer,
    parse: numericParser,
    defaultValue: () => 0,
  },
  {
    xmpKey: 'crs:Saturation',
    modelKey: 'saturation',
    serialize: numericSerializer,
    parse: numericParser,
    defaultValue: () => 0,
  },
  {
    xmpKey: 'crs:Clarity2012',
    modelKey: 'clarity',
    serialize: numericSerializer,
    parse: numericParser,
    defaultValue: () => 0,
  },
  {
    xmpKey: 'crs:Texture',
    modelKey: 'texture',
    serialize: numericSerializer,
    parse: numericParser,
    defaultValue: () => 0,
  },
  {
    xmpKey: 'crs:Dehaze',
    modelKey: 'dehaze',
    serialize: numericSerializer,
    parse: numericParser,
    defaultValue: () => 0,
  },
  {
    xmpKey: 'crs:Sharpness',
    modelKey: 'sharpenAmount',
    serialize: numericSerializer,
    parse: numericParser,
    defaultValue: () => 0,
  },
  {
    xmpKey: 'crs:SharpenRadius',
    modelKey: 'sharpenRadius',
    serialize: numericSerializer,
    parse: numericParser,
    defaultValue: () => 0.5,
  },
  {
    xmpKey: 'crs:SharpenDetail',
    modelKey: 'sharpenDetail',
    serialize: numericSerializer,
    parse: numericParser,
    defaultValue: () => 25,
  },
  {
    xmpKey: 'crs:SharpenEdgeMasking',
    modelKey: 'sharpenMasking',
    serialize: numericSerializer,
    parse: numericParser,
    defaultValue: () => 0,
  },
  {
    xmpKey: 'crs:LuminanceSmoothing',
    modelKey: 'nrLuminance',
    serialize: numericSerializer,
    parse: numericParser,
    defaultValue: () => 0,
  },
  {
    xmpKey: 'crs:ColorNoiseReduction',
    modelKey: 'nrColor',
    serialize: numericSerializer,
    parse: numericParser,
    defaultValue: () => 25,
  },
];

/** WhiteBalance preset — serialized as a string attribute, not a number. */
export const WB_PRESET_FIELD = {
  xmpKey: 'crs:WhiteBalance',
  modelKey: 'whiteBalancePreset' as keyof AdjustmentModel,
};
