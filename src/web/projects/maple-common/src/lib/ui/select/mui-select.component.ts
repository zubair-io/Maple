import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

interface MuiSelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

/** Native single-choice control; the browser owns keyboard and popup semantics. */
@Component({
  selector: 'mui-select',
  standalone: true,
  templateUrl: './mui-select.component.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiSelectComponent {
  readonly value = input.required<string>();
  readonly options = input.required<readonly MuiSelectOption[]>();
  readonly ariaLabel = input.required<string>();
  readonly disabled = input(false);
  readonly valueChange = output<string>();

  onNativeChange(element: HTMLSelectElement): void {
    const selected = element.value;
    // The parent owns the accepted value, including asynchronous rejection.
    element.value = this.value();
    this.select(selected);
  }

  select(value: string): void {
    if (
      this.disabled() ||
      !this.options().some((option) => option.value === value && !option.disabled)
    )
      return;
    this.valueChange.emit(value);
  }
}
