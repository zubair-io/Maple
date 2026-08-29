// sub-param-row.component.ts — multi-param tool pills (#1108, spec §10.0).
//
// Compact chip selector shown above the drag bar while a multi-param
// tool (noise, sharpen) is armed. Tapping a chip arms that (tool,
// subParam) pair for the drag bar / value chip / fine mode / reset.
// Renders nothing for single-param tools — they are byte-for-byte
// unchanged. Mirrors the Apple `SubParamRow` view.
//
// Chrome now delegates to `mui-chip-row` (#3046), extended there with a
// per-chip `testId` (`editor-shell-hsl.spec.ts` queries
// `[data-testid="editor-subparam-hueOrange"]` directly) and `modified`
// dot — the same two extensions `crop-toolbar.component.ts`'s aspect
// chips needed, made once on the shared atom rather than twice.

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { EditorStateService } from './editor-state.service';
import { subParamDefaultDisplay, type ToolSubParam } from './tool-sub-param';
import { MuiChipRowComponent } from '../ui/chip-row/mui-chip-row.component';
import type { MuiChip } from '../ui/chip-row/mui-chip-row.component';

@Component({
  selector: 'app-sub-param-row',
  standalone: true,
  imports: [MuiChipRowComponent],
  templateUrl: './sub-param-row.component.html',
  host: { class: 'contents' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SubParamRowComponent {
  protected readonly state = inject(EditorStateService);

  /** Chips render only for true multi-param tools (≥ 2 sub-params). */
  protected readonly subParams = computed<readonly ToolSubParam[]>(() => {
    const subs = this.state.armedSubParams();
    return subs.length > 1 ? subs : [];
  });

  private isArmed(sub: ToolSubParam): boolean {
    return this.state.armedSubParamId() === sub.id;
  }

  /** Per-chip modified dot — the sub-param's field is off its canonical
   * default. Same tolerance as the tool pills' dot. */
  private isModified(sub: ToolSubParam): boolean {
    const adj = this.state.currentAdjustment();
    if (!adj) return false;
    return Math.abs(adj[sub.field] - subParamDefaultDisplay(sub)) > 1e-6;
  }

  /** The `MuiChip[]` view-model fed to `<mui-chip-row>`. */
  protected readonly chips = computed<readonly MuiChip[]>(() =>
    this.subParams().map((sub) => ({
      id: sub.id,
      label: sub.label,
      modified: this.isModified(sub),
      testId: `editor-subparam-${sub.id}`,
    })),
  );

  protected readonly armedId = computed<string | null>(() => this.state.armedSubParamId());

  protected onSelectedIdChange(id: string | null): void {
    if (!id) return;
    const sub = this.subParams().find((s) => s.id === id);
    if (!sub || this.isArmed(sub)) return;
    this.state.armSubParam(sub.id);
    this.state.haptic('switch');
  }
}
