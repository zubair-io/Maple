// MuiBubbleMenu — the Maple UI design-system Bubble Menu molecule
// (unified-component-catalog.md §2.5; Built from: Icon, Divider). A floating
// contextual format bar (e.g. text-selection bold/italic/link toolbar),
// anchored via `mui-popover` — same open/placement/closeRequested contract
// as the other overlay molecules.

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { MuiPopoverComponent, type MuiPopoverPlacement } from '../popover/mui-popover.component';
import { MuiIconComponent } from '../icon/mui-icon.component';
import type { MapleIconName } from '../icon/mui-icon.component';
import { MuiDividerComponent } from '../divider/mui-divider.component';

export interface MuiBubbleMenuItem {
  readonly id: string;
  readonly icon: MapleIconName;
  readonly label: string;
  readonly active?: boolean;
  readonly divider?: false;
}

export interface MuiBubbleMenuDivider {
  readonly divider: true;
}

export type MuiBubbleMenuEntry = MuiBubbleMenuItem | MuiBubbleMenuDivider;

@Component({
  selector: 'mui-bubble-menu',
  standalone: true,
  imports: [MuiPopoverComponent, MuiIconComponent, MuiDividerComponent],
  templateUrl: './mui-bubble-menu.component.html',
  host: { class: 'contents' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiBubbleMenuComponent {
  readonly open = input<boolean>(false);
  readonly placement = input<MuiPopoverPlacement>('top');
  readonly entries = input.required<readonly MuiBubbleMenuEntry[]>();

  readonly itemSelected = output<string>();
  readonly closeRequested = output<void>();

  asItem(entry: MuiBubbleMenuEntry): MuiBubbleMenuItem | null {
    return 'divider' in entry && entry.divider ? null : (entry as MuiBubbleMenuItem);
  }
}
