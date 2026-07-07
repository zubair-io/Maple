// tool-model.ts — responsive-program S5c (#625).
//
// 23 tools grouped per S5 spec §2 (+ Brightness, #1108 / tone-zoom spec
// §10.0) + value mapping per spec §3. Mirrors the Apple `Tool` enum +
// `ToolValueMapping` in
// `src/apple/Packages/MapleCore/Sources/MapleCore/Editor/EditorState.swift`.
// Multi-param pills (noise, sharpen) declare sub-params in
// `tool-sub-param.ts`; the mappings here remain their FIRST sub-param's
// (the drag-bar default), so single-param call sites are unchanged.
//
// Crop renders in the pill row but rejects DRAG-BAR writes (see STUB_TOOLS):
// its model field + pipeline math exist (#277), and it's edited through the
// interactive canvas overlay (`CropOverlayComponent`) + `CropToolbarComponent`
// rather than the single-value drag bar (#638). Vignette/Grain/SplitTone/HSL
// are wired (#1109/#1110/#1111/#1112).
// Presets (#1115) is wired: the pill opens the presets sheet/popover
// instead of carrying a drag-bar value.

import type { AdjustmentModel } from '../models/adjustment-model';
import { ADJUSTMENT_RANGES, defaultGeneratedAdjustmentModel } from '../models/adjustment-model';

export type ToolGroup = 'light' | 'color' | 'effects' | 'detail';

export type ToolId =
  // Light
  | 'exposure'
  | 'brightness'
  | 'contrast'
  | 'highlights'
  | 'shadows'
  | 'whites'
  | 'blacks'
  // Color
  | 'temp'
  | 'tint'
  | 'vibrance'
  | 'saturation'
  | 'hsl'
  // Effects
  | 'clarity'
  | 'texture'
  | 'dehaze'
  | 'vignette'
  | 'grain'
  | 'splitTone'
  // Detail
  | 'sharpen'
  | 'noise'
  | 'colorNR'
  | 'crop'
  | 'presets';

export const TOOL_GROUP_DISPLAY: Record<ToolGroup, string> = {
  light: 'Light',
  color: 'Color',
  effects: 'Effects',
  detail: 'Detail',
};

export const TOOL_DISPLAY: Record<ToolId, string> = {
  exposure: 'Exposure',
  brightness: 'Brightness',
  contrast: 'Contrast',
  highlights: 'Highlights',
  shadows: 'Shadows',
  whites: 'Whites',
  blacks: 'Blacks',
  temp: 'Temp',
  tint: 'Tint',
  vibrance: 'Vibrance',
  saturation: 'Saturation',
  hsl: 'HSL',
  clarity: 'Clarity',
  texture: 'Texture',
  dehaze: 'Dehaze',
  vignette: 'Vignette',
  grain: 'Grain',
  splitTone: 'Split Tone',
  sharpen: 'Sharpen',
  noise: 'Noise',
  colorNR: 'Color NR',
  crop: 'Crop',
  presets: 'Presets',
};

export const TOOLS_IN_GROUP: Record<ToolGroup, readonly ToolId[]> = {
  // Brightness (#1102 midtone-band gain) joins Light per spec §10.0
  // ("between Exposure and Highlights" — placed directly after Exposure,
  // matching the scene_tone_controls pipeline order exposure → brightness).
  light: ['exposure', 'brightness', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'],
  color: ['temp', 'tint', 'vibrance', 'saturation', 'hsl'],
  effects: ['clarity', 'texture', 'dehaze', 'vignette', 'grain', 'splitTone'],
  detail: ['sharpen', 'noise', 'colorNR', 'crop', 'presets'],
};

export const ALL_TOOLS: readonly ToolId[] = Object.values(TOOLS_IN_GROUP).flat();

export function groupOf(tool: ToolId): ToolGroup {
  for (const g of Object.keys(TOOLS_IN_GROUP) as ToolGroup[]) {
    if (TOOLS_IN_GROUP[g].includes(tool)) return g;
  }
  throw new Error(`unknown tool: ${tool}`);
}

// The S5 effects pills are all real pipeline stages now — vignette (#1109),
// grain (#1110), splitTone (#1111) left the #952 stub list as their stages
// landed. HSL left at #1112: 24 sub-params wired, stage live in raw-gpu.
// Crop (#638) stays in the stub set so the DRAG BAR rejects writes, but it is
// fully interactive via the canvas crop overlay (the pill arms crop mode; the
// overlay + crop toolbar drive `model.crop`).
// Presets left the stub list at #1115: the pill (retired S5 editor) / dock
// entry (canvas-first editor, #1815) opens the presets sheet/popover/panel —
// it has no drag-bar value, so `fieldFor` stays null and the value pipe is
// inert.
const STUB_TOOLS = new Set<ToolId>(['crop']);

export function isWired(tool: ToolId): boolean {
  return !STUB_TOOLS.has(tool);
}

// MARK: - Value mapping ([-100, +100] internal ↔ tool display range)

/** Display range for the wired tools, sourced from the generated
 *  `ADJUSTMENT_RANGES` (raw-core) via each tool's mapped field, so the
 *  drag-bar bounds can't drift from the canonical schema. */
const DISPLAY_RANGE: Partial<Record<ToolId, readonly [number, number]>> = {
  exposure: ADJUSTMENT_RANGES.exposure,
  brightness: ADJUSTMENT_RANGES.brightness,
  temp: ADJUSTMENT_RANGES.temperature,
  tint: ADJUSTMENT_RANGES.tint,
  contrast: ADJUSTMENT_RANGES.contrast,
  highlights: ADJUSTMENT_RANGES.highlights,
  shadows: ADJUSTMENT_RANGES.shadows,
  whites: ADJUSTMENT_RANGES.whites,
  blacks: ADJUSTMENT_RANGES.blacks,
  vibrance: ADJUSTMENT_RANGES.vibrance,
  saturation: ADJUSTMENT_RANGES.saturation,
  clarity: ADJUSTMENT_RANGES.clarity,
  texture: ADJUSTMENT_RANGES.texture,
  dehaze: ADJUSTMENT_RANGES.dehaze,
  sharpen: ADJUSTMENT_RANGES.sharpenAmount,
  noise: ADJUSTMENT_RANGES.nrLuminance,
  colorNR: ADJUSTMENT_RANGES.nrColor,
  // Vignette (#1109) — wired; the drag bar drives `vignetteAmount` (the
  // first sub-param; feather rides the sub-param row). The symmetric
  // [-100, 100] range takes the default `(v/100)·hi` mapping arm.
  vignette: ADJUSTMENT_RANGES.vignetteAmount,
  // Grain (#1110) — wired; the drag bar drives `grainAmount` (one-sided
  // 0..100, the noise/colorNR affine family).
  grain: ADJUSTMENT_RANGES.grainAmount,
  // Split tone (#1111) — wired; the drag bar drives `splitToneBalance`
  // (the schema-declared primary; symmetric [-100, 100], default arm).
  splitTone: ADJUSTMENT_RANGES.splitToneBalance,
  // hsl has no single primary drag-bar field (24 sub-params via the chip
  // row); crop is a stub (#638); presets is value-less (#1115) — no
  // entries here, the identity mapping keeps their chips at 0.
};

export function displayRange(tool: ToolId): readonly [number, number] | null {
  return DISPLAY_RANGE[tool] ?? null;
}

export function displayValueFromInternal(tool: ToolId, v: number): number {
  const r = DISPLAY_RANGE[tool];
  if (!r) return v;
  if (tool === 'temp') {
    return v >= 0 ? 6500 + (v / 100) * (12000 - 6500) : 6500 + (v / 100) * (6500 - 2000);
  }
  if (tool === 'sharpen') {
    return v >= 0 ? 40 + (v / 100) * (150 - 40) : 40 + (v / 100) * 40;
  }
  if (tool === 'noise' || tool === 'colorNR' || tool === 'grain') {
    const [lo, hi] = r;
    return lo + ((v + 100) / 200) * (hi - lo);
  }
  return (v / 100) * r[1];
}

export function internalValueFromDisplay(tool: ToolId, d: number): number {
  const r = DISPLAY_RANGE[tool];
  if (!r) return d;
  if (tool === 'temp') {
    return d >= 6500 ? ((d - 6500) / (12000 - 6500)) * 100 : ((d - 6500) / (6500 - 2000)) * 100;
  }
  if (tool === 'sharpen') {
    return d >= 40 ? ((d - 40) / (150 - 40)) * 100 : ((d - 40) / 40) * 100;
  }
  if (tool === 'noise' || tool === 'colorNR' || tool === 'grain') {
    const [lo, hi] = r;
    return ((d - lo) / (hi - lo)) * 200 - 100;
  }
  return (d / r[1]) * 100;
}

/** Field name on AdjustmentModel for a wired tool. `null` for stubs. */
export function fieldFor(tool: ToolId): keyof AdjustmentModel | null {
  switch (tool) {
    case 'exposure':
      return 'exposure';
    case 'brightness':
      return 'brightness';
    case 'contrast':
      return 'contrast';
    case 'highlights':
      return 'highlights';
    case 'shadows':
      return 'shadows';
    case 'whites':
      return 'whites';
    case 'blacks':
      return 'blacks';
    case 'temp':
      return 'temperature';
    case 'tint':
      return 'tint';
    case 'vibrance':
      return 'vibrance';
    case 'saturation':
      return 'saturation';
    case 'clarity':
      return 'clarity';
    case 'texture':
      return 'texture';
    case 'dehaze':
      return 'dehaze';
    case 'sharpen':
      return 'sharpenAmount';
    case 'noise':
      return 'nrLuminance';
    case 'colorNR':
      return 'nrColor';
    // S5 effects (#1109 / #1110 / #1111) — wired; the drag bars drive
    // each tool's primary sub-param.
    case 'vignette':
      return 'vignetteAmount';
    case 'grain':
      return 'grainAmount';
    case 'splitTone':
      return 'splitToneBalance';
    // hsl has 24 sub-params but no single primary drag-bar field — the
    // sub-param chip row drives individual fields. crop is a stub (#638).
    // presets is wired but value-less (#1115). All return null so no
    // single XMP field is written and no modified-dot fires at this level.
    default:
      return null;
  }
}

/** Canonical raw-core defaults, read once so per-tool default lookups
 *  can't drift from the generated schema. */
const GENERATED_DEFAULTS = defaultGeneratedAdjustmentModel();

/** Canonical default display value per tool, sourced from the generated
 *  `defaultGeneratedAdjustmentModel()` field defaults (e.g. Color NR = 25,
 *  Sharpen = 40, Temp = 6500). Used by reset semantics and by the
 *  modified-dot check, so a default asset never reads as "modified". */
export function defaultDisplayValue(tool: ToolId): number {
  const field = fieldFor(tool);
  if (!field) return 0;
  const v = GENERATED_DEFAULTS[field as keyof typeof GENERATED_DEFAULTS];
  return typeof v === 'number' ? v : 0;
}
