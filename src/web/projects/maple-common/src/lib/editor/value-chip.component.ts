// value-chip.component.ts — responsive-program S5a (#625).
//
// Always-rendered value chip overlay (floats top-center, 14pt above the
// canvas region). Per spec §2: group + tool labels (SF Mono uppercase
// muted) + signed value in `primary`, tabular-nums.

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { EditorStateService } from './editor-state.service';
import { TOOL_DISPLAY, TOOL_GROUP_DISPLAY } from './tool-model';

@Component({
  selector: 'app-value-chip',
  standalone: true,
  templateUrl: './value-chip.component.html',
  styleUrl: './value-chip.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ValueChipComponent {
  protected readonly state = inject(EditorStateService);

  protected readonly groupLabel = computed(() =>
    TOOL_GROUP_DISPLAY[this.state.armedGroup()].toUpperCase(),
  );
  protected readonly toolLabel = computed(() => TOOL_DISPLAY[this.state.armedTool()].toUpperCase());

  protected readonly formattedValue = computed(() => {
    const v = this.state.armedDisplayValue();
    const tool = this.state.armedTool();
    if (tool === 'exposure') return `${v >= 0 ? '+' : ''}${v.toFixed(2)} EV`;
    if (tool === 'temp') return `${Math.round(v)} K`;
    const r = Math.round(v);
    return `${r >= 0 ? '+' : ''}${r}`;
  });
}
