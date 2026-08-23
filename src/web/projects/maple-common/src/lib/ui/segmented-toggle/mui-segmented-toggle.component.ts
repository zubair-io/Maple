// MuiSegmentedToggle — the Maple UI design-system Segmented Toggle atom
// (unified-component-catalog.md §1.3; no dedicated contract doc existed
// before wave 2 — see docs/design/maple-ui/components/segmented-toggle.md).
// A 2–3-way exclusive picker (e.g. Grid/List) with a sliding selection
// indicator, exposed as `role="radiogroup"` of `role="radio"` segments so
// assistive tech announces it as a single control with one selected value,
// not a row of independent buttons.

import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';

export interface MuiSegmentedToggleOption {
  readonly value: string;
  readonly label: string;
}

@Component({
  selector: 'mui-segmented-toggle',
  standalone: true,
  templateUrl: './mui-segmented-toggle.component.html',
  styleUrl: './mui-segmented-toggle.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'radiogroup',
    '[attr.aria-label]': 'ariaLabel()',
  },
})
export class MuiSegmentedToggleComponent {
  readonly options = input.required<readonly MuiSegmentedToggleOption[]>();
  readonly value = model.required<string>();
  readonly disabled = input<boolean>(false);
  readonly ariaLabel = input<string | null>(null);

  readonly selectedIndex = computed(() =>
    Math.max(
      0,
      this.options().findIndex((option) => option.value === this.value()),
    ),
  );

  select(option: MuiSegmentedToggleOption): void {
    if (this.disabled()) return;
    this.value.set(option.value);
  }
}
