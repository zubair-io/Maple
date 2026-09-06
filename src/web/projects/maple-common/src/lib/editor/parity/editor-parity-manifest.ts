// editor-parity-manifest.ts — the editor surface + interaction parity
// manifest (#2448, milestone 18 design spec §3.1): chrome, input, canvas,
// navigation, history, scopes, clipboard and export rows, assembled with the
// tool rows from `editor-parity-manifest.tools.ts`.
//
// Hand-authored DATA. `tools/check-editor-parity-manifest.ts` fails CI when
// a row disagrees with the tree (see `editor-parity-types.ts` for the
// rules); `editor-parity.ts` exposes the rows to the shell at runtime.
// Every `exception` names the ticket that closes the gap — flipping a
// platform to `released` without deleting the exception fails the checker,
// which is how a closed gap can't quietly keep being tracked as open.

import type { ParityCapability, ParityException } from './editor-parity-types';
import { TOOL_CAPABILITIES } from './editor-parity-manifest.tools';
import { EDITOR_INPUT_CAPABILITIES } from './editor-parity-manifest.input';
import type { EditorParityManifest } from './editor-parity-types';

const NONE = {
  undo: false,
  copyPaste: null,
  history: false,
  preview: 'none',
  export: false,
} as const;
const BOTH = { apple: 'released', web: 'released' } as const;
const SAME = (text: string) => ({ compact: text, regular: text, wide: text });

const APPLE_LAYOUT_EXCEPTION: ParityException = {
  platform: 'apple',
  rationale:
    'Apple ships two control layouts behind a temporary @AppStorage exploration flag (Variant A dock + flyout, Variant B stacked panel) and a third de facto iPhone path (IPhoneLegacyControlBar); web has one adaptive tree.',
  ticket: '#3252',
};

const SHELL: readonly ParityCapability[] = [
  {
    id: 'shell.mode-split',
    name: 'Browse ↔ full-editor mode split',
    group: 'shell',
    order: 10,
    reachability: BOTH,
    presentation: {
      compact: 'Web: /edit/:slug route. Apple: NavigationStack push on iPhone',
      regular: 'Web: /edit/:slug route. Apple: pane-shell mode flip',
      wide: 'Same as regular',
    },
    interaction: {
      keyboard:
        'Enter on a focused asset opens Preview; Edit button / E enters the editor; Escape returns',
      pointer: 'Click Edit; Back button returns to Preview for the same asset',
      touch: 'Tap Edit; tap Back',
      focus: 'Route change moves focus to the editor top bar',
    },
    accessibility: {
      role: 'button (Edit / Back to Library)',
      name: 'Edit; Back to Library',
      value: 'none',
      state: 'none',
      actions: ['enter the editor', 'leave the editor'],
    },
    participation: NONE,
    exception: null,
    featuresRow: 'Editor (develop)',
  },
  {
    id: 'shell.control-layout',
    name: 'One converged control layout',
    group: 'shell',
    order: 20,
    reachability: { apple: 'partial', web: 'released' },
    presentation: {
      compact: 'Web: always-visible slider card stacked above a horizontal bottom dock',
      regular:
        'Web: vertical dock + 300px control card, dock-side panels for Curve / Crop / Presets / Noise',
      wide: 'Same as regular; no chrome auto-recede',
    },
    interaction: {
      keyboard: '1–4 switch group; [ / ] cycle tool, Shift+[ / ] cycle group',
      pointer: 'Dock entries switch group / arm a tool / toggle a panel',
      touch: 'Same; phone dock scrolls horizontally',
      focus: 'Dock entries are ordinary buttons in DOM order',
    },
    accessibility: {
      role: 'toolbar (dock) + region (card)',
      name: 'Editor tools',
      value: 'none',
      state: 'aria-pressed on the active dock entry',
      actions: ['switch group', 'arm tool', 'toggle panel'],
    },
    participation: NONE,
    exception: APPLE_LAYOUT_EXCEPTION,
  },
  {
    id: 'shell.adaptive-dock',
    name: 'Same-component compact / regular / wide dock',
    group: 'shell',
    order: 30,
    reachability: { apple: 'partial', web: 'released' },
    presentation: {
      compact: 'Web: pro-tool-dock orientation="horizontal" at the bottom edge',
      regular: 'Web: the same pro-tool-dock, vertical, right edge',
      wide: 'Same as regular',
    },
    interaction: {
      keyboard: 'Tab through entries; Enter / Space presses',
      pointer: 'Click an entry',
      touch: 'Tap; the phone bar scrolls horizontally',
      focus: 'Disabled placeholders are out of the tab order entirely',
    },
    accessibility: {
      role: 'toolbar',
      name: 'Editor tools',
      value: 'none',
      state: 'aria-pressed per entry; modified dot per entry',
      actions: ['press an entry'],
    },
    participation: NONE,
    exception: {
      ...APPLE_LAYOUT_EXCEPTION,
      rationale:
        "Apple's ToolDock.swift is a regular-size-class-only view and MobileControlBar a separate phone view; web's dock takes an orientation input.",
    },
  },
  {
    id: 'shell.tool-dock',
    name: 'Tool dock (4 groups + Crop / Curve / Film / Presets)',
    group: 'shell',
    order: 40,
    reachability: BOTH,
    presentation: SAME(
      'Light · Color · Effects · Detail, a divider, then Crop · Tone Curve · Film · Presets · Mask · Heal — the same ten entries in the same order as ToolDock.swift',
    ),
    interaction: {
      keyboard: '1–4 switch group; Tab + Enter on any entry',
      pointer: 'Click',
      touch: 'Tap',
      focus: 'Plain buttons; disabled placeholders are aria-hidden and untabbable',
    },
    accessibility: {
      role: 'toolbar / button',
      name: 'Editor tools; entry labels',
      value: 'none',
      state: 'aria-pressed (active), modified dot, disabled + aria-hidden (placeholders)',
      actions: ['switch group', 'arm Crop / Film', 'toggle Curve / Presets'],
    },
    participation: NONE,
    exception: null,
  },
  {
    id: 'shell.image-identity',
    name: 'Image identity (asset name)',
    group: 'shell',
    order: 50,
    reachability: BOTH,
    presentation: SAME('File name in the floating top bar, truncated with an ellipsis'),
    interaction: { keyboard: 'none', pointer: 'none', touch: 'none', focus: 'Static text' },
    accessibility: {
      role: 'text',
      name: 'the file name',
      value: 'none',
      state: 'none',
      actions: ['read'],
    },
    participation: NONE,
    exception: null,
  },
  {
    id: 'shell.info-inspector',
    name: 'Detail inspector (Info)',
    group: 'shell',
    order: 60,
    reachability: BOTH,
    presentation: {
      compact: 'Info button opens a bottom sheet (mui-sheet-shell, 0.74 detent)',
      regular:
        'Info button opens a docked right-side pane; the control card hides while it is open',
      wide: 'Same as regular',
    },
    interaction: {
      keyboard: '⌘⌥D toggles; Escape closes the sheet',
      pointer: 'Click Info; click the pane close',
      touch: 'Tap Info; drag the sheet down to dismiss',
      focus: 'Focus moves into the pane / sheet and returns to the Info button on close',
    },
    accessibility: {
      role: 'button (aria-pressed) + dialog / region',
      name: 'Info',
      value: 'none',
      state: 'aria-pressed while open',
      actions: ['open', 'close'],
    },
    participation: NONE,
    exception: null,
  },
  {
    id: 'shell.placeholder-heal',
    name: 'Heal',
    group: 'shell',
    order: 80,
    reachability: { apple: 'absent', web: 'absent' },
    presentation: SAME(
      'Dimmed dock entry, aria-hidden, tooltip names the ticket — label and ticket read from this row by tool-dock.component.ts',
    ),
    interaction: {
      keyboard: 'none — out of the tab order',
      pointer: 'none',
      touch: 'none',
      focus: 'Never receives focus',
    },
    accessibility: {
      role: 'none (aria-hidden)',
      name: 'Heal — coming in #1472 (tooltip only)',
      value: 'none',
      state: 'disabled',
      actions: ['none'],
    },
    participation: NONE,
    disabled: true,
    exception: {
      platform: 'both',
      rationale: 'Local AI inpainting epic; no UI on either platform yet.',
      ticket: '#1472',
    },
  },
  {
    id: 'shell.auto',
    name: 'AUTO (exposure + tone, one undo entry)',
    group: 'shell',
    order: 90,
    reachability: BOTH,
    presentation: SAME(
      'AUTO button in the floating top bar; Apple announces the edit transaction, web reports the applied exposure',
    ),
    interaction: {
      keyboard: 'Tab + Enter',
      pointer: 'Click; disabled while an analysis is in flight',
      touch: 'Tap',
      focus: 'Ordinary button',
    },
    accessibility: {
      role: 'button + status',
      name: 'Auto adjust',
      value:
        'Apple: Ready / Analysing and edit announcement; web: "Auto applied · Exposure ±N.NN EV"',
      state: 'Busy while analysing; disabled without a supported asset',
      actions: ['apply'],
    },
    participation: { undo: true, copyPaste: 'tone', history: true, preview: 'live', export: true },
    featuresRow: 'AUTO',
  },
  {
    id: 'shell.reset-all',
    name: 'Reset all',
    group: 'shell',
    order: 100,
    reachability: BOTH,
    presentation: SAME(
      'RESET button in the floating top bar; the control card header resets one group',
    ),
    interaction: {
      keyboard: 'Tab + Enter; R resets the armed group',
      pointer: 'Click',
      touch: 'Tap',
      focus: 'Ordinary button',
    },
    accessibility: {
      role: 'button',
      name: 'Reset all adjustments; Reset <Group> adjustments',
      value: 'none',
      state: 'disabled without an asset',
      actions: ['reset every develop slider (crop preserved)', 'reset the visible group'],
    },
    participation: { undo: true, copyPaste: null, history: true, preview: 'live', export: true },
    exception: null,
    featuresRow: 'Reset all',
  },
];

const HISTORY: readonly ParityCapability[] = [
  {
    id: 'history.undo-redo',
    name: 'Undo / redo (bounded ring, cap 32)',
    group: 'history',
    order: 10,
    reachability: BOTH,
    presentation: SAME(
      'Undo button in the top bar: tap = undo, hold 500ms = redo; one entry per gesture',
    ),
    interaction: {
      keyboard: 'Web: ⌘Z / ⌘⇧Z. Apple: none (#3250)',
      pointer: 'Click = undo; press-and-hold = redo (pointer captured so drag-off still resolves)',
      touch: 'Tap / long-press',
      focus: 'Ordinary button',
    },
    accessibility: {
      role: 'button',
      name: 'Undo',
      value: 'none',
      state: 'disabled when nothing to undo or redo',
      actions: ['undo', 'redo (long-press)'],
    },
    participation: { undo: true, copyPaste: null, history: true, preview: 'live', export: true },
    exception: null,
  },
  {
    id: 'history.undo-keyboard',
    name: 'Undo / redo keyboard shortcut',
    group: 'history',
    order: 20,
    reachability: { apple: 'absent', web: 'released' },
    presentation: SAME('No visible chrome; documented in the Undo button tooltip'),
    interaction: {
      keyboard: '⌘Z / Ctrl+Z undo, ⌘⇧Z / Ctrl+Shift+Z redo, from anywhere except a text field',
      pointer: 'n/a',
      touch: 'n/a (hardware keyboard only)',
      focus: 'Works while a slider is focused',
    },
    accessibility: {
      role: 'keyboard shortcut',
      name: 'Undo / Redo',
      value: 'none',
      state: 'none',
      actions: ['undo', 'redo'],
    },
    participation: { undo: true, copyPaste: null, history: true, preview: 'live', export: true },
    exception: {
      platform: 'apple',
      rationale: 'Apple undo/redo is tap / long-press only; no editor Commands scene.',
      ticket: '#3250',
    },
  },
];

const CLIPBOARD_EXPORT: readonly ParityCapability[] = [
  {
    id: 'clipboard.copy-settings',
    name: 'Copy settings from the open image',
    group: 'clipboard',
    order: 10,
    reachability: BOTH,
    presentation: SAME(
      'No editor chrome: ⌘C copies into the app clipboard; paste happens from Browse against a selection',
    ),
    interaction: {
      keyboard: '⌘C / Ctrl+C (not ⌘⌥C)',
      pointer: 'Browse toolbar Copy / Paste against the selection',
      touch: 'Browse toolbar',
      focus: 'Skipped while a text field has focus',
    },
    accessibility: {
      role: 'keyboard shortcut (editor) / button (Browse)',
      name: 'Copy settings',
      value: 'none',
      state: 'none',
      actions: ['copy'],
    },
    participation: { undo: false, copyPaste: null, history: false, preview: 'none', export: false },
    exception: null,
    featuresRow: 'Copy / paste / sync settings',
  },
  {
    id: 'clipboard.paste-in-editor',
    name: 'Paste settings from inside the editor',
    group: 'clipboard',
    order: 20,
    reachability: { apple: 'absent', web: 'absent' },
    presentation: SAME(
      'Not present: paste is a Browse-shell multi-selection action on both platforms',
    ),
    interaction: { keyboard: 'none', pointer: 'none', touch: 'none', focus: 'n/a' },
    accessibility: { role: 'none', name: 'none', value: 'none', state: 'none', actions: ['none'] },
    participation: NONE,
    exception: null,
  },
  {
    id: 'export.dialog',
    name: 'Export dialog',
    group: 'export',
    order: 10,
    reachability: BOTH,
    presentation: SAME(
      'Export button in the top bar opens a modal dialog (format, quality, size on web)',
    ),
    interaction: {
      keyboard: 'Tab + Enter; Escape closes',
      pointer: 'Click',
      touch: 'Tap',
      focus: 'Focus trapped in the dialog; returns to the Export button on close',
    },
    accessibility: {
      role: 'button + dialog',
      name: 'Export',
      value: 'none',
      state: 'disabled without an asset',
      actions: ['open', 'export', 'cancel'],
    },
    participation: { undo: false, copyPaste: null, history: false, preview: 'none', export: true },
    exception: null,
    featuresRow: 'Export',
  },
];

export const EDITOR_PARITY_MANIFEST: EditorParityManifest = {
  version: 1,
  capabilities: [
    ...TOOL_CAPABILITIES,
    ...SHELL,
    ...EDITOR_INPUT_CAPABILITIES,
    ...HISTORY,
    ...CLIPBOARD_EXPORT,
  ],
};
