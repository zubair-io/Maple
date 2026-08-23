// MuiDivider — the Maple UI design-system Divider atom
// (docs/design/maple-ui/components/divider.md). Contract note: the catalog
// row (unified-component-catalog.md §1.1) also calls for a centered-label
// variant ("OR" between two rules), but the contract's Props section only
// defines `orientation` and `emphasis` — no label. The contract wins per
// the wave-1 brief; flagged as a conflict in the wave-1 report (a labeled
// divider is undesigned pending a contract update).

import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type MuiDividerOrientation = 'horizontal' | 'vertical';
export type MuiDividerEmphasis = 'default' | 'high';

@Component({
  selector: 'mui-divider',
  standalone: true,
  templateUrl: './mui-divider.component.html',
  styleUrl: './mui-divider.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiDividerComponent {
  readonly orientation = input<MuiDividerOrientation>('horizontal');
  readonly emphasis = input<MuiDividerEmphasis>('default');
}
