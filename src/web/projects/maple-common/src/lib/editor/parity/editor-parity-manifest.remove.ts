// Deliberate staged Apple/Web experiment; release qualification is #1472.
import type { ParityCapability } from './editor-parity-types';
export const REMOVE_TOOL: ParityCapability = {
  id: 'tool.remove',
  name: 'AI object removal',
  group: 'detail',
  order: 90,
  tool: { web: 'remove', apple: 'remove' },
  field: null,
  reachability: { apple: 'partial', web: 'partial' },
  presentation: {
    compact:
      'Apple: focused removal surface is experimental; Web: local-authoring experiment where available',
    regular:
      'Apple: focused editor with Paint, Auto Mask, People rail and flyout; Web: experimental panel',
    wide: 'Same as regular',
  },
  interaction: {
    keyboard:
      'Apple: arrow keys move the brush, Space starts/ends strokes, Return paints, Escape cancels, ⌘Z/⇧⌘Z undo/redo; Web keyboard painting remains pending',
    pointer:
      'Paint on canvas; Auto Mask selects an object; People offers a multi-select list and numbered candidates; Remove runs LaMa and presents a review before Keep',
    touch:
      'Web: paint and panel actions where authoring is available; Apple removal authoring is currently macOS-only',
    focus:
      'Apple focused removal hides other editing controls; its pointer overlay captures brush input, and the mode rail opens the control flyout',
  },
  accessibility: {
    role: 'buttons, three-mode selection rail, brush slider, status region and accessible paint canvas',
    name: 'AI object removal; Paint; Auto Mask; People; Brush size; Remove; Keep; Cancel',
    value: 'Brush size in source long-edge fractions',
    state: 'Selection/generation/saving disable conflicting actions; failed restore exposes Retry',
    actions: [
      'paint',
      'smart paint',
      'find people',
      'choose keepers',
      'multi-select people to remove',
      'inspect',
      'compare',
      'undo and redo',
      'keep',
      'cancel',
    ],
  },
  participation: {
    undo: true,
    history: true,
    copyPaste: null,
    preview: 'commit-on-release',
    export: true,
  },
  exception: {
    platform: 'both',
    ticket: '#1472',
    rationale:
      'Both authoring paths remain experimental. Mac Paint/Auto Mask/People and removal history are integrated, but reconstruction quality, broader render/export coverage, model distribution and supported-device performance are not release-qualified; Web authoring is not available across both deployments.',
  },
  // The shared Web shell still shows a disabled experiment; the Mac build has
  // an integrated focused authoring surface. Both remain tracked by #1472.
};
