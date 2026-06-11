// sub-param-row.component.ts — multi-param tool pills (#1108, spec §10.0).
//
// Compact chip selector shown above the drag bar while a multi-param
// tool (noise, sharpen) is armed. Tapping a chip arms that (tool,
// subParam) pair for the drag bar / value chip / fine mode / reset.
// Renders nothing for single-param tools — they are byte-for-byte
// unchanged. Mirrors the Apple `SubParamRow` view.

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { EditorStateService } from './editor-state.service';
import { subParamDefaultDisplay, type ToolSubParam } from './tool-sub-param';

@Component({
  selector: 'app-sub-param-row',
  standalone: true,
  templateUrl: './sub-param-row.component.html',
  styleUrl: './sub-param-row.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SubParamRowComponent {
  protected readonly state = inject(EditorStateService);

  /** Chips render only for true multi-param tools (≥ 2 sub-params). */
  protected readonly subParams = computed<readonly ToolSubParam[]>(() => {
    const subs = this.state.armedSubParams();
    return subs.length > 1 ? subs : [];
  });

  protected isArmed(sub: ToolSubParam): boolean {
    return this.state.armedSubParamId() === sub.id;
  }

  /** Per-chip modified dot — the sub-param's field is off its canonical
   * default. Same tolerance as the tool pills' dot. */
  protected isModified(sub: ToolSubParam): boolean {
    const adj = this.state.currentAdjustment();
    if (!adj) return false;
    return Math.abs(adj[sub.field] - subParamDefaultDisplay(sub)) > 1e-6;
  }

  protected select(sub: ToolSubParam): void {
    if (this.isArmed(sub)) return;
    this.state.armSubParam(sub.id);
    this.state.haptic('switch');
  }
}
