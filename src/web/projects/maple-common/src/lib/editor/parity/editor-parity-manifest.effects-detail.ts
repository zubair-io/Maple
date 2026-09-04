// editor-parity-manifest.effects-detail.ts — the Effects and Detail tool
// rows of the editor parity manifest (#2448), including the two Apple-only
// capture-sharpening cases that are the one approved permanent platform
// exception (`docs/features.md` §8).

import type { ParityCapability, ParityException } from './editor-parity-types';
import {
  PARTICIPATION,
  SLIDER_A11Y,
  SLIDER_INTERACTION,
  SUBTOOL_CHIP,
  panelTool,
  sliderTool,
} from './editor-parity-manifest.builders';

const CAPTURE_SHARPENING_EXCEPTION: ParityException = {
  platform: 'web',
  rationale:
    'Capture sharpening (deconvolution) needs a dedicated hardware-accelerated path the browser pipeline does not have; approved platform exception per docs/features.md §8.',
  ticket: null,
};

const APPLE_SLIDER = {
  compact: 'Apple: Detail-group slider',
  regular: 'Apple: Detail-group slider',
  wide: 'Apple: Detail-group slider',
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
  {
    id: 'tool.captureSharpen',
    name: 'Deconv',
    group: 'detail',
    order: 40,
    tool: { web: null, apple: 'captureSharpen' },
    field: 'captureSharpeningAmount',
    reachability: { apple: 'released', web: 'absent' },
    presentation: APPLE_SLIDER,
    interaction: { ...SLIDER_INTERACTION, keyboard: 'Apple: no keyboard nudge yet (#3250)' },
    accessibility: SLIDER_A11Y('Deconv', '0–100'),
    participation: PARTICIPATION('detail'),
    exception: CAPTURE_SHARPENING_EXCEPTION,
    featuresRow: 'Capture sharpening (deconvolution)',
  },
  {
    id: 'tool.captureSigma',
    name: 'Deconv σ',
    group: 'detail',
    order: 50,
    tool: { web: null, apple: 'captureSigma' },
    field: 'captureSharpeningSigma',
    reachability: { apple: 'released', web: 'absent' },
    presentation: APPLE_SLIDER,
    interaction: { ...SLIDER_INTERACTION, keyboard: 'Apple: no keyboard nudge yet (#3250)' },
    accessibility: SLIDER_A11Y('Deconv σ', '0.5–2.0'),
    participation: PARTICIPATION('detail'),
    exception: CAPTURE_SHARPENING_EXCEPTION,
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
          'Mask dock entry arms the tool: canvas overlay (selected layer handles + weight tint) + mask panel (layer list, add linear/radial, feather, invert, ten local sliders) above the bottom dock',
        regular: 'Mask dock entry arms the tool: canvas overlay + 300px mask panel beside the dock',
        wide: 'Same as regular',
      },
      interaction: {
        keyboard:
          'Layer rows and add/delete/reset via Tab + Enter; the feather and local sliders take arrow keys',
        pointer: 'Drag a gradient endpoint / body, or an ellipse center / radius / rotation pin',
        touch: 'Same drags; sliders take long-press fine mode',
        focus:
          'The overlay owns the canvas pointer stream while armed; the drag bar refuses value edits',
      },
      accessibility: {
        role: 'group (overlay, one img per handle) + list (layers, button rows) + slider (feather + ten controls) + checkbox (invert)',
        name: 'Mask overlay; Mask handle: <handle>; Linear N / Radial N; Feather; Invert; the ten local control names',
        value: 'aria-valuenow per slider; aria-current on the selected layer row',
        state: 'one undo entry per drag; add / remove / invert / reset commit their own',
        actions: [
          'add a linear or radial mask',
          'select / delete a layer',
          'drag a handle',
          'adjust a local control',
          'reset the layer',
        ],
      },
      featuresRow: 'Masks / local adjustments',
    }),
    tool: { web: 'mask', apple: 'mask' },
    reachability: { apple: 'released', web: 'released' },
    exception: null,
  },
  {
    id: 'tool.heal',
    name: 'Heal',
    group: 'detail',
    order: 66,
    tool: { web: null, apple: 'heal' },
    field: null,
    reachability: { apple: 'partial', web: 'absent' },
    presentation: {
      compact: 'Apple: a Detail dock entry that arms nothing',
      regular: 'Same as compact',
      wide: 'Same as compact',
    },
    interaction: {
      keyboard: 'Tab-reachable; arms nothing',
      pointer: 'Click arms the case; no panel',
      touch: 'Same as pointer',
      focus: 'No canvas overlay',
    },
    accessibility: {
      role: 'button',
      name: 'Heal',
      value: 'none',
      state: 'none',
      actions: ['arm it (inert until #1472)'],
    },
    participation: {
      undo: false,
      copyPaste: null,
      history: false,
      preview: 'none',
      export: false,
    },
    exception: {
      platform: 'both',
      rationale: 'Apple: a #1472 mount point only; web has no heal tool.',
      ticket: '#1472',
    },
  },
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
