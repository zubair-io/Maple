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
}

export type MuiChipRowMode = 'select' | 'removable' | 'editable';

@Component({
  selector: 'mui-chip-row',
  standalone: true,
  imports: [MuiBadgeComponent, MuiIconComponent, MuiInputComponent],
  templateUrl: './mui-chip-row.component.html',
  styleUrl: './mui-chip-row.component.scss',
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

  selectChip(id: string): void {
    this.selectedId.set(id);
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
