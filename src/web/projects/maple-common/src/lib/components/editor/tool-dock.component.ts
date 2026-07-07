// ToolDockComponent — glass icon dock, vertical on tablet/desktop, horizontal
// on phone (#1535, phone dock: #1807).
// Icons: Light · Color · HSL · Curve · Effects · Detail · Crop · Presets ·
// Optics · Mask · Heal (Crop also has a phone-only horizontal entry).
// Light / Color / Effects / Detail switch the active ToolGroup.
// Curve opens the tone-curve panel (M2 #1540).
// HSL arms the HSL tool directly (canvas-first HSL port, epic #1807 slice 4;
// reuses SubParamRowComponent/DragBarComponent/ValueChipComponent verbatim
// from the S5 editor, #1112).
// Crop arms the Crop tool directly (#1813 — canvas-first crop port; reuses
// CropSessionService/CropOverlayComponent/CropToolbarComponent from the S5
// editor, #638). The phone dock's Crop entry is the same tool, now enabled
// now that crop is wired (previously a disabled placeholder for #1807).
// Presets opens the presets panel (#1815 — canvas-first presets port; reuses
// PresetsPanelComponent/PresetsService verbatim from the S5 editor, #1115).
// Optics / Mask / Heal are visibly disabled with a tooltip + code
// comment referencing the milestone ticket — NOT fake panels (CLAUDE.md #6).

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { MapleIconComponent } from '../../icons/maple-icon.component';
import type { ToolGroup, ToolId } from '../../editor/tool-model';

export type DockOrientation = 'vertical' | 'horizontal';

const BOTH_ORIENTATIONS: readonly DockOrientation[] = ['vertical', 'horizontal'];

export interface DockEntry {
  id: string;
  /** Icon name in the MapleIcon registry. */
  icon: string;
  /** Tooltip label. */
  label: string;
  /** If set, clicking this entry switches the active group. */
  group?: ToolGroup;
  /** If set, clicking this entry arms this specific tool (rather than the
   *  first tool of a group) — used for stub tools with their own affordance,
   *  e.g. Crop, which is driven by the canvas overlay + crop toolbar rather
   *  than a group's living-slider stack. */
  tool?: ToolId;
  /** If true, entry is shown but non-interactive (coming in a later milestone). */
  disabled?: boolean;
  /** Code comment indicating the milestone ticket for disabled items. */
  ticket?: string;
  /** If true, clicking this entry opens a floating panel rather than switching a group. */
  panel?: boolean;
  /**
   * Which orientation(s) show this entry. Defaults to both. The phone
   * horizontal dock (#1807's mockup) shows only Light/Color/HSL/Curve/
   * Effects/Detail/Crop/Presets — Optics/Mask/Heal stay tablet+-only until
   * they're actually wired. Crop has separate vertical- and horizontal-only
   * entries (both wired to the same `tool: 'crop'`) purely for dock-order
   * placement — the phone mockup ends the row in Crop.
   */
  orientations?: readonly DockOrientation[];
}

const DOCK_ENTRIES: DockEntry[] = [
  { id: 'light', icon: 'tool-exposure', label: 'Light', group: 'light' },
  { id: 'color', icon: 'tool-tint', label: 'Color', group: 'color' },
  // HSL: arms the HSL tool directly (canvas-first port, epic #1807 slice 4).
  // Mounts the shared SubParamRowComponent (chip selector) + DragBarComponent
  // + ValueChipComponent — same (tool, subParam) arming machinery the S5
  // editor's HSL pill uses, so a hue/sat/lum edit writes the identical
  // AdjustmentModel field on both editors.
  { id: 'hsl', icon: 'tool-hsl', label: 'HSL', tool: 'hsl' },
  // Curve: enabled in #1540 (web M2 — tone curve + WB pad)
  { id: 'curve', icon: 'tool-contrast', label: 'Curve', panel: true },
  { id: 'effects', icon: 'tool-vignette', label: 'Effects', group: 'effects' },
  { id: 'detail', icon: 'tool-sharpen', label: 'Detail', group: 'detail' },
  // Crop: arms the Crop tool directly (#1813). Mounts the shared crop overlay
  // over the canvas + the shared crop toolbar (aspect/straighten/reset/done) —
  // same CropSessionService the S5 editor uses, so output is byte-identical.
  // Tablet/desktop vertical-dock entry; the phone horizontal dock has its own
  // Crop entry below (now enabled — see that entry's comment).
  { id: 'crop', icon: 'tool-crop', label: 'Crop', tool: 'crop', orientations: ['vertical'] },
  // Presets: opens the presets panel (#1815). Mounts the shared
  // PresetsPanelComponent (list/save/apply/delete) — same PresetsService +
  // EditorStateService.applyPreset the S5 editor uses.
  { id: 'presets', icon: 'tool-presets', label: 'Presets', panel: true },
  // Optics: out of v0.1 scope — tracked in epic #1534. Not part of the phone
  // dock's mockup (#1807) — tablet/desktop only.
  {
    id: 'optics',
    icon: 'zoom-in',
    label: 'Optics',
    disabled: true,
    ticket: '#1534',
    orientations: ['vertical'],
  },
  // Mask: coming in #1541 (web M3 — masking). No masking exists yet; a fake
  // contour would violate CLAUDE.md principle #6. Tablet/desktop only.
  {
    id: 'mask',
    icon: 'tool-dehaze',
    label: 'Mask',
    disabled: true,
    ticket: '#1541',
    orientations: ['vertical'],
  },
  // Heal: tracked in #1472 (local AI inpainting / Remove) — not wired in M1.
  // Tablet/desktop only.
  {
    id: 'heal',
    icon: 'tool-texture',
    label: 'Heal',
    disabled: true,
    ticket: '#1472',
    orientations: ['vertical'],
  },
  // Crop: arms the Crop tool directly, same as the vertical dock's Crop entry
  // above (#1813 wired the crop overlay/toolbar; this was a disabled
  // placeholder for exactly that landing — #1807). Phone-only entry — the
  // mockup's bottom dock ends in Crop.
  { id: 'crop', icon: 'tool-crop', label: 'Crop', tool: 'crop', orientations: ['horizontal'] },
];

/** Tools that have their own dock entry (currently just Crop) — a group
 *  entry must NOT show active while one of these is armed, even though the
 *  tool lives inside that group (Crop is in `detail`). */
const DOCK_TOOL_IDS = new Set<ToolId>(
  DOCK_ENTRIES.map((e) => e.tool).filter((t): t is ToolId => t != null),
);

@Component({
  selector: 'pro-tool-dock',
  standalone: true,
  imports: [MapleIconComponent],
  templateUrl: './tool-dock.component.html',
  styleUrl: './tool-dock.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.dock-host--horizontal]': "orientation() === 'horizontal'",
  },
})
export class ToolDockComponent {
  /** Currently active tool group. */
  activeGroup = input.required<ToolGroup>();
  /** Currently armed tool — only consulted for `tool`-entries (e.g. Crop), so
   *  a specific-tool entry highlights only while ITS tool is armed, not
   *  merely while its group is active (Detail must not also show active
   *  while Crop, which lives in the `detail` group, is armed). */
  activeTool = input<ToolId | null>(null);
  /** True when the curve panel is open. */
  curveOpen = input<boolean>(false);
  /** Layout axis: vertical column (tablet/desktop) or horizontal bar (phone). */
  orientation = input<DockOrientation>('vertical');
  /** True when the presets panel is open (#1815). */
  presetsOpen = input<boolean>(false);
  /** Fired when the user taps an enabled group entry. */
  groupChange = output<ToolGroup>();
  /** Fired when the user taps a specific-tool entry (e.g. Crop). */
  toolChange = output<ToolId>();
  /** Fired when user taps the Curve entry (toggle). */
  curvePanelToggle = output<void>();
  /** Fired when user taps the Presets entry (toggle, #1815). */
  presetsPanelToggle = output<void>();

  /** Entries visible for the current orientation. */
  readonly entries = computed<DockEntry[]>(() => {
    const axis = this.orientation();
    return DOCK_ENTRIES.filter((e) => (e.orientations ?? BOTH_ORIENTATIONS).includes(axis));
  });

  /** Whether a given `panel: true` entry's panel is currently open — keyed
   *  by entry id so a second panel entry (Presets, #1815) doesn't need its
   *  own branch in `isActive`/`onEntryClick`. */
  private panelOpenFor(entry: DockEntry): boolean {
    switch (entry.id) {
      case 'curve':
        return this.curveOpen();
      case 'presets':
        return this.presetsOpen();
      default:
        return false;
    }
  }

  /** Fires the toggle output for a given `panel: true` entry — keyed by
   *  entry id, same as `panelOpenFor` above. Explicit per-id dispatch (not
   *  an `if (id === 'presets') … else …` fallthrough) so a THIRD panel entry
   *  can't silently fire `curvePanelToggle` by omission — an unrecognized
   *  panel id is a no-op rather than a wrong toggle (#1816 review). */
  private firePanelToggle(entry: DockEntry): void {
    switch (entry.id) {
      case 'curve':
        this.curvePanelToggle.emit();
        return;
      case 'presets':
        this.presetsPanelToggle.emit();
        return;
    }
  }

  isActive(entry: DockEntry): boolean {
    if (entry.panel) return this.panelOpenFor(entry);
    if (entry.tool) return entry.tool === this.activeTool();
    const armed = this.activeTool();
    if (armed != null && DOCK_TOOL_IDS.has(armed)) return false;
    return !!entry.group && entry.group === this.activeGroup();
  }

  onEntryClick(entry: DockEntry): void {
    if (entry.disabled) return;
    if (entry.panel) {
      this.firePanelToggle(entry);
      return;
    }
    if (entry.tool) {
      this.toolChange.emit(entry.tool);
      return;
    }
    if (entry.group) {
      this.groupChange.emit(entry.group);
    }
  }
}
