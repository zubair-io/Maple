// Deliberate staged Web experiment #3941; release qualification is #1472.
import type { ParityCapability } from './editor-parity-types';
export const REMOVE_TOOL: ParityCapability = {
  id: 'tool.remove',
  name: 'AI object removal',
  group: 'detail',
  order: 90,
  tool: { web: 'remove', apple: null },
  field: null,
  reachability: { apple: 'absent', web: 'partial' },
  presentation: {
    compact: 'Remove dock entry replaces the phone control card with the same experimental panel',
    regular: 'Remove dock entry opens selection and inspection controls beside the canvas',
    wide: 'Same as regular',
  },
  interaction: {
    keyboard:
      'Tab and Enter for model import, mode, radius, stroke undo/redo and inspection actions; keyboard painting is pending',
    pointer:
      'Paint in the canvas; Smart paint expands strokes; People offers numbered keep/remove candidates',
    touch: 'Same paint and panel actions',
    focus: 'Overlay captures the pointer while selecting; the scalar drag bar refuses this tool',
  },
  accessibility: {
    role: 'buttons, selection mode segmented toggle, brush slider, status region and canvas image',
    name: 'AI object removal; Object selection mode; Brush size; Keep; Cancel',
    value: 'Brush size in source long-edge fractions',
    state: 'Selection/generation/saving disable conflicting actions; failed restore exposes Retry',
    actions: [
      'paint',
      'smart paint',
      'find people',
      'choose keepers',
      'protect selection',
      'inspect',
      'compare',
      'keep',
      'cancel',
    ],
  },
  participation: {
    undo: false,
    history: false,
    copyPaste: null,
    preview: 'commit-on-release',
    export: false,
  },
  exception: {
    platform: 'both',
    ticket: '#1472',
    rationale:
      'Web local-only authoring is experimental. Apple UI, global history, normal export consumers, photographic model qualification and physical performance remain unfinished.',
  },
  // The shared shell has the tool, but deployment availability differs: only
  // Hosted local folders can author. The feature matrix documents both columns.
};
