// tool-model.ts — responsive-program S5c (#625).
//
// 22 tools grouped per S5 spec §2 + value mapping per spec §3. Mirrors
// the Apple `Tool` enum + `ToolValueMapping` in
// `src/apple/Packages/MapleCore/Sources/MapleCore/Editor/EditorState.swift`.
//
// Stub tools (HSL/Vignette/Grain/SplitTone/Crop/Presets) ship without a
// wired AdjustmentModel field in v0.1 — they render in the pill row but
// reject writes. Follow-up tickets expand AdjustmentModel.

import type { AdjustmentModel } from '../models/adjustment-model';

export type ToolGroup = 'light' | 'color' | 'effects' | 'detail';

export type ToolId =
  // Light
  | 'exposure'
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
  light: ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'],
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

const STUB_TOOLS = new Set<ToolId>(['hsl', 'vignette', 'grain', 'splitTone', 'crop', 'presets']);

export function isWired(tool: ToolId): boolean {
  return !STUB_TOOLS.has(tool);
}

// MARK: - Value mapping ([-100, +100] internal ↔ tool display range)

/** Display range for the wired tools. */
const DISPLAY_RANGE: Partial<Record<ToolId, readonly [number, number]>> = {
  exposure: [-4, 4],
  temp: [2000, 12000],
  tint: [-100, 100],
  contrast: [-100, 100],
  highlights: [-100, 100],
  shadows: [-100, 100],
  whites: [-100, 100],
  blacks: [-100, 100],
  vibrance: [-100, 100],
  saturation: [-100, 100],
  clarity: [-100, 100],
  texture: [-100, 100],
  dehaze: [-100, 100],
  sharpen: [0, 150],
  noise: [0, 100],
  colorNR: [0, 100],
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
  if (tool === 'noise' || tool === 'colorNR') {
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
  if (tool === 'noise' || tool === 'colorNR') {
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
    default:
      return null;
  }
}

/** Canonical default display value per tool. Matches the generated
 *  `defaultGeneratedAdjustmentModel()` field defaults (e.g. Color NR = 25,
 *  Sharpen = 40, Temp = 6500). Used by reset semantics and by the
 *  modified-dot check, so a default asset never reads as "modified". */
export function defaultDisplayValue(tool: ToolId): number {
  switch (tool) {
    case 'temp':
      return 6500;
    case 'sharpen':
      return 40;
    case 'colorNR':
      return 25;
    default:
      return 0;
  }
}
