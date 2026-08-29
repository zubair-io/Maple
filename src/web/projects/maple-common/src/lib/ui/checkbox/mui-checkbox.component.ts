// MuiCheckbox — the Maple UI design-system Checkbox atom
// (docs/design/maple-ui/components/checkbox.md). A binary or tri-state
// selection control, backed by a native `<input type="checkbox">` so the
// platform role/behavior (including the native indeterminate API) comes for
// free rather than being reimplemented on a styled `<div>`.

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

export type MuiCheckboxChecked = boolean | 'indeterminate';

@Component({
  selector: 'mui-checkbox',
  standalone: true,
  templateUrl: './mui-checkbox.component.html',
  host: { class: 'inline-flex' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiCheckboxComponent {
  readonly checked = input<MuiCheckboxChecked>(false);
  /** Almost every checkbox is labeled; when it genuinely isn't (e.g. a
   * select-all header cell), pass `ariaLabel` instead. */
  readonly label = input<string | null>(null);
  readonly ariaLabel = input<string | null>(null);
  readonly disabled = input<boolean>(false);
  /** Forwarded to the native control's `id` attribute — lets a caller pair
   * this checkbox with an external `<label for="...">` (e.g. a settings
   * `field-label` rendered outside this component's own template) in
   * addition to the internal `<label>` this component already wraps itself
   * in. Omitted entirely when unset. */
  readonly inputId = input<string | null>(null);

  readonly checkedChange = output<boolean>();

  readonly isChecked = computed(() => this.checked() === true);
  readonly isIndeterminate = computed(() => this.checked() === 'indeterminate');

  onChange(next: boolean): void {
    this.checkedChange.emit(next);
  }
}
