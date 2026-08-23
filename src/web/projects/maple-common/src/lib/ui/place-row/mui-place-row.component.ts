// MuiPlaceRow — Maple UI Molecules-L2 (unified-component-catalog.md §3).
// Geocoded place with override, built from Text, Input, Button. Displays the
// resolved place name; clicking it swaps in an Input to override, with a
// Clear action to drop the override back to the geocoded value.

import { ChangeDetectionStrategy, Component, input, model, output, signal } from '@angular/core';
import { MuiButtonComponent } from '../button/mui-button.component';
import { MuiInputComponent } from '../input/mui-input.component';
import { MuiTextComponent } from '../text/mui-text.component';
import { commitEditDraft, handleEditKeydown } from '../internal/edit-in-place';

@Component({
  selector: 'mui-place-row',
  standalone: true,
  imports: [MuiButtonComponent, MuiInputComponent, MuiTextComponent],
  templateUrl: './mui-place-row.component.html',
  styleUrl: './mui-place-row.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiPlaceRowComponent {
  readonly place = model<string>('');
  readonly overridden = input<boolean>(false);

  readonly committed = output<string>();
  readonly cleared = output<void>();

  readonly editing = signal(false);
  readonly draft = signal('');

  startEditing(): void {
    this.draft.set(this.place());
    this.editing.set(true);
  }

  commit(): void {
    if (!this.editing()) return;
    // Unlike a description, an empty place override is never committed.
    const next = commitEditDraft(this.draft(), this.place(), this.place, this.editing, false);
    if (next !== null) this.committed.emit(next);
  }

  onKeydown(event: KeyboardEvent): void {
    handleEditKeydown(
      event,
      () => this.commit(),
      () => this.editing.set(false),
    );
  }

  clear(): void {
    this.cleared.emit();
  }
}
