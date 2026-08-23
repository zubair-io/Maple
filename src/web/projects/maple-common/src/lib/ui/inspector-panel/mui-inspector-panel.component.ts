// MuiInspectorPanel — Maple UI Organisms (unified-component-catalog.md
// §4.3). Tabbed right-side detail region, built from Tabs, Page Header. A
// thin shell: it owns the header and the tab strip's active-tab selection,
// but the body is entirely projected — the caller decides what to render
// for the active tab (typically switching in the parent template on
// `activeTabId`), matching the catalog's "hosting projected content"
// description exactly. No internal data states of its own.

import { ChangeDetectionStrategy, Component, input, model, output } from '@angular/core';
import { MuiPageHeaderComponent } from '../page-header/mui-page-header.component';
import { MuiTabsComponent } from '../tabs/mui-tabs.component';
import type { MuiTab } from '../tabs/mui-tabs.component';

@Component({
  selector: 'mui-inspector-panel',
  standalone: true,
  imports: [MuiPageHeaderComponent, MuiTabsComponent],
  templateUrl: './mui-inspector-panel.component.html',
  styleUrl: './mui-inspector-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiInspectorPanelComponent {
  readonly title = input.required<string>();
  readonly tabs = input.required<readonly MuiTab[]>();
  readonly showBack = input<boolean>(true);
  readonly showMore = input<boolean>(false);

  readonly activeTabId = model<string>('');

  readonly back = output<void>();
  readonly more = output<void>();
}
