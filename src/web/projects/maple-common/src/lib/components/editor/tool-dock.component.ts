// ToolDockComponent — vertical glass icon column on tablet/desktop (#1535).
// 9 icons: Light · Color · Curve · Effects · Detail · Crop · Optics · Mask · Heal.
// Light / Color / Effects / Detail switch the active ToolGroup.
// Curve opens the tone-curve panel (M2 #1540).
// Crop arms the Crop tool directly (#1813 — canvas-first crop port; reuses
// CropSessionService/CropOverlayComponent/CropToolbarComponent from the S5
// editor, #638).
// Optics / Mask / Heal are visibly disabled with a tooltip + code
// comment referencing the milestone ticket — NOT fake panels (CLAUDE.md #6).

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { MapleIconComponent } from '../../icons/maple-icon.component';
import type { ToolGroup, ToolId } from '../../editor/tool-model';

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
  /** If true, clicking opens a floating panel rather than switching a group. */
  panel?: boolean;
}

const DOCK_ENTRIES: DockEntry[] = [
  { id: 'light', icon: 'tool-exposure', label: 'Light', group: 'light' },
  { id: 'color', icon: 'tool-tint', label: 'Color', group: 'color' },
  // Curve: enabled in #1540 (web M2 — tone curve + WB pad)
  { id: 'curve', icon: 'tool-contrast', label: 'Curve', panel: true },
  { id: 'effects', icon: 'tool-vignette', label: 'Effects', group: 'effects' },
  { id: 'detail', icon: 'tool-sharpen', label: 'Detail', group: 'detail' },
  // Crop: arms the Crop tool directly (#1813). Mounts the shared crop overlay
  // over the canvas + the shared crop toolbar (aspect/straighten/reset/done) —
  // same CropSessionService the S5 editor uses, so output is byte-identical.
  { id: 'crop', icon: 'tool-crop', label: 'Crop', tool: 'crop' },
  // Optics: out of v0.1 scope — tracked in epic #1534.
  { id: 'optics', icon: 'zoom-in', label: 'Optics', disabled: true, ticket: '#1534' },
  // Mask: coming in #1541 (web M3 — masking). No masking exists yet; a fake
  // contour would violate CLAUDE.md principle #6.
  { id: 'mask', icon: 'tool-dehaze', label: 'Mask', disabled: true, ticket: '#1541' },
  // Heal: tracked in #1472 (local AI inpainting / Remove) — not wired in M1.
  { id: 'heal', icon: 'tool-texture', label: 'Heal', disabled: true, ticket: '#1472' },
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
  /** Fired when the user taps an enabled group entry. */
  groupChange = output<ToolGroup>();
  /** Fired when the user taps a specific-tool entry (e.g. Crop). */
  toolChange = output<ToolId>();
  /** Fired when user taps the Curve entry (toggle). */
  curvePanelToggle = output<void>();

  readonly entries = DOCK_ENTRIES;

  isActive(entry: DockEntry): boolean {
    if (entry.panel) return entry.id === 'curve' && this.curveOpen();
    if (entry.tool) return entry.tool === this.activeTool();
    const armed = this.activeTool();
    if (armed != null && DOCK_TOOL_IDS.has(armed)) return false;
    return !!entry.group && entry.group === this.activeGroup();
  }

  onEntryClick(entry: DockEntry): void {
    if (entry.disabled) return;
    if (entry.panel) {
      this.curvePanelToggle.emit();
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
