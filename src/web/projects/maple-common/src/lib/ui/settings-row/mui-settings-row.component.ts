// MuiSettingsRow — Maple UI Molecules-L2 (unified-component-catalog.md §3).
// Collapsible labeled setting, built from Collapsible, Icon, Text, Divider.

import { ChangeDetectionStrategy, Component, input, model } from '@angular/core';
import { MuiCollapsibleComponent } from '../collapsible/mui-collapsible.component';
import { MuiDividerComponent } from '../divider/mui-divider.component';
import { MuiIconComponent } from '../icon/mui-icon.component';
import type { MapleIconName } from '../icon/mui-icon.component';
import { MuiTextComponent } from '../text/mui-text.component';

@Component({
  selector: 'mui-settings-row',
  standalone: true,
  imports: [MuiCollapsibleComponent, MuiDividerComponent, MuiIconComponent, MuiTextComponent],
  templateUrl: './mui-settings-row.component.html',
  styleUrl: './mui-settings-row.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiSettingsRowComponent {
  readonly label = input.required<string>();
  readonly icon = input<MapleIconName | null>(null);
  readonly description = input<string | null>(null);
  readonly open = model<boolean>(false);
  /** Renders a trailing divider below the row — off by default so a caller
   * stacking several rows in a list can supply the divider itself once,
   * between rows, rather than doubling it up. */
  readonly showDivider = input<boolean>(true);
}
