// ToolDockComponent — vertical glass icon column on tablet/desktop (#1535).
// 8 icons: Light · Color · Curve · Effects · Detail · Optics · Mask · Heal.
// Light / Color / Effects / Detail switch the active ToolGroup.
// Curve / Optics / Heal / Mask are visibly disabled with a tooltip + code
// comment referencing the milestone ticket — NOT fake panels (CLAUDE.md #6).

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { MapleIconComponent } from '../../icons/maple-icon.component';
import type { ToolGroup } from '../../editor/tool-model';

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
}

const DOCK_ENTRIES: DockEntry[] = [
  { id: 'light', icon: 'tool-exposure', label: 'Light', group: 'light' },
  { id: 'color', icon: 'tool-tint', label: 'Color', group: 'color' },
  // Curve: coming in #1540 (web M2 — tone curve + WB pad)
  { id: 'curve', icon: 'tool-contrast', label: 'Curve', disabled: true, ticket: '#1540' },
  { id: 'effects', icon: 'tool-vignette', label: 'Effects', group: 'effects' },
  { id: 'detail', icon: 'tool-sharpen', label: 'Detail', group: 'detail' },
  // Optics: out of v0.1 scope — tracked in epic #1534.
  { id: 'optics', icon: 'zoom-in', label: 'Optics', disabled: true, ticket: '#1534' },
  // Mask: coming in #1541 (web M3 — masking). No masking exists yet; a fake
  // contour would violate CLAUDE.md principle #6.
  { id: 'mask', icon: 'tool-dehaze', label: 'Mask', disabled: true, ticket: '#1541' },
  // Heal: tracked in #1472 (local AI inpainting / Remove) — not wired in M1.
  { id: 'heal', icon: 'tool-texture', label: 'Heal', disabled: true, ticket: '#1472' },
];

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
  /** Fired when the user taps an enabled group entry. */
  groupChange = output<ToolGroup>();

  readonly entries = DOCK_ENTRIES;

  isActive(entry: DockEntry): boolean {
    return !!entry.group && entry.group === this.activeGroup();
  }

  onEntryClick(entry: DockEntry): void {
    if (entry.disabled || !entry.group) return;
    this.groupChange.emit(entry.group);
  }
}
