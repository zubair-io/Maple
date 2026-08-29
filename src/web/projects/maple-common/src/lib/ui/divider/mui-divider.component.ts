// MuiDivider — the Maple UI design-system Divider atom
// (docs/design/maple-ui/components/divider.md). Contract note: the catalog
// row (unified-component-catalog.md §1.1) also calls for a centered-label
// variant ("OR" between two rules), but the contract's Props section only
// defines `orientation` and `emphasis` — no label. The contract wins per
// the wave-1 brief; flagged as a conflict in the wave-1 report (a labeled
// divider is undesigned pending a contract update).

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export type MuiDividerOrientation = 'horizontal' | 'vertical';
export type MuiDividerEmphasis = 'default' | 'high';

@Component({
  selector: 'mui-divider',
  standalone: true,
  templateUrl: './mui-divider.component.html',
  host: { class: 'contents' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiDividerComponent {
  readonly orientation = input<MuiDividerOrientation>('horizontal');
  readonly emphasis = input<MuiDividerEmphasis>('default');

  readonly orientationClasses = computed(() =>
    this.orientation() === 'vertical' ? 'w-px h-full' : 'w-full h-px',
  );

  readonly emphasisClasses = computed(() =>
    this.emphasis() === 'high' ? 'bg-border-hi' : 'bg-border',
  );
}
