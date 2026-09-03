// editor-parity-manifest.input.ts — the INPUT, CANVAS, NAVIGATION and
// SCOPES rows of the editor parity manifest (#2448): the interaction
// primitives (slider gestures, wheel nudge, zoom, before/after, filmstrip
// navigation, commit-on-navigate) and the scopes. Assembled into the full
// manifest by `editor-parity-manifest.ts`.
//
// This is where the two-directional gap the milestone 18 spec (§2.2 / §2.3)
// records lives as data: scroll-wheel nudge is Apple-only, keyboard nudge /
// zoom / undo shortcuts are web-only, momentary before/after and the
// non-histogram scopes exist on neither. Each carries the ticket that
// closes it, and the checker fails once a side is flipped to `released`
// without the exception being removed.

import type { ParityCapability, ParityException } from './editor-parity-types';

const NONE = {
  undo: false,
  copyPaste: null,
  history: false,
  preview: 'none',
  export: false,
} as const;
const EDIT = { undo: true, copyPaste: null, history: true, preview: 'live', export: true } as const;
const BOTH = { apple: 'released', web: 'released' } as const;
const SAME = (text: string) => ({ compact: text, regular: text, wide: text });

const APPLE_ROUTER: ParityException = {
  platform: 'apple',
  rationale:
    'Apple has no editor command router yet: neither slider primitive takes keyboard nudge, and the zoom / undo / reset shortcuts are unwired (design spec §2.2–2.3).',
  ticket: '#3250',
};

const APPLE_SLIDER_SPLIT: ParityException = {
  platform: 'apple',
  rationale:
    'Only the legacy DragBar.swift (IPhoneLegacyControlBar / ControlCard) has it; LivingSlider.swift, which both current control variants use, does not.',
  ticket: '#3250',
};

const INPUT: readonly ParityCapability[] = [
  {
    id: 'input.slider-drag',
    name: 'Slider: relative drag',
    group: 'input',
    order: 10,
    reachability: BOTH,
    presentation: SAME(
      'Living slider track (control card) and 21-tick drag bar (sub-param panels)',
    ),
    interaction: {
      keyboard: 'n/a',
      pointer: 'Pointer-captured relative drag; touch-down never jumps the value',
      touch: 'Same',
      focus: 'The track is the focusable element (tabindex=0)',
    },
    accessibility: {
      role: 'slider',
      name: 'the tool label',
      value: 'aria-valuenow',
      state: 'aria-disabled while value edits are refused',
      actions: ['adjust'],
    },
    participation: EDIT,
    exception: null,
  },
  {
    id: 'input.slider-keyboard-nudge',
    name: 'Slider: keyboard arrow nudge',
    group: 'input',
    order: 20,
    reachability: { apple: 'absent', web: 'released' },
    presentation: SAME(
      'No chrome; the focused slider / drag bar moves by one step per arrow press',
    ),
    interaction: {
      keyboard:
        'Arrow ±step, Home / End on the focused slider; Shift+←/→ ±10 internal on the armed tool',
      pointer: 'n/a',
      touch: 'n/a',
      focus:
        'A held arrow key is one gesture (dragStart on the first keydown, dragEnd on keyup / focusout) — one undo entry',
    },
    accessibility: {
      role: 'slider',
      name: 'the tool label',
      value: 'aria-valuenow updates per press',
      state: 'none',
      actions: ['increment', 'decrement', 'jump to min / max'],
    },
    participation: EDIT,
    exception: APPLE_ROUTER,
  },
  {
    id: 'input.slider-wheel-nudge',
    name: 'Slider: scroll-wheel nudge',
    group: 'input',
    order: 30,
    reachability: BOTH,
    presentation: SAME('No chrome; a wheel over the canvas at fit zoom nudges the armed tool'),
    interaction: {
      keyboard: 'n/a',
      pointer:
        'Plain wheel at fit zoom: detents nudge the armed (tool, sub-param) by 1 internal unit (⇧ 10, ⌥ 0.1); a burst within 0.5s shares one undo entry (WheelNudgeBurst.swift / editor-shell-wheel.ts); commit-on-release fields flush 250ms after the last detent',
      touch: 'n/a',
      focus: 'Cmd/Ctrl+wheel stays zoom; plain wheel while zoomed stays pan',
    },
    accessibility: {
      role: 'none (pointer-only; the slider keeps the accessible value)',
      name: 'n/a',
      value: 'reflected on the armed slider',
      state: 'none',
      actions: ['adjust'],
    },
    participation: EDIT,
    exception: null,
  },
  {
    id: 'input.slider-fine-mode',
    name: 'Slider: long-press fine mode',
    group: 'input',
    order: 40,
    reachability: { apple: 'partial', web: 'released' },
    presentation: SAME(
      'Drag bar marker: long-press engages 0.25× sensitivity for the next drag, with a haptic',
    ),
    interaction: {
      keyboard: 'n/a',
      pointer: 'Press-and-hold the marker, then drag',
      touch: 'Same',
      focus: 'Cleared on drag end',
    },
    accessibility: {
      role: 'slider',
      name: 'Drag bar marker',
      value: 'aria-valuenow',
      state: 'none announced',
      actions: ['fine adjust'],
    },
    participation: EDIT,
    exception: APPLE_SLIDER_SPLIT,
  },
  {
    id: 'input.slider-double-tap-reset',
    name: 'Slider: double-tap / double-click reset',
    group: 'input',
    order: 50,
    reachability: { apple: 'partial', web: 'released' },
    presentation: SAME('No chrome; double-click a slider or drag bar'),
    interaction: {
      keyboard: 'n/a (the control card header button resets the group)',
      pointer:
        'Double-click resets to the generated default (Temp 6500, Sharpen 40, Color NR 25 — not internal zero)',
      touch: 'Double-tap',
      focus: 'n/a',
    },
    accessibility: {
      role: 'slider',
      name: 'the tool label',
      value: 'aria-valuenow snaps to the default',
      state: 'none',
      actions: ['reset'],
    },
    participation: EDIT,
    exception: APPLE_SLIDER_SPLIT,
  },
  {
    id: 'input.canvas-scrub',
    name: 'Canvas scrub (drag the image to move the armed tool)',
    group: 'input',
    order: 60,
    reachability: BOTH,
    presentation: SAME(
      'At fit zoom a horizontal drag on the canvas moves the armed tool at 0.5:1 with a value HUD; chrome dims while scrubbing',
    ),
    interaction: {
      keyboard: 'n/a',
      pointer:
        'Primary-button drag at fit zoom; refused while Crop is armed or the tool takes no value edits',
      touch: 'One-finger drag at fit zoom; pinch stays zoom',
      focus: 'pointercancel abandons the gesture without committing',
    },
    accessibility: {
      role: 'none (the HUD is decorative; the slider keeps the accessible value)',
      name: 'n/a',
      value: 'reflected on the armed slider',
      state: 'none',
      actions: ['adjust'],
    },
    participation: EDIT,
    exception: null,
  },
];

const CANVAS: readonly ParityCapability[] = [
  {
    id: 'canvas.zoom',
    name: 'Zoom: fit / 100% / pinch / anchored wheel',
    group: 'canvas',
    order: 10,
    reachability: BOTH,
    presentation: SAME(
      'Full-bleed canvas; pixelScale 0 = fit, 1 = true 100%, cap 8; snap-to-fit below fit × 1.02',
    ),
    interaction: {
      keyboard: 'Web: F fit, Z 100%, ⌘0 fit, ⌘1 100%, ⌘= / ⌘- step',
      pointer:
        'Cmd/Ctrl+wheel or trackpad pinch zooms at the cursor; double-click toggles fit ↔ 100%; drag pans when zoomed',
      touch: 'Two-finger pinch at the centroid; one-finger drag pans when zoomed',
      focus: 'Overlay controls inside the canvas own their pointer stream',
    },
    accessibility: {
      role: 'none (canvas)',
      name: 'the file name overlay',
      value: 'zoom badge text (percent)',
      state: 'none',
      actions: ['zoom', 'pan'],
    },
    participation: NONE,
    exception: null,
  },
  {
    id: 'canvas.zoom-keyboard',
    name: 'Zoom: keyboard shortcuts',
    group: 'canvas',
    order: 20,
    reachability: { apple: 'absent', web: 'released' },
    presentation: SAME('No chrome; documented in the toolbar tooltips'),
    interaction: {
      keyboard:
        'F / Z (bare), ⌘0 / ⌘1 fit / 100%, ⌘= / ⌘- bounded step (same step as the toolbar and wheel) — never while a text field has focus',
      pointer: 'n/a',
      touch: 'n/a',
      focus: 'Works while a slider is focused (F / Z are not value keys)',
    },
    accessibility: {
      role: 'keyboard shortcut',
      name: 'Fit; 100%',
      value: 'none',
      state: 'none',
      actions: ['fit', '100%'],
    },
    participation: NONE,
    exception: {
      ...APPLE_ROUTER,
      rationale:
        'CanvasZoomController.swift documents ⌘0 / ⌘1 / ⌘= / ⌘- in comments; nothing calls them.',
    },
  },
  {
    id: 'canvas.before-after-latched',
    name: 'Before / after: latched split',
    group: 'canvas',
    order: 30,
    reachability: BOTH,
    presentation: SAME(
      'Top-bar toggle; a draggable divider splits the canvas, zoom and pan preserved across the toggle',
    ),
    interaction: {
      keyboard: '\\ or B toggles',
      pointer: 'Click the toggle; drag the divider handle',
      touch: 'Tap; drag the handle',
      focus: 'Ordinary button (aria-pressed)',
    },
    accessibility: {
      role: 'button',
      name: 'Toggle before/after',
      value: 'none',
      state: 'aria-pressed while split',
      actions: ['toggle', 'move the divider'],
    },
    participation: NONE,
    exception: null,
    featuresRow: 'Before/after',
  },
  {
    id: 'canvas.before-after-momentary',
    name: 'Before / after: momentary (press-and-hold)',
    group: 'canvas',
    order: 40,
    reachability: { apple: 'absent', web: 'released' },
    presentation: SAME(
      'Web: the same before/after button and the \\ / B keys — a tap toggles the latched split, a hold (≥300ms) shows the whole frame as "before" until release; zoom and pan untouched',
    ),
    interaction: {
      keyboard: 'Hold \\ or B to peek, release to restore (a short tap toggles the latched split)',
      pointer:
        'Press-and-hold the toggle (pointer captured; a drag-off release still ends the peek)',
      touch: 'Press-and-hold',
      focus: 'One press/release pair through the command router whichever input pressed it',
    },
    accessibility: {
      role: 'button',
      name: 'Toggle before/after',
      value: 'none',
      state: 'aria-pressed while held',
      actions: ['peek at before'],
    },
    participation: NONE,
    exception: {
      platform: 'apple',
      rationale:
        'Web ships the press/release peek through its command router (#2450); Apple builds the same contract in its router (#3250).',
      ticket: '#3250',
    },
  },
  {
    id: 'canvas.deep-zoom-tiles',
    name: 'Deep-zoom tiles (native-detail beyond 100%)',
    group: 'canvas',
    order: 50,
    reachability: { apple: 'released', web: 'absent' },
    presentation: SAME(
      'Apple: tiled native-detail path (DeepZoomState / TileManager) up to 8×. Web: a single rendered surface, CSS-upscaled past its refine target',
    ),
    interaction: {
      keyboard: 'Same zoom shortcuts',
      pointer: 'Same zoom gestures',
      touch: 'Same pinch',
      focus: 'n/a',
    },
    accessibility: {
      role: 'none (canvas)',
      name: 'n/a',
      value: 'zoom badge',
      state: 'none',
      actions: ['zoom'],
    },
    participation: NONE,
    exception: {
      platform: 'web',
      rationale: 'Web deep-zoom tile adoption is its own ticket; the compositor is gated.',
      ticket: '#1107',
    },
    featuresRow: 'Deep-zoom tiles',
  },
];

const NAVIGATION: readonly ParityCapability[] = [
  {
    id: 'navigation.filmstrip',
    name: 'Filmstrip (collapsible, tablet and up)',
    group: 'navigation',
    order: 10,
    reachability: BOTH,
    presentation: {
      compact: 'No filmstrip; bare ←/→ still navigate',
      regular:
        'Left glass rail of thumbnails with a collapse toggle, shown when the folder has more than one photo',
      wide: 'Same as regular',
    },
    interaction: {
      keyboard:
        'Bare ←/→ previous / next image (never while a slider is focused); Tab + Enter on a thumbnail',
      pointer: 'Click a thumbnail; click the collapse toggle',
      touch: 'Tap',
      focus: 'The focused thumbnail scrolls into view; the current one carries aria-current',
    },
    accessibility: {
      role: 'button (per thumbnail, aria-pressed) + button (collapse, aria-expanded)',
      name: 'the file name; Show / Hide filmstrip',
      value: 'none',
      state: 'aria-current="true" + aria-pressed on the focused asset; aria-expanded on the toggle',
      actions: ['select an image', 'collapse / expand'],
    },
    participation: NONE,
    exception: null,
  },
  {
    id: 'navigation.commit-on-navigate',
    name: 'Commit-on-navigate (asset switch flushes the in-flight edit)',
    group: 'navigation',
    order: 20,
    reachability: BOTH,
    presentation: SAME('No chrome'),
    interaction: {
      keyboard:
        '←/→ are refused while a scrub, slider drag or wheel burst is in flight (editor-command-router.ts)',
      pointer:
        'A filmstrip switch mid-drag drops the remaining ticks (control card) and any in-flight canvas scrub; bind() discards a parked commit-on-release value',
      touch: 'Same',
      focus: 'Apple: flushPendingSidecarWrite() on session teardown',
    },
    accessibility: { role: 'none', name: 'n/a', value: 'none', state: 'none', actions: ['none'] },
    participation: { undo: false, copyPaste: null, history: true, preview: 'none', export: true },
    exception: null,
  },
];

const SCOPE_EXCEPTION: ParityException = {
  platform: 'apple',
  rationale:
    'Apple has neither a scope view beyond the histogram nor a downsampled readback path from RenderActor; web mounts the Maple UI scopes panel over the worker readback (#2449).',
  ticket: '#3251',
};

const scope = (id: string, name: string, order: number): ParityCapability => ({
  id: `scopes.${id}`,
  name,
  group: 'scopes',
  order,
  reachability: { apple: 'absent', web: 'released' },
  presentation: {
    compact: 'Web: Scopes button in the top bar opens a flyout panel above the dock',
    regular: 'Web: Scopes button (the live histogram) opens a 240px dock-side panel',
    wide: 'Same as regular',
  },
  interaction: {
    keyboard: 'Tab + Enter on the Scopes toggle',
    pointer: 'Click the toggle',
    touch: 'Tap the toggle',
    focus: 'Static plot; the toggle is an ordinary button',
  },
  accessibility: { role: 'img', name, value: 'none', state: 'none', actions: ['read'] },
  participation: NONE,
  exception: SCOPE_EXCEPTION,
});

const SCOPES: readonly ParityCapability[] = [
  {
    id: 'scopes.histogram',
    name: 'Histogram',
    group: 'scopes',
    order: 10,
    reachability: BOTH,
    presentation: {
      compact:
        'Scopes button (icon) in the top bar opens the panel, whose first plot is the histogram',
      regular:
        '70×26 live RGB histogram in the top bar is the Scopes toggle (mui-histogram over the worker scope readback)',
      wide: 'Same as regular',
    },
    interaction: {
      keyboard: 'Tab + Enter on the Scopes toggle opens / closes the panel',
      pointer: 'Click the toggle (the histogram itself on tablet/desktop)',
      touch: 'Tap the toggle',
      focus: 'The toggle is an ordinary button (aria-pressed); the plot is static',
    },
    accessibility: {
      role: 'button (Scopes toggle) + img (plot)',
      name: 'Scopes; Histogram',
      value: 'none',
      state: 'aria-pressed while the panel is open',
      actions: ['open / close the scopes panel', 'read'],
    },
    participation: NONE,
    exception: null,
    featuresRow: 'Histogram',
  },
  scope('waveform', 'Waveform', 20),
  scope('parade', 'RGB parade', 30),
  scope('vectorscope', 'Vectorscope', 40),
];

export const EDITOR_INPUT_CAPABILITIES: readonly ParityCapability[] = [
  ...INPUT,
  ...CANVAS,
  ...NAVIGATION,
  ...SCOPES,
];
