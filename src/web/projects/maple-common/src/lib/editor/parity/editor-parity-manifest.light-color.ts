// editor-parity-manifest.light-color.ts — the Light and Color tool rows of
// the editor parity manifest (#2448). See `editor-parity-manifest.tools.ts`
// for how the tool rows relate to the two tool enumerations.

import type { ParityCapability } from './editor-parity-types';
import {
  BOTH,
  CHIP_ROW_A11Y,
  CHIP_ROW_INTERACTION,
  PARTICIPATION,
  SUBTOOL_CHIP,
  panelTool,
  sliderTool,
} from './editor-parity-manifest.builders';

export const LIGHT_TOOLS: readonly ParityCapability[] = [
  sliderTool({
    id: 'exposure',
    name: 'Exposure',
    group: 'light',
    order: 10,
    field: 'exposure',
    units: 'EV',
    copyPaste: 'tone',
  }),
  sliderTool({
    id: 'brightness',
    name: 'Brightness',
    group: 'light',
    order: 20,
    field: 'brightness',
    units: '±100',
    copyPaste: 'tone',
  }),
  sliderTool({
    id: 'contrast',
    name: 'Contrast',
    group: 'light',
    order: 30,
    field: 'contrast',
    units: '±100',
    copyPaste: 'tone',
  }),
  sliderTool({
    id: 'highlights',
    name: 'Highlights',
    group: 'light',
    order: 40,
    field: 'highlights',
    units: '±100',
    copyPaste: 'tone',
  }),
  sliderTool({
    id: 'shadows',
    name: 'Shadows',
    group: 'light',
    order: 50,
    field: 'shadows',
    units: '±100',
    copyPaste: 'tone',
  }),
  sliderTool({
    id: 'whites',
    name: 'Whites',
    group: 'light',
    order: 60,
    field: 'whites',
    units: '±100',
    copyPaste: 'tone',
  }),
  sliderTool({
    id: 'blacks',
    name: 'Blacks',
    group: 'light',
    order: 70,
    field: 'blacks',
    units: '±100',
    copyPaste: 'tone',
  }),
  // Apple-only `Tool` case: on web the same panel is a dock toggle
  // (`curvePanelToggle` / `curveOpen`), not an armable tool — see the
  // header notes in tool-model.ts / ToolModel.swift.
  {
    id: 'tool.toneCurve',
    name: 'Tone Curve',
    group: 'light',
    order: 80,
    tool: { web: null, apple: 'toneCurve' },
    field: null,
    reachability: BOTH,
    presentation: {
      compact:
        'Web: Curve dock entry opens the tone-curve + WB pad panel above the bottom dock. Apple: armed tool, ToneCurveSection is the control surface',
      regular:
        'Web: Curve dock entry toggles a 240px glass panel beside the dock (curve + WB pad). Apple: armed tool via the dock',
      wide: 'Same as regular',
    },
    interaction: {
      keyboard:
        'Web: dock entry via Tab + Enter; control points are pointer-only on both platforms',
      pointer:
        'Drag control points; click adds a point; the parametric region sliders ride the ordinary slider contract',
      touch: 'Same drag; region sliders take long-press fine mode',
      focus:
        'The curve plot consumes its own pointer stream; keyboard shortcuts still reach the shell',
    },
    accessibility: {
      role: 'button (dock entry, aria-pressed) + slider (parametric regions)',
      name: 'Tone Curve',
      value: 'Region sliders expose aria-valuenow; the point curve has no accessible value',
      state: 'aria-pressed reflects the open panel',
      actions: ['open / close the panel', 'adjust a parametric region', 'move a control point'],
    },
    participation: PARTICIPATION('tone'),
    exception: null,
    featuresRow: 'Tone curve (point)',
  },
];

export const COLOR_TOOLS: readonly ParityCapability[] = [
  sliderTool({
    id: 'temp',
    name: 'Temp',
    group: 'color',
    order: 10,
    field: 'temperature',
    units: 'K',
    copyPaste: 'white_balance',
  }),
  sliderTool({
    id: 'tint',
    name: 'Tint',
    group: 'color',
    order: 20,
    field: 'tint',
    units: '±150',
    copyPaste: 'white_balance',
  }),
  sliderTool({
    id: 'vibrance',
    name: 'Vibrance',
    group: 'color',
    order: 30,
    field: 'vibrance',
    units: '±100',
    copyPaste: 'color',
  }),
  sliderTool({
    id: 'saturation',
    name: 'Saturation',
    group: 'color',
    order: 40,
    field: 'saturation',
    units: '±100',
    copyPaste: 'color',
  }),
  panelTool({
    id: 'hsl',
    name: 'HSL',
    group: 'color',
    order: 50,
    copyPaste: 'color',
    presentation: SUBTOOL_CHIP('Color', 'HSL'),
    interaction: CHIP_ROW_INTERACTION,
    accessibility: CHIP_ROW_A11Y('HSL'),
    featuresRow: 'HSL / B&W mixer',
  }),
  panelTool({
    id: 'bwMix',
    name: 'B&W',
    group: 'color',
    order: 60,
    copyPaste: 'color',
    presentation: SUBTOOL_CHIP('Color', 'B&W'),
    interaction: {
      ...CHIP_ROW_INTERACTION,
      pointer: `Black & White switch toggles the mode; ${CHIP_ROW_INTERACTION.pointer}`,
    },
    accessibility: {
      ...CHIP_ROW_A11Y('Black & White'),
      role: 'switch (Black & White) + group (gray-mixer chips) + slider (drag bar)',
      state: 'aria-checked on the switch; the gray-mixer sliders are aria-disabled while Off',
    },
    featuresRow: 'HSL / B&W mixer',
  }),
];
