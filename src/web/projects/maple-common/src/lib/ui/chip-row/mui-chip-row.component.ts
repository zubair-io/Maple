// MuiChipRow — Maple UI Molecules-L1 (unified-component-catalog.md §2.2).
// Row of pills — select, apply (removable), or edit — built from Badge,
// Icon, Input.

import { ChangeDetectionStrategy, Component, input, model, output, signal } from '@angular/core';
import { MuiBadgeComponent } from '../badge/mui-badge.component';
import { MuiIconComponent } from '../icon/mui-icon.component';
import { MuiInputComponent } from '../input/mui-input.component';

export interface MuiChip {
  readonly id: string;
  readonly label: string;
  /** `select` mode only: renders the chip inert (dimmed, unclickable, kept
   * out of the aria-pressed toggle contract) — a preset that genuinely
   * cannot apply right now (e.g. a fixed aspect ratio with no known image
   * dimensions to snap to) rather than one merely unselected. */
  readonly disabled?: boolean;
  /** Shows an accent dot on this chip — "this chip's underlying state
   * differs from default," independent of `selected`. */
  readonly modified?: boolean;
  /** Passed straight through as this chip's own `data-testid` — lets a
   * caller's integration test find and assert ONE specific chip without
   * depending on row order or a CSS structural selector. */
  readonly testId?: string;
}

export type MuiChipRowMode = 'select' | 'removable' | 'editable';

@Component({
  selector: 'mui-chip-row',
  standalone: true,
  imports: [MuiBadgeComponent, MuiIconComponent, MuiInputComponent],
  templateUrl: './mui-chip-row.component.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiChipRowComponent {
  readonly chips = input.required<readonly MuiChip[]>();
  readonly mode = input<MuiChipRowMode>('select');
  /** Selected chip id, `select` mode only. */
  readonly selectedId = model<string | null>(null);
  readonly addPlaceholder = input<string>('Add…');

  readonly removed = output<string>();
  readonly added = output<string>();

  readonly draft = signal('');

  // ── Template view-model accessors ─────────────────────────────────────────
  // Pulled out of inline template ternaries (each occurrence read as its own
  // branch to the complexity gate) — same reasoning as
  // `export-dialog.component.ts`'s `formatDetail()`/`colorSpaceDetail()`.

  isSelected(chip: MuiChip): boolean {
    return this.selectedId() === chip.id;
  }

  isDisabled(chip: MuiChip): boolean {
    return !!chip.disabled;
  }

  selectChip(chip: MuiChip): void {
    if (chip.disabled) return;
    this.selectedId.set(chip.id);
  }

  removeChip(id: string, event: Event): void {
    event.stopPropagation();
    this.removed.emit(id);
  }

  onDraftCommit(raw: string): void {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return;
    this.added.emit(trimmed);
    this.draft.set('');
  }
}
