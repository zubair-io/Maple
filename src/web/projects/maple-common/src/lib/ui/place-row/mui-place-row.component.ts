// MuiPlaceRow — Maple UI Molecules-L2 (unified-component-catalog.md §3).
// Geocoded place with override, built from Text, Input, Button. Displays the
// resolved place name; clicking it swaps in an Input to override, with a
// Clear action to drop the override back to the geocoded value.

import { ChangeDetectionStrategy, Component, input, model, output } from '@angular/core';
import { MuiButtonComponent } from '../button/mui-button.component';
import { MuiInputComponent } from '../input/mui-input.component';
import { MuiTextComponent } from '../text/mui-text.component';
import { InlineEditBase, commitEditDraft } from '../internal/edit-in-place';

@Component({
  selector: 'mui-place-row',
  standalone: true,
  imports: [MuiButtonComponent, MuiInputComponent, MuiTextComponent],
  templateUrl: './mui-place-row.component.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiPlaceRowComponent extends InlineEditBase {
  readonly place = model<string>('');
  readonly overridden = input<boolean>(false);

  readonly committed = output<string>();
  readonly cleared = output<void>();

  protected currentValue(): string {
    return this.place();
  }

  commit(): void {
    if (!this.editing()) return;
    // Unlike a description, an empty place override is never committed.
    const next = commitEditDraft(this.draft(), this.place(), this.place, this.editing, false);
    if (next !== null) this.committed.emit(next);
  }

  clear(): void {
    this.cleared.emit();
  }
}
