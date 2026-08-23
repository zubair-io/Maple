// MuiFormField — Maple UI Molecules-L1 (unified-component-catalog.md §2.1).
// Label + control + help/error, built from Text + Input + Text.

import { ChangeDetectionStrategy, Component, input, model, output } from '@angular/core';
import { MuiInputComponent } from '../input/mui-input.component';
import { MuiTextComponent } from '../text/mui-text.component';

export type MuiFormFieldVariant = 'default' | 'search' | 'numeric';

@Component({
  selector: 'mui-form-field',
  standalone: true,
  imports: [MuiInputComponent, MuiTextComponent],
  templateUrl: './mui-form-field.component.html',
  styleUrl: './mui-form-field.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiFormFieldComponent {
  readonly label = input.required<string>();
  readonly variant = input<MuiFormFieldVariant>('default');
  readonly value = model<string>('');
  readonly placeholder = input<string>('');
  readonly help = input<string | null>(null);
  readonly error = input<string | null>(null);
  readonly disabled = input<boolean>(false);
  readonly required = input<boolean>(false);

  /** Fires on the control's committed moment (Enter or blur). */
  readonly committed = output<string>();
}
