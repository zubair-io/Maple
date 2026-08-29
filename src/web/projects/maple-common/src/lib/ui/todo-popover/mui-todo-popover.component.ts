// MuiTodoPopover — Maple UI Molecules-L2 (unified-component-catalog.md §3).
// Task attribute editor, built from Popover, Form Field, Chip Row.

import { ChangeDetectionStrategy, Component, input, model, output } from '@angular/core';
import { MuiChipRowComponent } from '../chip-row/mui-chip-row.component';
import type { MuiChip } from '../chip-row/mui-chip-row.component';
import { MuiFormFieldComponent } from '../form-field/mui-form-field.component';
import { MuiPopoverComponent } from '../popover/mui-popover.component';
import type { MuiPopoverPlacement } from '../popover/mui-popover.component';

const DEFAULT_PRIORITIES: readonly MuiChip[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
];

@Component({
  selector: 'mui-todo-popover',
  standalone: true,
  imports: [MuiChipRowComponent, MuiFormFieldComponent, MuiPopoverComponent],
  templateUrl: './mui-todo-popover.component.html',
  host: { class: 'contents' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiTodoPopoverComponent {
  readonly open = input<boolean>(false);
  readonly placement = input<MuiPopoverPlacement>('bottom');
  readonly title = model<string>('');
  readonly priorities = input<readonly MuiChip[]>(DEFAULT_PRIORITIES);
  readonly priority = model<string>('medium');
  readonly dueLabel = model<string>('');

  readonly closeRequested = output<void>();
  readonly saved = output<void>();

  save(): void {
    this.saved.emit();
  }
}
