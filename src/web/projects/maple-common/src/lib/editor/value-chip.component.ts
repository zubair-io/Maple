// value-chip.component.ts — responsive-program S5a (#625).
//
// Always-rendered value chip overlay (floats top-center, 14pt above the
// canvas region). Per spec §2: group + tool labels (SF Mono uppercase
// muted) + signed value in `primary`, tabular-nums. While a multi-param
// tool is armed (#1108, spec §10.0) a third eyebrow names the armed
// sub-param: "DETAIL · SHARPEN · RADIUS · 1.0".
//
// Chrome now delegates to `mui-value-chip`'s `segments` input (#3046) — a
// breadcrumb of independently-testable eyebrow nodes, extended specifically
// so the armed sub-param segment carries its own `data-testid` regardless
// of how many eyebrows precede it.

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MuiValueChipComponent } from '../ui/value-chip/mui-value-chip.component';
import type { MuiValueChipSegment } from '../ui/value-chip/mui-value-chip.component';
import { EditorStateService } from './editor-state.service';
import { TOOL_DISPLAY, TOOL_GROUP_DISPLAY } from './tool-model';
import { formatSubParamValue } from './tool-sub-param';

@Component({
  selector: 'app-value-chip',
  standalone: true,
  imports: [MuiValueChipComponent],
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

  /** Armed sub-param label (uppercased) — null for single-param tools,
   * which keep the two-eyebrow chip exactly. */
  protected readonly subParamLabel = computed<string | null>(() => {
    const sub = this.state.armedSubParam();
    return sub ? sub.label.toUpperCase() : null;
  });

  protected readonly formattedValue = computed(() => {
    const v = this.state.armedDisplayValue();
    const sub = this.state.armedSubParam();
    // Sub-params carry their own format (decimals; unsigned for
    // one-sided ranges — spec §10.0 "FEATHER · 35", "RADIUS · 1.0").
    if (sub) return formatSubParamValue(sub, v);
    const tool = this.state.armedTool();
    if (tool === 'exposure') return `${v >= 0 ? '+' : ''}${v.toFixed(2)} EV`;
    if (tool === 'temp') return `${Math.round(v)} K`;
    const r = Math.round(v);
    return `${r >= 0 ? '+' : ''}${r}`;
  });

  /** Group · tool · (optional) armed-sub-param eyebrows fed to
   * `mui-value-chip`'s `segments` input — the sub-param segment keeps its
   * own `data-testid` (`editor-shell-hsl.spec.ts` queries it directly) no
   * matter how many eyebrows precede it. */
  protected readonly segments = computed<readonly MuiValueChipSegment[]>(() => {
    const sub = this.subParamLabel();
    const base: MuiValueChipSegment[] = [{ text: this.groupLabel() }, { text: this.toolLabel() }];
    return sub ? [...base, { text: sub, testId: 'editor-value-chip-subparam' }] : base;
  });
}
