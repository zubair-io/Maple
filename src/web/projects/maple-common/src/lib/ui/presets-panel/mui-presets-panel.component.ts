// MuiPresetsPanel — Maple UI Organisms (unified-component-catalog.md §4.3
// "Inspectors & panels"). Save, apply, delete presets — built from List
// Row, Button, Dialog.
//
// Delete has two confirm models, chosen via `confirmMode` (#3046):
//  - 'modal' (default): delete round-trips through a confirm `mui-dialog`
//    rather than firing straight from the row.
//  - 'inline': delete flips the ROW ITSELF into a "Delete “name”?" confirm
//    in place (check/cancel trailing actions, apply suppressed while
//    confirming) instead of opening a dialog — the Pro Editor's original
//    row-flip contract, preserved verbatim rather than folded into the
//    modal workflow.
//
// Save is unaffected by `confirmMode` — its own dialog-vs-not choice is
// `showSaveTrigger`: a caller that supplies its own always-visible save UI
// (the Pro Editor's inline name input + button, never a prompt dialog to
// begin with) sets it `false` rather than leaving an unused second save
// affordance in the DOM.

import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import { MuiButtonComponent } from '../button/mui-button.component';
import { MuiDialogComponent } from '../dialog/mui-dialog.component';
import { MuiEmptyStateComponent } from '../empty-state/mui-empty-state.component';
import { MuiListRowComponent } from '../list-row/mui-list-row.component';
import { MuiSpinnerComponent } from '../spinner/mui-spinner.component';

export interface MuiPresetItem {
  readonly id: string;
  readonly name: string;
  /** Renders as a relative Timestamp subtitle ("Edited 2m ago") when
   * given. Omit for a domain with no real per-preset timestamp (e.g. the
   * Pro Editor's presets, which carry no `updatedAt` of their own) and use
   * `subtitle` instead. */
  readonly updatedAt?: Date | number | string;
  /** Plain-text subtitle, shown when `updatedAt` is omitted — e.g. "3
   * settings" for a domain with no real timestamp. */
  readonly subtitle?: string;
}

export type MuiPresetsPanelConfirmMode = 'modal' | 'inline';

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
  readonly confirmMode = input<MuiPresetsPanelConfirmMode>('modal');
  /** Hides the built-in header "Save preset" trigger (and its prompt
   * dialog) — a caller supplying its own always-visible save UI sets this
   * `false` rather than leaving an unused second save affordance in the
   * DOM. */
  readonly showSaveTrigger = input<boolean>(true);
  /** Hides every row's trailing delete action — for a read-only list (the
   * Pro Editor's built-in presets, which can't be deleted) rendered
   * through a second `<mui-presets-panel>` mount alongside the deletable
   * user-preset one. */
  readonly showDeleteAction = input<boolean>(true);

  readonly applied = output<string>();
  readonly deleted = output<string>();
  /** The new preset name, from the save-prompt dialog (`showSaveTrigger`
   * only — a caller that hides the trigger supplies its own save flow and
   * never receives this). */
  readonly saved = output<string>();

  readonly dialogMode = signal<MuiPresetsPanelDialogMode>('none');
  readonly pendingDeleteId = signal<string | null>(null);
  /** `confirmMode: 'inline'` only — the preset id currently flipped into
   * its "Delete “name”?" confirm row. */
  readonly confirmingDeleteId = signal<string | null>(null);
  readonly savePromptValue = signal<string>('');

  openSavePrompt(): void {
    this.savePromptValue.set('');
    this.dialogMode.set('savePrompt');
  }

  /** Pulled out of an inline three-part `@if` — the template reads one
   * method call instead of an `&&` chain (each occurrence counts as its
   * own branch to the complexity gate), same reasoning as
   * `export-dialog.component.ts`'s `formatDetail()`/`colorSpaceDetail()`. */
  isConfirmingDelete(id: string): boolean {
    return (
      this.showDeleteAction() && this.confirmMode() === 'inline' && this.confirmingDeleteId() === id
    );
  }

  /** `preset.updatedAt`/`.subtitle` default to `null` for `mui-list-row`'s
   * inputs — pulled out of the template's own `?? null` (each occurrence
   * is its own branch to the complexity gate), same reasoning as
   * `isConfirmingDelete` above. */
  timestampFor(preset: MuiPresetItem): Date | number | string | null {
    return preset.updatedAt ?? null;
  }

  subtitleFor(preset: MuiPresetItem): string | null {
    return preset.subtitle ?? null;
  }

  requestDelete(id: string, event: MouseEvent): void {
    event.stopPropagation();
    if (this.confirmMode() === 'inline') {
      this.confirmingDeleteId.set(id);
      return;
    }
    this.pendingDeleteId.set(id);
    this.dialogMode.set('confirmDelete');
  }

  cancelInlineDelete(): void {
    this.confirmingDeleteId.set(null);
  }

  confirmInlineDelete(id: string): void {
    this.deleted.emit(id);
    this.confirmingDeleteId.set(null);
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
