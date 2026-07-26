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
// rather than the single-value drag bar (#638). Vignette/Grain/ColorGrade/HSL
// are wired (#1109/#1110/#275/#1112). Color Grading supersedes the old Split
// Tone pill the way Lightroom's Color Grading panel superseded Split Toning:
// one tool, four wheels, and the shadow/highlight hue+sat pairs are still the
// `splitTone*` fields ACR writes to `crs:SplitToning*`.
// Presets (#1115) is wired: the pill opens the presets sheet/popover
// instead of carrying a drag-bar value.
//
// One deliberate divergence from the Apple enum, recorded here so it isn't
// folklore: Apple gained a `Tool.toneCurve` case in #367 and there is no
// `'toneCurve'` ToolId to match it. The two shells reach the same panel by
// different routes. `EditorShellComponent` already owns a first-class curve
// panel with its own dock toggle (`curvePanelToggle` / `curveOpen`), so the
// tone curve is not a tool the drag bar can arm here. Apple has no such
// standalone panel — every one of its control variants swaps surfaces off
// `armedTool` — so an armed tool is the only way to reach the curve there.
// Adding a dead `'toneCurve'` ToolId to mirror the enum shape would put an
// unreachable entry in the dock and the `[`/`]` cycle for no gain.

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
  | 'bwMix'
  // Effects
  | 'clarity'
  | 'texture'
  | 'dehaze'
  | 'vignette'
  | 'grain'
  | 'colorGrade'
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
  bwMix: 'B&W',
  clarity: 'Clarity',
  texture: 'Texture',
  dehaze: 'Dehaze',
  vignette: 'Vignette',
  grain: 'Grain',
  colorGrade: 'Color Grading',
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
  // bwMix (#276) joins Color directly after hsl: both drive the same
  // 8-hue-band Oklab stage, exclusively — HSL edits per-hue color, bwMix
  // (Black & White) collapses it to monochrome via 8 gray-mixer weights.
  color: ['temp', 'tint', 'vibrance', 'saturation', 'hsl', 'bwMix'],
  effects: ['clarity', 'texture', 'dehaze', 'vignette', 'grain', 'colorGrade'],
  detail: ['sharpen', 'noise', 'colorNR', 'crop', 'presets'],
};

export const ALL_TOOLS: readonly ToolId[] = Object.values(TOOLS_IN_GROUP).flat();

export function groupOf(tool: ToolId): ToolGroup {
  for (const g of Object.keys(TOOLS_IN_GROUP) as ToolGroup[]) {
    if (TOOLS_IN_GROUP[g].includes(tool)) return g;
  }
  throw new Error(`unknown tool: ${tool}`);
}

/**
 * Tools visible in a group given the current model state (#276). Only the
 * Color group is state-dependent: while Black & White is On, HSL is hidden
 * from every tool-listing surface (dock entries, keyboard `[`/`]` cycling)
 * — the 24 HSL hue/sat/lum sliders are inert while B&W drives the same
 * 8-band Oklab stage through its gray-mixer weights instead. `bwMix` stays
 * visible regardless of state; it's the surface that owns the toggle.
 */
export function visibleToolsInGroup(group: ToolGroup, blackWhiteOn: boolean): readonly ToolId[] {
  const tools = TOOLS_IN_GROUP[group];
  if (group !== 'color' || !blackWhiteOn) return tools;
  return tools.filter((t) => t !== 'hsl');
}

// The S5 effects pills are all real pipeline stages now — vignette (#1109),
// grain (#1110), colorGrade (#1111, extended to four wheels at #275) left the
// #952 stub list as their stages
// landed. HSL left at #1112: 24 sub-params wired, stage live in raw-gpu.
// bwMix (#276) is likewise fully wired: the toggle + 8 gray-mixer sub-params
// write real AdjustmentModel fields through the shared multi-param arming
// machinery — it just has no single primary drag-bar field, like HSL.
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
  // Color grading (#275) — wired; the drag bar drives `splitToneBalance`
  // (the schema-declared primary; symmetric [-100, 100], default arm). The
  // twelve wheel values ride the sub-param row and the wheel panel.
  colorGrade: ADJUSTMENT_RANGES.splitToneBalance,
  // hsl has no single primary drag-bar field (24 sub-params via the chip
  // row); bwMix likewise (#276, toggle + 8 gray-mixer sub-params); crop is
  // a stub (#638); presets is value-less (#1115) — no entries here, the
  // identity mapping keeps their chips at 0.
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
    // S5 effects (#1109 / #1110 / #275) — wired; the drag bars drive
    // each tool's primary sub-param.
    case 'vignette':
      return 'vignetteAmount';
    case 'grain':
      return 'grainAmount';
    case 'colorGrade':
      return 'splitToneBalance';
    // hsl has 24 sub-params but no single primary drag-bar field — the
    // sub-param chip row drives individual fields. bwMix is the same shape
    // (#276: toggle + 8 gray-mixer sub-params). crop is a stub (#638).
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
