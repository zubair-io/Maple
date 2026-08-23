// MuiPresetsPanel — Maple UI Organisms (unified-component-catalog.md §4.3
// "Inspectors & panels"). Save, apply, delete presets — built from List
// Row, Button, Dialog. Delete and save both round-trip through a
// confirm/prompt `mui-dialog` rather than firing straight from the row —
// delete is destructive, save needs a name — so `dialogMode` tracks which
// (if either) of the two dialogs is open.

import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import { MuiButtonComponent } from '../button/mui-button.component';
import { MuiDialogComponent } from '../dialog/mui-dialog.component';
import { MuiEmptyStateComponent } from '../empty-state/mui-empty-state.component';
import { MuiListRowComponent } from '../list-row/mui-list-row.component';
import { MuiSpinnerComponent } from '../spinner/mui-spinner.component';

export interface MuiPresetItem {
  readonly id: string;
  readonly name: string;
  readonly updatedAt: Date | number | string;
}

type MuiPresetsPanelDialogMode = 'none' | 'confirmDelete' | 'savePrompt';

@Component({
  selector: 'mui-presets-panel',
  standalone: true,
  imports: [
    MuiButtonComponent,
    MuiDialogComponent,
    MuiEmptyStateComponent,
    MuiListRowComponent,
    MuiSpinnerComponent,
  ],
  templateUrl: './mui-presets-panel.component.html',
  styleUrl: './mui-presets-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiPresetsPanelComponent {
  readonly presets = input.required<readonly MuiPresetItem[]>();
  readonly loading = input<boolean>(false);

  readonly applied = output<string>();
  readonly deleted = output<string>();
  /** The new preset name, from the save-prompt dialog. */
  readonly saved = output<string>();

  readonly dialogMode = signal<MuiPresetsPanelDialogMode>('none');
  readonly pendingDeleteId = signal<string | null>(null);
  readonly savePromptValue = signal<string>('');

  openSavePrompt(): void {
    this.savePromptValue.set('');
    this.dialogMode.set('savePrompt');
  }

  openConfirmDelete(id: string, event: MouseEvent): void {
    event.stopPropagation();
    this.pendingDeleteId.set(id);
    this.dialogMode.set('confirmDelete');
  }

  confirmDelete(): void {
    const id = this.pendingDeleteId();
    if (id) this.deleted.emit(id);
    this.dialogMode.set('none');
    this.pendingDeleteId.set(null);
  }

  confirmSave(name: string): void {
    const trimmed = name.trim();
    if (trimmed.length > 0) this.saved.emit(trimmed);
    this.dialogMode.set('none');
  }

  closeDialog(): void {
    this.dialogMode.set('none');
  }
}
