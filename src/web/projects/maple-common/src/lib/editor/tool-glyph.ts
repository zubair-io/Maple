// tool-glyph.ts — responsive-program S5c (#625).
//
// Tool → MapleIcon name mapping. The glyphs themselves live in
// `icons/maple-icon-registry.ts` (one entry per tool). This file is a
// thin lookup so the editor's tool pill row can render `<maple-icon
// [name]="iconFor(tool)">` without caring about the registry layout.

import type { MapleIconName } from '../icons/maple-icon-registry';
import type { ToolId } from './tool-model';

const TOOL_TO_ICON: Record<ToolId, MapleIconName> = {
  exposure: 'tool-exposure',
  brightness: 'tool-brightness',
  contrast: 'tool-contrast',
  highlights: 'tool-highlights',
  shadows: 'tool-shadows',
  whites: 'tool-whites',
  blacks: 'tool-blacks',
  temp: 'tool-temp',
  tint: 'tool-tint',
  vibrance: 'tool-vibrance',
  saturation: 'tool-saturation',
  hsl: 'tool-hsl',
  bwMix: 'tool-bw',
  clarity: 'tool-clarity',
  texture: 'tool-texture',
  dehaze: 'tool-dehaze',
  vignette: 'tool-vignette',
  grain: 'tool-grain',
  colorGrade: 'tool-color-grade',
  sharpen: 'tool-sharpen',
  noise: 'tool-noise',
  colorNR: 'tool-color-nr',
  crop: 'tool-crop',
  presets: 'tool-presets',
};

export function iconFor(tool: ToolId): MapleIconName {
  return TOOL_TO_ICON[tool];
}
