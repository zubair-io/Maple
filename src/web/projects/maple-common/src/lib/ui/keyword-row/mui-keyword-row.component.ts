// MuiKeywordRow — Maple UI Molecules-L2 (unified-component-catalog.md §3).
// Editable tag chips, built from Chip Row, Input. Chip Row's `mode` is a
// single-choice enum (select/removable/editable), but keywords need both
// removal AND adding at once, so this composes Chip Row in `removable` mode
// for the existing tags plus its own trailing add-Input — the same "draft +
// commit" shape Chip Row's own `editable` mode uses internally.

import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import { MuiChipRowComponent } from '../chip-row/mui-chip-row.component';
import type { MuiChip } from '../chip-row/mui-chip-row.component';
import { MuiInputComponent } from '../input/mui-input.component';

@Component({
  selector: 'mui-keyword-row',
  standalone: true,
  imports: [MuiChipRowComponent, MuiInputComponent],
  templateUrl: './mui-keyword-row.component.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiKeywordRowComponent {
  readonly keywords = input.required<readonly MuiChip[]>();
  readonly addPlaceholder = input<string>('+ add');

  readonly removed = output<string>();
  readonly added = output<string>();

  readonly draft = signal('');

  onDraftCommit(raw: string): void {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return;
    this.added.emit(trimmed);
    this.draft.set('');
  }
}
