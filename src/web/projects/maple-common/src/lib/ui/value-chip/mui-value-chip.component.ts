// MuiValueChip — Maple UI Molecules-L1 (unified-component-catalog.md §2.3).
// Floating value readout shown during a drag (e.g. above a slider thumb),
// built from Badge + Text. Purely presentational — positioning against the
// dragged control is the caller's concern.
//
// A caller can pass a single `label` (the chip's original shorthand — one
// eyebrow, e.g. "Exposure") or a `segments` array for a breadcrumb-style
// chip with several eyebrows (group · tool · armed sub-param), each its
// own DOM node so a caller's integration test can query one specific
// segment's own `textContent` without depending on the others' order or
// count (#3046 — the editor's group/tool/sub-param value chip).

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { MuiBadgeComponent } from '../badge/mui-badge.component';
import { MuiTextComponent } from '../text/mui-text.component';

export interface MuiValueChipSegment {
  readonly text: string;
  /** Optional `data-testid`, applied to this segment's own host element —
   * lets a caller's spec find and assert THIS segment specifically. */
  readonly testId?: string;
}

@Component({
  selector: 'mui-value-chip',
  standalone: true,
  imports: [MuiBadgeComponent, MuiTextComponent],
  templateUrl: './mui-value-chip.component.html',
  host: { class: 'inline-block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiValueChipComponent {
  /** Single-eyebrow shorthand. Ignored when `segments` is given. */
  readonly label = input<string | null>(null);
  /** Multiple eyebrows, each its own DOM node with an optional `testId`. */
  readonly segments = input<readonly MuiValueChipSegment[] | null>(null);
  readonly value = input.required<string | number>();

  /** `segments` when given, else a single segment built from `label` — the
   * one list the template renders, so it never has to branch between the
   * two input shapes itself. */
  readonly resolvedSegments = computed<readonly MuiValueChipSegment[]>(() => {
    const explicit = this.segments();
    if (explicit) return explicit;
    const l = this.label();
    return l ? [{ text: l }] : [];
  });
}
