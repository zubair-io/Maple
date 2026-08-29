// MuiSpinner — the Maple UI design-system Spinner atom
// (unified-component-catalog.md §1.5; contract:
// docs/design/maple-ui/components/spinner.md). A small indeterminate
// indicator, inline or centered in its box, with a delay-before-show
// threshold so a load that resolves before the delay never flashes a
// spinner at all.

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export type MuiSpinnerSize = 'sm' | 'md';
export type MuiSpinnerPlacement = 'inline' | 'centered';

@Component({
  selector: 'mui-spinner',
  standalone: true,
  templateUrl: './mui-spinner.component.html',
  styleUrl: './mui-spinner.component.scss',
  host: { class: 'inline-flex' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiSpinnerComponent {
  readonly size = input<MuiSpinnerSize>('md');
  readonly placement = input<MuiSpinnerPlacement>('inline');
  /** Milliseconds to wait, via CSS `animation-delay`, before the spinner
   * becomes visible. */
  readonly delayMs = input<number>(0);
  readonly label = input<string>('Loading');

  readonly placementClasses = computed(() =>
    this.placement() === 'centered' ? 'items-center justify-center w-full' : '',
  );

  readonly ringSizeClasses = computed(() =>
    this.size() === 'sm' ? 'w-[14px] h-[14px] border-2' : 'w-5 h-5 border-2',
  );
}
