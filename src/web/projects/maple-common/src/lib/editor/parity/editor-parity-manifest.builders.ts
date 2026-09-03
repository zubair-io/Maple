// editor-parity-manifest.builders.ts — the shared row builders for the
// TOOL rows of the editor parity manifest (#2448). A living-slider tool
// presents, behaves and announces itself the same way whichever field it
// drives, so the per-tool files (`editor-parity-manifest.light-color.ts`,
// `editor-parity-manifest.effects-detail.ts`) only spell out what differs:
// id, name, group, order, field, units, copy group, sub-param tiers.

import type { ToolGroup, ToolId } from '../tool-model';
import type {
  ParityAccessibility,
  ParityCapability,
  ParityField,
  ParityInteraction,
  ParityParticipation,
  ParityPresentation,
  ParityReachability,
} from './editor-parity-types';

const CARD: ParityPresentation = {
  compact: 'Row in the full-width control card stacked above the bottom dock',
  regular: 'Row in the 300px control card beside the vertical tool dock',
  wide: 'Row in the 300px control card beside the vertical tool dock',
};

export const SLIDER_INTERACTION: ParityInteraction = {
  keyboard:
    'Arrow ±step on the focused slider (Home/End to the range ends); Shift+←/→ ±10 internal on the armed tool from anywhere in the shell',
  pointer:
    'Relative drag on the track (commit-on-gesture-start, one undo entry per drag); double-click resets to the generated default; horizontal canvas scrub at fit zoom moves the armed tool at 0.5:1',
  touch: 'Same relative drag; long-press on the drag bar engages 0.25× fine mode for that gesture',
  focus:
    'A focused slider consumes its own bare arrow / Home / End keys; every other shortcut still reaches the shell',
};

export const SLIDER_A11Y = (name: string, units: string): ParityAccessibility => ({
  role: 'slider',
  name,
  value: `aria-valuenow / aria-valuemin / aria-valuemax in ${units}`,
  state: 'aria-disabled while the tool cannot take value edits',
  actions: [
    'increment / decrement (arrow keys, drag)',
    'reset to the generated default (double-click)',
  ],
});

export const PARTICIPATION = (
  copyPaste: ParityParticipation['copyPaste'],
  preview: ParityParticipation['preview'] = 'live',
): ParityParticipation => ({ undo: true, copyPaste, history: true, preview, export: true });

export const BOTH: Readonly<Record<'apple' | 'web', ParityReachability>> = {
  apple: 'released',
  web: 'released',
};

export interface SliderSpec {
  readonly id: ToolId;
  readonly name: string;
  readonly group: ToolGroup;
  readonly order: number;
  readonly field: ParityField;
  readonly units: string;
  readonly copyPaste: ParityParticipation['copyPaste'];
  /** Extra tiers the tool exposes through the sub-param chip row. */
  readonly subParams?: string;
  readonly featuresRow?: string;
}

/** A plain living-slider tool present on both platforms under the same id. */
export function sliderTool(spec: SliderSpec): ParityCapability {
  const presentation = spec.subParams
    ? {
        compact: `${CARD.compact}; ${spec.subParams}`,
        regular: `${CARD.regular}; ${spec.subParams}`,
        wide: `${CARD.wide}; ${spec.subParams}`,
      }
    : CARD;
  return {
    id: `tool.${spec.id}`,
    name: spec.name,
    group: spec.group,
    order: spec.order,
    tool: { web: spec.id, apple: spec.id },
    field: spec.field,
    reachability: BOTH,
    presentation,
    interaction: SLIDER_INTERACTION,
    accessibility: SLIDER_A11Y(spec.name, spec.units),
    participation: PARTICIPATION(spec.copyPaste),
    exception: null,
    ...(spec.featuresRow ? { featuresRow: spec.featuresRow } : {}),
  };
}

export interface PanelSpec {
  readonly id: ToolId;
  readonly name: string;
  readonly group: ToolGroup;
  readonly order: number;
  readonly copyPaste: ParityParticipation['copyPaste'];
  /** Primary drag-bar field, when the panel tool still has one (Color
   *  Grading's Balance); absent for the genuinely field-less tools. */
  readonly field?: ParityField;
  readonly presentation: ParityPresentation;
  readonly interaction: ParityInteraction;
  readonly accessibility: ParityAccessibility;
  readonly preview?: ParityParticipation['preview'];
  readonly featuresRow?: string;
}

/** A tool whose whole control surface is a dedicated panel. */
export function panelTool(spec: PanelSpec): ParityCapability {
  return {
    id: `tool.${spec.id}`,
    name: spec.name,
    group: spec.group,
    order: spec.order,
    tool: { web: spec.id, apple: spec.id },
    field: spec.field ?? null,
    reachability: BOTH,
    presentation: spec.presentation,
    interaction: spec.interaction,
    accessibility: spec.accessibility,
    participation: PARTICIPATION(spec.copyPaste, spec.preview),
    exception: null,
    ...(spec.featuresRow ? { featuresRow: spec.featuresRow } : {}),
  };
}

export const SUBTOOL_CHIP = (group: string, chip: string): ParityPresentation => ({
  compact: `${group} sub-tool chip "${chip}" swaps the phone control card body for the panel`,
  regular: `${group} sub-tool chip "${chip}" swaps the control card body for the panel`,
  wide: `${group} sub-tool chip "${chip}" swaps the control card body for the panel`,
});

export const CHIP_ROW_INTERACTION: ParityInteraction = {
  keyboard:
    'Tab to a sub-param chip, Enter/Space arms it; the drag bar then takes arrow keys; Shift+←/→ nudges the armed pair',
  pointer:
    'Tap a chip to arm that sub-param; relative drag on the drag bar; double-click resets the armed pair',
  touch: 'Same; long-press on the drag bar engages fine mode',
  focus: 'The focused drag bar (role=slider) consumes its own value keys',
};

export const CHIP_ROW_A11Y = (name: string): ParityAccessibility => ({
  role: 'group (sub-param chips: button + aria-pressed) + slider (drag bar)',
  name,
  value: 'Drag bar aria-valuenow in internal ±100 units; the value chip shows display units',
  state:
    'aria-pressed on the armed chip; aria-disabled on the drag bar while value edits are refused',
  actions: [
    'arm a sub-param (chip)',
    'adjust (drag bar)',
    'reset the armed sub-param (double-click)',
  ],
});
