// editor-parity-manifest.effects-detail.ts — the Effects and Detail tool
// rows of the editor parity manifest (#2448). The two capture-sharpening
// rows used to be the manifest's one approved permanent platform exception;
// #3414 closed it by shipping the controls on web and Windows, so every row
// in this file is now released on both platforms.

import type { ParityCapability, ParityPresentation } from './editor-parity-types';
import {
  BOTH,
  CHIP_ROW_A11Y,
  CHIP_ROW_INTERACTION,
  PARTICIPATION,
  SUBTOOL_CHIP,
  panelTool,
  sliderTool,
} from './editor-parity-manifest.builders';

// Capture sharpening (#3414) is no longer a platform exception. The
// Richardson–Lucy stage runs at DECODE-PRODUCT cadence on every platform —
// Apple, web and Windows all bake it into the develop prefix and re-develop
// when either field moves — and `raw-gpu`'s WGSL port of the same kernel is
// parity-gated against `raw_core::stages::capture_sharpening`. Web reaches
// both fields through the Detail group's "Deconv" sub-tool chip; Apple keeps
// its two sibling pills.
const CAPTURE_PRESENTATION: ParityPresentation = {
  compact:
    'Detail sub-tool chip "Deconv" swaps the phone control card body for the chip row + drag bar; Apple: two Detail-group pills (Deconv, Deconv σ)',
  regular:
    'Detail sub-tool chip "Deconv" swaps the control card body for the chip row + drag bar; Apple: two Detail-group pills (Deconv, Deconv σ)',
  wide: 'Detail sub-tool chip "Deconv" swaps the control card body for the chip row + drag bar; Apple: two Detail-group pills (Deconv, Deconv σ)',
};

const CAPTURE_SIGMA_PRESENTATION: ParityPresentation = {
  compact: 'Sigma chip on the Deconv sub-param row; Apple: its own Detail-group pill',
  regular: 'Sigma chip on the Deconv sub-param row; Apple: its own Detail-group pill',
  wide: 'Sigma chip on the Deconv sub-param row; Apple: its own Detail-group pill',
};

export const EFFECTS_TOOLS: readonly ParityCapability[] = [
  sliderTool({
    id: 'clarity',
    name: 'Clarity',
    group: 'effects',
    order: 10,
    field: 'clarity',
    units: '±100',
    copyPaste: 'detail',
  }),
  sliderTool({
    id: 'texture',
    name: 'Texture',
    group: 'effects',
    order: 20,
    field: 'texture',
    units: '±100',
    copyPaste: 'detail',
  }),
  sliderTool({
    id: 'dehaze',
    name: 'Dehaze',
    group: 'effects',
    order: 30,
    field: 'dehaze',
    units: '±100',
    copyPaste: 'detail',
  }),
  sliderTool({
    id: 'vignette',
    name: 'Vignette',
    group: 'effects',
    order: 40,
    field: 'vignetteAmount',
    units: '±100',
    copyPaste: 'effects',
    subParams: 'Feather rides the sub-param chip row',
  }),
  sliderTool({
    id: 'grain',
    name: 'Grain',
    group: 'effects',
    order: 50,
    field: 'grainAmount',
    units: '0–100',
    copyPaste: 'effects',
    subParams: 'Size and Roughness ride the sub-param chip row',
  }),
  panelTool({
    id: 'colorGrade',
    name: 'Color Grading',
    group: 'effects',
    order: 60,
    copyPaste: 'color',
    // Balance is the schema-declared primary the drag bar drives; the twelve
    // wheel values ride the sub-param row (`fieldFor('colorGrade')`).
    field: 'splitToneBalance',
    presentation: SUBTOOL_CHIP('Effects', 'Grade'),
    interaction: {
      keyboard: 'Tab to a wheel or its luminance slider; arrow keys move the focused control',
      pointer:
        'Drag inside a wheel sets hue/saturation; the four luminance sliders and Balance take the slider contract',
      touch: 'Same drag; sliders take long-press fine mode',
      focus: 'A focused wheel or slider consumes its own arrow keys',
    },
    accessibility: {
      role: 'slider (per wheel axis, luminance, balance)',
      name: 'Shadows / Midtones / Highlights / Global hue, saturation, luminance; Balance',
      value:
        'aria-valuenow per slider in display units (hue 0–360, saturation 0–100, luminance ±100)',
      state: 'aria-disabled while value edits are refused',
      actions: ['adjust a wheel', 'adjust a luminance or balance slider', 'reset (double-click)'],
    },
    featuresRow: 'Color grading wheels',
  }),
  panelTool({
    id: 'filmLook',
    name: 'Film',
    group: 'effects',
    order: 70,
    copyPaste: 'effects',
    presentation: SUBTOOL_CHIP('Effects', 'Film'),
    interaction: {
      keyboard:
        'Tab through the catalog list; Enter picks a look; the Strength slider takes arrow keys',
      pointer: 'Click a look to apply it; drag Strength',
      touch: 'Tap a look; drag Strength with long-press fine mode',
      focus: 'The focused Strength slider consumes its own value keys',
    },
    accessibility: {
      role: 'listbox / option (catalog) + slider (Strength)',
      name: 'Film look; Strength',
      value: 'aria-selected on the chosen look; Strength aria-valuenow 0–100',
      state: 'aria-selected on the active look',
      actions: ['choose a look', 'clear the look', 'adjust strength'],
    },
    featuresRow: 'Film looks',
  }),
];

export const DETAIL_TOOLS: readonly ParityCapability[] = [
  sliderTool({
    id: 'sharpen',
    name: 'Sharpen',
    group: 'detail',
    order: 10,
    field: 'sharpenAmount',
    units: '0–150',
    copyPaste: 'detail',
    subParams: 'Radius, Detail and Masking ride the sub-param chip row',
  }),
  sliderTool({
    id: 'noise',
    name: 'Noise',
    group: 'detail',
    order: 20,
    field: 'nrLuminance',
    units: '0–100',
    copyPaste: 'detail',
    subParams:
      'Color, Deep and Prefilter ride the sub-param chip row; Deep and Prefilter commit on release (decode-product fields)',
    featuresRow: 'Deep denoise / chroma prefilter',
  }),
  sliderTool({
    id: 'colorNR',
    name: 'Color NR',
    group: 'detail',
    order: 30,
    field: 'nrColor',
    units: '0–100',
    copyPaste: 'detail',
  }),
  panelTool({
    id: 'captureSharpen',
    name: 'Deconv',
    group: 'detail',
    order: 40,
    copyPaste: 'detail',
    // Amount is the primary drag-bar field; Sigma rides the same chip row.
    field: 'captureSharpeningAmount',
    // Both fields sit inside the decode product, so the preview lands on
    // gesture release rather than per tick — the Deep / Prefilter contract.
    preview: 'commit-on-release',
    presentation: CAPTURE_PRESENTATION,
    interaction: CHIP_ROW_INTERACTION,
    accessibility: CHIP_ROW_A11Y('Deconv Amount; Deconv σ'),
    featuresRow: 'Capture sharpening (deconvolution)',
  }),
  {
    // Sigma has no web `ToolId` of its own: Apple declares a sibling
    // `Tool.captureSigma` pill, web reaches the same field through the Deconv
    // tool's sub-param chip row (`tool-sub-param.ts`, and the divergence note
    // in `tool-model.ts`'s header). Released on both platforms — the route
    // differs, the capability does not, so there is no exception to carry.
    id: 'tool.captureSigma',
    name: 'Deconv σ',
    group: 'detail',
    order: 50,
    tool: { web: null, apple: 'captureSigma' },
    field: 'captureSharpeningSigma',
    reachability: BOTH,
    presentation: CAPTURE_SIGMA_PRESENTATION,
    interaction: CHIP_ROW_INTERACTION,
    accessibility: CHIP_ROW_A11Y('Deconv σ'),
    participation: PARTICIPATION('detail', 'commit-on-release'),
    exception: null,
    featuresRow: 'Capture sharpening (deconvolution)',
  },
  panelTool({
    id: 'lensCorrections',
    name: 'Lens',
    group: 'detail',
    order: 60,
    copyPaste: 'detail',
    preview: 'commit-on-release',
    presentation: SUBTOOL_CHIP('Detail', 'Lens'),
    interaction: {
      keyboard: 'Tab to the master switch (Space toggles) or a scale slider (arrow keys)',
      pointer: 'Toggle the master switch; drag Distortion / CA / Vignetting',
      touch: 'Same; sliders take long-press fine mode',
      focus: 'A focused scale slider consumes its own value keys',
    },
    accessibility: {
      role: 'switch (profile enable) + slider (three scales)',
      name: 'Lens corrections; Distortion / Chromatic aberration / Vignetting',
      value: 'aria-checked on the switch; aria-valuenow 0–100 per scale',
      state: 'scales are aria-disabled while the profile is Off',
      actions: ['enable / disable the profile', 'adjust a scale', 'reset (double-click)'],
    },
  }),
  // Defringe (#3411) — the per-tick half of the profile-free lens
  // corrections, released on both platforms at once. The two surfaces
  // differ in shape rather than in reach: Apple swaps in its own
  // `DefringeSection` (the no-primary-field pattern HSL / Tone Curve /
  // Film / Lens Corrections already use there), while the web drives the
  // same six fields through the ordinary sub-param chip row. Same fields,
  // same ranges, same defaults, so no exception is warranted.
  panelTool({
    id: 'defringe',
    name: 'Defringe',
    group: 'detail',
    order: 62,
    copyPaste: 'detail',
    preview: 'live',
    presentation: {
      compact:
        'Detail sub-tool chip "Defringe": Apple swaps the phone control card body for its six-slider section; web arms the sub-param chip row',
      regular:
        'Detail sub-tool chip "Defringe": Apple swaps the control card body for its six-slider section; web arms the sub-param chip row',
      wide: 'Same as regular',
    },
    interaction: {
      keyboard:
        'Tab to a slider (Apple) or arm a sub-param chip then use the drag bar (web); arrow keys nudge',
      pointer: 'Drag Purple / Green Amount and their two Hue edges',
      touch: 'Same; sliders take long-press fine mode',
      focus: 'A focused slider consumes its own value keys',
    },
    accessibility: {
      role: 'slider (six)',
      name: 'Purple Amount / Hue Low / Hue High; Green Amount / Hue Low / Hue High',
      value: 'aria-valuenow 0–20 for the amounts, 0–100 for the hue-band edges',
      state: 'no disabled state — the stage runs on every asset, RAW or not',
      actions: ['adjust an amount or hue edge', 'reset to the generated default (double-click)'],
    },
  }),
  // Mask (#1541) shipped on the web first; the Apple twin is #355 (landing
  // with #3291), so this row is web-only until then and carries the
  // exception that says so — the same shape the manifest uses for every
  // other documented native/web gap.
  {
    ...panelTool({
      id: 'mask',
      name: 'Mask',
      group: 'detail',
      order: 65,
      // Local adjustments are outside the copy/paste field groups
      // (`NON_COPYABLE_FIELDS` in raw-core's schema).
      copyPaste: null,
      preview: 'live',
      presentation: {
        compact:
          'Mask dock entry arms the tool: canvas overlay (selected layer handles + weight tint) + mask panel (layer list, add linear/radial, feather, invert, ten local sliders, colour range) above the bottom dock',
        regular: 'Mask dock entry arms the tool: canvas overlay + 300px mask panel beside the dock',
        wide: 'Same as regular',
      },
      interaction: {
        keyboard:
          'Layer rows and add/delete/reset via Tab + Enter; the feather, local and colour-range sliders take arrow keys',
        pointer:
          'Drag a gradient endpoint / body, or an ellipse center / radius / rotation pin; the colour-range eyedropper arms the canvas pick overlay and the next click seeds the band',
        touch: 'Same drags; sliders take long-press fine mode',
        focus:
          'The overlay owns the canvas pointer stream while armed; the drag bar refuses value edits',
      },
      accessibility: {
        role: 'group (overlay, one img per handle) + list (layers, button rows) + slider (feather + ten controls + five colour-range controls) + checkbox (invert, colour range) + button (eyedropper)',
        name: 'Mask overlay; Mask handle: <handle>; Linear N / Radial N; Feather; Invert; the ten local control names; Colour range; Sample a colour for the range; Hue width / Chroma min / L min / L max / Feather',
        value:
          'aria-valuenow per slider; aria-current on the selected layer row; the band centre is read out in degrees next to the eyedropper',
        state:
          'one undo entry per drag; add / remove / invert / reset / colour-range enable / an eyedropper seed commit their own',
        actions: [
          'add a linear or radial mask',
          'select / delete a layer',
          'drag a handle',
          'adjust a local control',
          'enable the colour range',
          'sample a colour with the eyedropper',
          'adjust a colour-range control',
          'reset the layer',
        ],
      },
      featuresRow: 'Masks / local adjustments',
    }),
    tool: { web: 'mask', apple: 'mask' },
    reachability: { apple: 'released', web: 'released' },
    exception: null,
  },
  // Heal (#3409) — the deterministic clone / heal brush. Shipped on Apple
  // and Web together; Windows follows its own mask tool. #1472's
  // model-driven eraser is a separate, later tool that layers on top of
  // this one, not a gate on it.
  panelTool({
    id: 'heal',
    name: 'Heal',
    group: 'detail',
    order: 66,
    // Repair spots name a source region in THIS image, so they are outside
    // the copy/paste field groups (`NON_COPYABLE_FIELDS` in raw-core).
    copyPaste: null,
    preview: 'live',
    presentation: {
      compact:
        'Heal dock entry arms the tool: canvas overlay (destination and source discs joined by a link line) + heal panel (Heal/Clone toggle, size, feather, opacity, spot list) above the bottom dock',
      regular: 'Heal dock entry arms the tool: canvas overlay + 300px heal panel beside the dock',
      wide: 'Same as regular',
    },
    interaction: {
      keyboard:
        'Spot rows and delete/reset via Tab + Enter; the size, feather and opacity sliders take arrow keys',
      pointer:
        'Click the canvas to place a spot; drag the destination or the source handle to move either',
      touch: 'Same drags; sliders take long-press fine mode',
      focus:
        'The overlay owns the canvas pointer stream while armed; the drag bar refuses value edits',
    },
    accessibility: {
      role: 'group (overlay, one img per handle) + list (spots, button rows) + slider (size, feather, opacity) + radio group (Heal / Clone)',
      name: 'Heal overlay; Heal handle: <handle>; Heal N / Clone N; Size; Feather; Opacity',
      value: 'aria-valuenow per slider; aria-current on the selected spot row',
      state:
        'one undo entry per drag; place / delete / mode change / reset commit their own, all of class `repair`',
      actions: [
        'place a spot',
        'select / delete a spot',
        'drag the destination or source handle',
        'switch Heal / Clone',
        'adjust size, feather or opacity',
        'reset every spot',
      ],
    },
    featuresRow: 'Clone / heal brush',
  }),
  panelTool({
    id: 'crop',
    name: 'Crop',
    group: 'detail',
    order: 70,
    copyPaste: 'geometry',
    preview: 'commit-on-release',
    presentation: {
      compact:
        'Crop dock entry arms the tool: canvas overlay + crop toolbar (aspect presets, straighten, reset, done) above the bottom dock',
      regular:
        'Crop dock entry arms the tool: canvas overlay + 260px crop toolbar panel beside the dock',
      wide: 'Same as regular',
    },
    interaction: {
      keyboard:
        'Aspect presets and Done/Reset via Tab + Enter; the straighten slider takes arrow keys',
      pointer: 'Drag the rectangle edges / corners; drag the straighten bar',
      touch: 'Same drags',
      focus:
        'The overlay owns the canvas pointer stream while armed; the drag bar refuses value edits',
    },
    accessibility: {
      role: 'toolbar (aspect presets: button + aria-pressed) + slider (straighten)',
      name: 'Crop; aspect preset names; Straighten',
      value: 'Straighten aria-valuenow in degrees (±45)',
      state: 'aria-pressed on the active aspect preset',
      actions: ['pick an aspect', 'straighten', 'reset the crop', 'done (commit)'],
    },
    featuresRow: 'Crop + straighten',
  }),
  // Manual geometry (#3410) — the seven `crs:Perspective*` sliders. A panel
  // tool, not a slider tool: seven fields and no single primary one, so
  // `field` stays null the way Crop's does and the copy/paste group carries
  // the participation contract instead. Order 75 sits it between Crop (70)
  // and Presets (80), which is where both docks show it.
  panelTool({
    id: 'geometry',
    name: 'Geometry',
    group: 'detail',
    order: 75,
    copyPaste: 'geometry',
    preview: 'live',
    presentation: {
      compact:
        'Geometry dock entry or the Detail sub-tool chip swaps the phone control card body for the seven-slider panel',
      regular:
        'Geometry dock entry or the Detail sub-tool chip swaps the control card body for the seven-slider panel',
      wide: 'Same as regular',
    },
    interaction: {
      keyboard: 'Tab to a slider (role=slider); arrow keys nudge; the gesture is one undo entry',
      pointer: 'Drag a track; double-click a track resets that slider to its own default',
      touch: 'Same drags',
      focus: 'Each focused slider consumes its own value keys; the drag bar is inert for this tool',
    },
    accessibility: {
      role: 'slider ×7',
      name: 'Vertical; Horizontal; Rotate; Scale; Aspect; X Offset; Y Offset',
      value:
        'aria-valuenow per slider — keystone/aspect/offset −100…100, Rotate ±10°, Scale 50…150%',
      state: 'none',
      actions: ['correct vertical / horizontal keystone', 'rotate', 'scale', 'stretch', 'reframe'],
    },
    featuresRow: 'Manual geometry',
  }),
  panelTool({
    id: 'presets',
    name: 'Presets',
    group: 'detail',
    order: 80,
    copyPaste: null,
    presentation: {
      compact:
        'Presets dock entry opens the presets panel above the bottom dock (list / save / apply / delete)',
      regular: 'Presets dock entry toggles a 280px panel beside the dock',
      wide: 'Same as regular',
    },
    interaction: {
      keyboard: 'Tab through the list; Enter applies; Save / Delete are buttons',
      pointer: 'Click a preset to apply it (one undo entry); Save captures the non-default fields',
      touch: 'Tap to apply',
      focus: 'The panel is a plain list; shortcuts still reach the shell',
    },
    accessibility: {
      role: 'list / button',
      name: 'Presets; each preset by name',
      value: 'none — value-less tool',
      state: 'none',
      actions: ['apply', 'save current as preset', 'delete a user preset'],
    },
    featuresRow: 'Presets',
  }),
];
