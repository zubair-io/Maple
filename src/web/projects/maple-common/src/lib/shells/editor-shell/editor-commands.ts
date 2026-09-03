// editor-commands.ts — the web editor's command table (#2450, milestone 18
// design spec §3.3). One declarative list of every keyboard command the
// editor answers to: its stable id, the label people see in the command
// menu, the chord(s) that fire it, and the INTENT it resolves to. The
// router (`editor-command-router.ts`) is the only thing that turns an input
// event into an intent, and the only thing that executes one — so the same
// intent reached from a key, the command menu, or a button lands the same
// way. The Apple side implements the same contract natively (#3250); the
// shared part is this table's semantics, not code.
//
// Chord matching: `key` compares case-insensitively for single characters;
// `meta` means ⌘ on Mac / Ctrl elsewhere (both accepted, matching the
// pre-router shell); `alt` and `meta` default to REQUIRED-ABSENT so ⌘S and
// ⌘⌥S stay distinct; `shift` defaults to "don't care" for letters (P and
// Shift+P both pick) and can be pinned by a chord that needs it.

import type { ToolGroup } from '../../editor/tool-model';
import type { MuiCommandItem } from '../../ui/command-menu/mui-command-menu.component';

export interface KeyChord {
  /** `KeyboardEvent.key` value(s) that fire the chord. */
  readonly key: string | readonly string[];
  readonly meta?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
}

export type EditorIntent =
  | { readonly kind: 'nav.back' }
  | { readonly kind: 'nav.prev' }
  | { readonly kind: 'nav.next' }
  | { readonly kind: 'sidecar.flush' }
  | { readonly kind: 'history.undo' }
  | { readonly kind: 'history.redo' }
  | { readonly kind: 'clipboard.copy' }
  | { readonly kind: 'tool.cycle'; readonly direction: 1 | -1; readonly byGroup: boolean }
  | { readonly kind: 'tool.group'; readonly group: ToolGroup }
  | { readonly kind: 'value.nudge'; readonly direction: 1 | -1 }
  | { readonly kind: 'value.reset-group' }
  | { readonly kind: 'asset.rating'; readonly rating: 0 | 5 }
  | { readonly kind: 'asset.flag'; readonly flag: 'pick' | 'reject' | 'unflagged' }
  | { readonly kind: 'compare.press' }
  | { readonly kind: 'compare.release' }
  | { readonly kind: 'zoom.fit' }
  | { readonly kind: 'zoom.100' }
  | { readonly kind: 'zoom.step'; readonly direction: 1 | -1 }
  | { readonly kind: 'chrome.sidebar' }
  | { readonly kind: 'chrome.inspector' }
  | { readonly kind: 'panel.scopes' }
  | { readonly kind: 'commands.menu' };

export interface EditorCommand {
  readonly id: string;
  readonly label: string;
  readonly chords: readonly KeyChord[];
  readonly intent: EditorIntent;
  /** Listed in the command menu (momentary press/release pairs are not). */
  readonly menu?: boolean;
}

const META = true;

/** Every keyboard command, in the order the command menu lists them. */
export const EDITOR_COMMANDS: readonly EditorCommand[] = [
  {
    id: 'nav.back',
    label: 'Back to Library',
    chords: [{ key: 'Escape' }],
    intent: { kind: 'nav.back' },
    menu: true,
  },
  {
    id: 'nav.prev',
    label: 'Previous image',
    chords: [{ key: 'ArrowLeft', shift: false }],
    intent: { kind: 'nav.prev' },
    menu: true,
  },
  {
    id: 'nav.next',
    label: 'Next image',
    chords: [{ key: 'ArrowRight', shift: false }],
    intent: { kind: 'nav.next' },
    menu: true,
  },
  {
    id: 'history.undo',
    label: 'Undo',
    chords: [{ key: 'z', meta: META, shift: false }],
    intent: { kind: 'history.undo' },
    menu: true,
  },
  {
    id: 'history.redo',
    label: 'Redo',
    chords: [{ key: 'z', meta: META, shift: true }],
    intent: { kind: 'history.redo' },
    menu: true,
  },
  {
    id: 'sidecar.flush',
    label: 'Save edits now',
    chords: [{ key: 's', meta: META }],
    intent: { kind: 'sidecar.flush' },
    menu: true,
  },
  {
    id: 'clipboard.copy',
    label: 'Copy settings',
    chords: [{ key: 'c', meta: META }],
    intent: { kind: 'clipboard.copy' },
    menu: true,
  },
  {
    id: 'compare.press',
    label: 'Before / after (tap toggles, hold peeks)',
    chords: [{ key: ['\\', 'b'], shift: false }],
    intent: { kind: 'compare.press' },
    menu: true,
  },
  {
    id: 'zoom.fit',
    label: 'Zoom to fit',
    chords: [{ key: 'f' }, { key: '0', meta: META }],
    intent: { kind: 'zoom.fit' },
    menu: true,
  },
  {
    id: 'zoom.100',
    label: 'Zoom to 100%',
    chords: [
      { key: 'z', meta: false },
      { key: '1', meta: META },
    ],
    intent: { kind: 'zoom.100' },
    menu: true,
  },
  {
    id: 'zoom.in',
    label: 'Zoom in',
    chords: [{ key: ['=', '+'], meta: META }],
    intent: { kind: 'zoom.step', direction: 1 },
    menu: true,
  },
  {
    id: 'zoom.out',
    label: 'Zoom out',
    chords: [{ key: ['-', '_'], meta: META }],
    intent: { kind: 'zoom.step', direction: -1 },
    menu: true,
  },
  {
    id: 'tool.next',
    label: 'Next tool',
    chords: [{ key: ']', shift: false }],
    intent: { kind: 'tool.cycle', direction: 1, byGroup: false },
    menu: true,
  },
  {
    id: 'tool.prev',
    label: 'Previous tool',
    chords: [{ key: '[', shift: false }],
    intent: { kind: 'tool.cycle', direction: -1, byGroup: false },
    menu: true,
  },
  {
    id: 'group.next',
    label: 'Next tool group',
    chords: [{ key: [']', '}'], shift: true }],
    intent: { kind: 'tool.cycle', direction: 1, byGroup: true },
    menu: true,
  },
  {
    id: 'group.prev',
    label: 'Previous tool group',
    chords: [{ key: ['[', '{'], shift: true }],
    intent: { kind: 'tool.cycle', direction: -1, byGroup: true },
    menu: true,
  },
  {
    id: 'group.light',
    label: 'Light',
    chords: [{ key: '1' }],
    intent: { kind: 'tool.group', group: 'light' },
    menu: true,
  },
  {
    id: 'group.color',
    label: 'Color',
    chords: [{ key: '2' }],
    intent: { kind: 'tool.group', group: 'color' },
    menu: true,
  },
  {
    id: 'group.effects',
    label: 'Effects',
    chords: [{ key: '3' }],
    intent: { kind: 'tool.group', group: 'effects' },
    menu: true,
  },
  {
    id: 'group.detail',
    label: 'Detail',
    chords: [{ key: '4' }],
    intent: { kind: 'tool.group', group: 'detail' },
    menu: true,
  },
  {
    id: 'value.up',
    label: 'Nudge armed slider up',
    chords: [{ key: 'ArrowRight', shift: true }],
    intent: { kind: 'value.nudge', direction: 1 },
    menu: true,
  },
  {
    id: 'value.down',
    label: 'Nudge armed slider down',
    chords: [{ key: 'ArrowLeft', shift: true }],
    intent: { kind: 'value.nudge', direction: -1 },
    menu: true,
  },
  {
    id: 'value.reset-group',
    label: 'Reset the visible group',
    chords: [{ key: 'r' }],
    intent: { kind: 'value.reset-group' },
    menu: true,
  },
  {
    id: 'rating.5',
    label: 'Rate 5 stars',
    chords: [{ key: '5' }],
    intent: { kind: 'asset.rating', rating: 5 },
    menu: true,
  },
  {
    id: 'rating.0',
    label: 'Clear rating',
    chords: [{ key: '0' }],
    intent: { kind: 'asset.rating', rating: 0 },
    menu: true,
  },
  {
    id: 'flag.pick',
    label: 'Pick',
    chords: [{ key: 'p' }],
    intent: { kind: 'asset.flag', flag: 'pick' },
    menu: true,
  },
  {
    id: 'flag.reject',
    label: 'Reject',
    chords: [{ key: 'x' }],
    intent: { kind: 'asset.flag', flag: 'reject' },
    menu: true,
  },
  {
    id: 'flag.clear',
    label: 'Clear flag',
    chords: [{ key: 'u' }],
    intent: { kind: 'asset.flag', flag: 'unflagged' },
    menu: true,
  },
  {
    id: 'panel.scopes',
    label: 'Scopes',
    chords: [{ key: 'h' }],
    intent: { kind: 'panel.scopes' },
    menu: true,
  },
  {
    id: 'chrome.sidebar',
    label: 'Toggle sidebar',
    chords: [{ key: 's', meta: META, alt: true }],
    intent: { kind: 'chrome.sidebar' },
    menu: true,
  },
  {
    id: 'chrome.inspector',
    label: 'Toggle inspector',
    chords: [{ key: 'd', meta: META, alt: true }],
    intent: { kind: 'chrome.inspector' },
    menu: true,
  },
  {
    id: 'commands.menu',
    label: 'Command menu',
    chords: [{ key: 'k', meta: META }, { key: '?' }],
    intent: { kind: 'commands.menu' },
  },
];

/** Bare keys a focused `role="slider"` / `role="spinbutton"` consumes per
 *  the WAI-ARIA slider pattern — value adjustment only. */
const VALUE_WIDGET_KEYS: ReadonlySet<string> = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

function keyMatches(chordKey: string, eventKey: string): boolean {
  return chordKey.length === 1 && eventKey.length === 1
    ? chordKey.toLowerCase() === eventKey.toLowerCase()
    : chordKey === eventKey;
}

/** True when `e` is exactly this chord (modifier rules in the header). */
export function chordMatches(chord: KeyChord, e: KeyboardEvent): boolean {
  const keys = typeof chord.key === 'string' ? [chord.key] : chord.key;
  if (!keys.some((k) => keyMatches(k, e.key))) return false;
  const meta = e.metaKey || e.ctrlKey;
  if ((chord.meta ?? false) !== meta) return false;
  if ((chord.alt ?? false) !== e.altKey) return false;
  return chord.shift === undefined || chord.shift === e.shiftKey;
}

/** A bare value key — the one class of chord a focused value widget owns. */
export function isValueWidgetChord(e: KeyboardEvent): boolean {
  return VALUE_WIDGET_KEYS.has(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
}

/** The command whose chord `e` is, or `null`. */
export function commandForKey(e: KeyboardEvent): EditorCommand | null {
  return EDITOR_COMMANDS.find((c) => c.chords.some((chord) => chordMatches(chord, e))) ?? null;
}

const KEY_GLYPH: Readonly<Record<string, string>> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  Escape: 'Esc',
};

/** Human-readable chord for tooltips and the command menu, e.g. `⌘⇧Z`. */
export function describeChord(chord: KeyChord): string {
  const key = typeof chord.key === 'string' ? chord.key : chord.key[0];
  const glyph = KEY_GLYPH[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  return `${chord.meta ? '⌘' : ''}${chord.alt ? '⌥' : ''}${chord.shift ? '⇧' : ''}${glyph}`;
}

/** The command menu's rows: every listed command with its chord(s). */
export function commandMenuItems(): readonly MuiCommandItem[] {
  return EDITOR_COMMANDS.filter((c) => c.menu).map((c) => ({
    id: c.id,
    label: c.label,
    shortcut: c.chords.map(describeChord).join(' · '),
  }));
}

/** `aria-keyshortcuts` value for a command (WAI-ARIA key names, space-separated). */
export function ariaKeyshortcuts(id: string): string | null {
  const command = EDITOR_COMMANDS.find((c) => c.id === id);
  if (!command) return null;
  // `meta` matches ⌘ or Ctrl (chordMatches), so announce both variants.
  return command.chords
    .flatMap((chord) => {
      const key = typeof chord.key === 'string' ? chord.key : chord.key[0];
      const tail = [
        ...(chord.alt ? ['Alt'] : []),
        ...(chord.shift ? ['Shift'] : []),
        key.length === 1 ? key.toUpperCase() : key,
      ];
      return chord.meta
        ? [['Meta', ...tail].join('+'), ['Control', ...tail].join('+')]
        : [tail.join('+')];
    })
    .join(' ');
}
