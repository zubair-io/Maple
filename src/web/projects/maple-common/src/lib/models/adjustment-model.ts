// AdjustmentModel — per-asset develop settings.
// All 20 sliders across 5 sections + white balance preset.

export type WhiteBalancePreset =
  | 'As Shot'
  | 'Auto'
  | 'Daylight'
  | 'Cloudy'
  | 'Shade'
  | 'Tungsten'
  | 'Fluorescent'
  | 'Flash'
  | 'Custom';

export interface AdjustmentModel {
  // Tone
  exposure: number; // -4..+4 EV
  contrast: number; // -100..100
  highlights: number; // -100..100
  shadows: number; // -100..100
  whites: number; // -100..100
  blacks: number; // -100..100
  // White balance
  temperature: number; // 2000..12000 K
  tint: number; // -100..100
  whiteBalancePreset: WhiteBalancePreset;
  // Presence
  vibrance: number; // -100..100
  saturation: number; // -100..100
  clarity: number; // -100..100
  texture: number; // -100..100
  dehaze: number; // -100..100
  // Sharpening
  sharpenAmount: number; // 0..150
  sharpenRadius: number; // 0.5..3.0
  sharpenDetail: number; // 0..100
  sharpenMasking: number; // 0..100
  // Noise reduction
  nrLuminance: number; // 0..100
  nrColor: number; // 0..100
}

export function defaultAdjustmentModel(): AdjustmentModel {
  return {
    exposure: 0,
    contrast: 0,
    highlights: 0,
    shadows: 0,
    whites: 0,
    blacks: 0,
    temperature: 6500,
    tint: 0,
    whiteBalancePreset: 'As Shot',
    vibrance: 0,
    saturation: 0,
    clarity: 0,
    texture: 0,
    dehaze: 0,
    sharpenAmount: 0,
    sharpenRadius: 0.5,
    sharpenDetail: 25,
    sharpenMasking: 0,
    nrLuminance: 0,
    nrColor: 25,
  };
}

export function isDefaultAdjustment(m: AdjustmentModel): boolean {
  const d = defaultAdjustmentModel();
  return (Object.keys(d) as Array<keyof AdjustmentModel>).every((k) => m[k] === d[k]);
}
