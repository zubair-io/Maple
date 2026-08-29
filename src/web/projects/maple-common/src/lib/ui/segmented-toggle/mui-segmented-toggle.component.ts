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
    class: 'inline-flex',
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

  /** Mutually-exclusive: disabled changes `opacity`/`pointer-events`, both
   * only ever set here — never a base class plus a conditional add-on. */
  readonly trackClasses = computed(() =>
    this.disabled()
      ? 'track is-disabled relative flex gap-[2px] rounded-md bg-surface p-[3px] opacity-45 pointer-events-none'
      : 'track relative flex gap-[2px] rounded-md bg-surface p-[3px]',
  );

  private static readonly SEGMENT_BASE =
    'segment relative z-1 flex-1 cursor-pointer whitespace-nowrap rounded-sm border-none bg-transparent px-4 py-1 text-[12px] font-semibold text-text-muted transition-[color_150ms] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--color-primary)_20%,transparent)]';
  private static readonly SEGMENT_SELECTED = 'is-selected text-text-main';

  /** Mutually-exclusive: only `color` changes between selected/unselected,
   * both set by the base class. */
  segmentClasses(optionValue: string): string {
    const base = MuiSegmentedToggleComponent.SEGMENT_BASE;
    return optionValue === this.value()
      ? `${base} ${MuiSegmentedToggleComponent.SEGMENT_SELECTED}`
      : base;
  }

  select(option: MuiSegmentedToggleOption): void {
    if (this.disabled()) return;
    this.value.set(option.value);
  }
}
