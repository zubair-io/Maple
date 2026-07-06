// ToolDockComponent — glass icon dock, vertical on tablet/desktop, horizontal
// on phone (#1535, phone dock: #1807).
// Icons: Light · Color · Curve · Effects · Detail · Optics · Mask · Heal
// (+ Crop on phone — disabled until #1807 wires crop into this editor).
// Light / Color / Effects / Detail switch the active ToolGroup.
// Curve opens the tone-curve panel (M2 #1540).
// Optics / Mask / Heal / Crop are visibly disabled with a tooltip + code
// comment referencing the milestone ticket — NOT fake panels (CLAUDE.md #6).

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { MapleIconComponent } from '../../icons/maple-icon.component';
import type { ToolGroup } from '../../editor/tool-model';

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
  /** If true, entry is shown but non-interactive (coming in a later milestone). */
  disabled?: boolean;
  /** Code comment indicating the milestone ticket for disabled items. */
  ticket?: string;
  /** If true, clicking this entry opens a floating panel rather than switching a group. */
  panel?: boolean;
  /**
   * Which orientation(s) show this entry. Defaults to both. The phone
   * horizontal dock (#1807's mockup) shows only Light/Color/Effects/Detail/
   * Curve/Crop — Optics/Mask/Heal stay tablet+-only until they're actually
   * wired, and Crop is phone-only (nothing wires it into the vertical dock).
   */
  orientations?: readonly DockOrientation[];
}

const DOCK_ENTRIES: DockEntry[] = [
  { id: 'light', icon: 'tool-exposure', label: 'Light', group: 'light' },
  { id: 'color', icon: 'tool-tint', label: 'Color', group: 'color' },
  // Curve: enabled in #1540 (web M2 — tone curve + WB pad)
  { id: 'curve', icon: 'tool-contrast', label: 'Curve', panel: true },
  { id: 'effects', icon: 'tool-vignette', label: 'Effects', group: 'effects' },
  { id: 'detail', icon: 'tool-sharpen', label: 'Detail', group: 'detail' },
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
  // Crop: not wired into the canvas-first editor yet — tracked by the phone
  // CARD editor / crop-port epic (#1807). No crop overlay exists in this
  // editor today; a fake crop entry would violate CLAUDE.md principle #6.
  // Phone-only entry — the mockup's bottom dock ends in Crop.
  {
    id: 'crop',
    icon: 'tool-crop',
    label: 'Crop',
    disabled: true,
    ticket: '#1807',
    orientations: ['horizontal'],
  },
];

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
  /** True when the curve panel is open. */
  curveOpen = input<boolean>(false);
  /** Layout axis: vertical column (tablet/desktop) or horizontal bar (phone). */
  orientation = input<DockOrientation>('vertical');
  /** Fired when the user taps an enabled group entry. */
  groupChange = output<ToolGroup>();
  /** Fired when user taps the Curve entry (toggle). */
  curvePanelToggle = output<void>();

  /** Entries visible for the current orientation. */
  readonly entries = computed<DockEntry[]>(() => {
    const axis = this.orientation();
    return DOCK_ENTRIES.filter((e) => (e.orientations ?? BOTH_ORIENTATIONS).includes(axis));
  });

  isActive(entry: DockEntry): boolean {
    if (entry.panel) return entry.id === 'curve' && this.curveOpen();
    return !!entry.group && entry.group === this.activeGroup();
  }

  onEntryClick(entry: DockEntry): void {
    if (entry.disabled) return;
    if (entry.panel) {
      this.curvePanelToggle.emit();
      return;
    }
    if (entry.group) {
      this.groupChange.emit(entry.group);
    }
  }
}
