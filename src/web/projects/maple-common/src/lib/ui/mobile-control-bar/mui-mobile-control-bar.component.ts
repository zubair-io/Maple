// MuiMobileControlBar — Maple UI Organisms, Wave W6 Lane B "Editing
// surfaces" (docs/unified-component-catalog.md §4.5). Phone bottom control
// stack: a tool row above the armed tool's Control Surface, built from
// Action Button (standing in for Tool Dock — see note below) and Control
// Surface (which itself wraps Tabs + Living Slider).
//
// The catalog names "Tool Dock" as a building block. That organism has not
// landed in this worktree yet (lib/ui/tool-dock/ does not exist as of this
// wave), so a plain row of `mui-action-button`s in `orientation="stacked"`
// stands in for it — the same shoulder-to-shoulder icon-over-label
// affordance a tool dock would render, composed directly from the atom
// rather than blocking on, or reimplementing, the missing organism.

import { ChangeDetectionStrategy, Component, input, model, output } from '@angular/core';
import { MuiActionButtonComponent } from '../action-button/mui-action-button.component';
import type { MapleIconName } from '../icon/mui-icon.component';
import { MuiControlSurfaceComponent } from '../control-surface/mui-control-surface.component';
import type { MuiControlSurfaceSlider } from '../control-surface/mui-control-surface.component';
import type { MuiTab } from '../tabs/mui-tabs.component';

export interface MuiMobileControlBarTool {
  readonly id: string;
  readonly icon: MapleIconName;
  readonly label: string;
}

@Component({
  selector: 'mui-mobile-control-bar',
  standalone: true,
  imports: [MuiActionButtonComponent, MuiControlSurfaceComponent],
  templateUrl: './mui-mobile-control-bar.component.html',
  host: { class: 'block w-full' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiMobileControlBarComponent {
  readonly tools = input.required<readonly MuiMobileControlBarTool[]>();
  readonly toolId = model<string>('');

  readonly tabs = input.required<readonly MuiTab[]>();
  readonly activeTab = model<string>('');
  /** Sliders for the currently active tab only — see MuiControlSurface. */
  readonly sliders = input.required<readonly MuiControlSurfaceSlider[]>();

  readonly toolSelected = output<string>();
  readonly tabChanged = output<string>();
  readonly sliderChanged = output<{ id: string; value: number }>();
  readonly sliderReset = output<string>();

  isSelected(tool: MuiMobileControlBarTool): boolean {
    return tool.id === this.toolId();
  }

  onToolSelect(id: string): void {
    this.toolId.set(id);
    this.toolSelected.emit(id);
  }
}
