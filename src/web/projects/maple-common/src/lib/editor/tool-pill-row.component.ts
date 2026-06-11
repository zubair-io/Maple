// tool-pill-row.component.ts — responsive-program S5a + S5c (#625).
//
// One pill per tool in the armed group: 40pt circle + 10pt label.
// Selected = primary fill (15% opacity) + accent border + primary glyph
// & label. Modified-indicator dot bottom-right of the circle when the
// tool's display value differs from its default.

import { ChangeDetectionStrategy, Component, computed, inject, output } from '@angular/core';

import { MapleIconComponent } from '../icons/maple-icon.component';
import { EditorStateService } from './editor-state.service';
import { iconFor } from './tool-glyph';
import {
  TOOL_DISPLAY,
  TOOLS_IN_GROUP,
  defaultDisplayValue,
  fieldFor,
  isWired,
  type ToolId,
} from './tool-model';

@Component({
  selector: 'app-tool-pill-row',
  standalone: true,
  imports: [MapleIconComponent],
  templateUrl: './tool-pill-row.component.html',
  styleUrl: './tool-pill-row.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToolPillRowComponent {
  protected readonly state = inject(EditorStateService);

  /** Fires when the presets pill is tapped — the host (EditorComponent)
   *  opens the presets sheet (phone) / popover (desktop). #1115. */
  readonly presetsTap = output<void>();

  protected readonly displayName = TOOL_DISPLAY;
  protected readonly tools = computed<readonly ToolId[]>(
    () => TOOLS_IN_GROUP[this.state.armedGroup()],
  );

  protected iconFor = iconFor;

  protected isSelected(tool: ToolId): boolean {
    return this.state.armedTool() === tool;
  }

  protected isModified(tool: ToolId): boolean {
    if (!isWired(tool)) return false;
    const adj = this.state.currentAdjustment();
    if (!adj) return false;
    const field = fieldFor(tool);
    if (!field) return false;
    const v = adj[field] as number;
    return Math.abs(v - defaultDisplayValue(tool)) > 1e-6;
  }

  protected select(tool: ToolId): void {
    this.state.armTool(tool);
    this.state.haptic('switch');
    if (tool === 'presets') {
      this.presetsTap.emit();
    }
  }
}
