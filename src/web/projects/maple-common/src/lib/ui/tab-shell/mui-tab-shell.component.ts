// MuiTabShell — Maple UI Templates (unified-component-catalog.md §5).
// Two-region layout: a Tab bar (`mui-tabs`) and a Content region. Backs the
// TV Timeline page (§6). Regions only — the tab data itself is the one
// exception, since the tab bar isn't a projected region but a driven
// instance of the existing `mui-tabs` molecule.
//
// Placement is "top on tablet/desktop, bottom on phone" per the catalog's
// "per breakpoint" note — done with a CSS container query (`@container`)
// rather than a ResizeObserver signal, since the only thing that changes is
// which edge of a flex column the tab bar sits on, which pure CSS handles
// without a JS round-trip. `placement` can still force one side explicitly
// (a caller that already knows its context, e.g. always-phone tvOS remote
// navigation, shouldn't have to fight the auto behavior).

import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';
import { MuiTabsComponent } from '../tabs/mui-tabs.component';
import type { MuiTab } from '../tabs/mui-tabs.component';

export type MuiTabShellPlacement = 'auto' | 'top' | 'bottom';

@Component({
  selector: 'mui-tab-shell',
  standalone: true,
  imports: [MuiTabsComponent],
  templateUrl: './mui-tab-shell.component.html',
  styleUrl: './mui-tab-shell.component.scss',
  host: { class: 'block h-full min-h-0 @container' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiTabShellComponent {
  readonly tabs = input.required<readonly MuiTab[]>();
  readonly activeId = model<string>('');
  readonly ariaLabel = input<string>('Tabs');
  /** 'auto' (default) switches to a bottom tab bar below the phone
   * container-query breakpoint; 'top'/'bottom' force one side regardless of
   * width. */
  readonly placement = input<MuiTabShellPlacement>('auto');

  readonly rootClass = computed(() => {
    const base = 'mui-tab-shell flex flex-col h-full min-h-0';
    if (this.placement() === 'bottom') return `${base} placement-bottom flex-col-reverse`;
    if (this.placement() === 'auto') return `${base} placement-auto`;
    return base;
  });
}
