import { ChangeDetectionStrategy, Component } from '@angular/core';
import {
  MuiAppShellComponent,
  MuiDrawerShellComponent,
  MuiOverlayShellComponent,
  MuiSettingsShellComponent,
  MuiSheetShellComponent,
  MuiSplitLayoutComponent,
  MuiTabShellComponent,
} from '@maple-common';
import type { MuiTab } from '@maple-common';

// Template-tier specimens — Wave 5 (#3000). Every card now renders the real
// `mui-*` shell inside a fixed 260x140 dark chip instead of the static
// region-diagram markup this tier shipped with (ported verbatim from the
// Unified Component Catalog canvas), matching every other converted tier's
// "no drift from the shipped implementation" rationale. Region content is
// placeholder blocks using token-informed surfaces — Templates have no
// content of their own, so there's nothing else to project.
@Component({
  selector: 'app-tier-templates',
  imports: [
    MuiAppShellComponent,
    MuiSplitLayoutComponent,
    MuiTabShellComponent,
    MuiSettingsShellComponent,
    MuiOverlayShellComponent,
    MuiSheetShellComponent,
    MuiDrawerShellComponent,
  ],
  templateUrl: './tier-templates.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TierTemplatesComponent {
  readonly tabShellTabs: readonly MuiTab[] = [
    { id: 'timeline', label: 'Timeline' },
    { id: 'map', label: 'Map' },
  ];
  tabShellActiveId = 'timeline';

  sidebarWidth = 70;
  detailWidth = 60;

  drawerOpen = true;
}
