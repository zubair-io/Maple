// MuiDescriptionField — Maple UI Molecules-L2 (unified-component-catalog.md
// §3). Text with override and regenerate, built from Text, Input, Button.
// Displays generated/edited description text; clicking it (or its Edit
// affordance) swaps in an Input to override, and a Regenerate action
// requests a fresh AI-generated value from the caller.

import { ChangeDetectionStrategy, Component, input, model, output } from '@angular/core';
import { MuiButtonComponent } from '../button/mui-button.component';
import { MuiInputComponent } from '../input/mui-input.component';
import { MuiTextComponent } from '../text/mui-text.component';
import { InlineEditBase, commitEditDraft } from '../internal/edit-in-place';

@Component({
  selector: 'mui-description-field',
  standalone: true,
  imports: [MuiButtonComponent, MuiInputComponent, MuiTextComponent],
  templateUrl: './mui-description-field.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
})
export class MuiDescriptionFieldComponent extends InlineEditBase {
  readonly value = model<string>('');
  readonly regenerating = input<boolean>(false);
  readonly placeholder = input<string>('No description yet.');

  readonly regenerate = output<void>();
  readonly committed = output<string>();

  protected currentValue(): string {
    return this.value();
  }

  commit(): void {
    if (!this.editing()) return;
    // A description is allowed to be committed empty (clearing it).
    const next = commitEditDraft(this.draft(), this.value(), this.value, this.editing, true);
    if (next !== null) this.committed.emit(next);
  }

  onRegenerateClick(): void {
    this.regenerate.emit();
  }
}
