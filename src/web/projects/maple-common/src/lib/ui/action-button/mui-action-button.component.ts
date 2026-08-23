// MuiActionButton — the Maple UI design-system Action Button atom
// (docs/design/maple-ui/components/action-button.md). Compact icon+label
// pill used inside toolbars; unlike Button it always carries an icon and is
// meant to sit shoulder-to-shoulder with siblings of the same size.

import { ChangeDetectionStrategy, Component, output } from '@angular/core';
import { input } from '@angular/core';
import { MuiIconComponent } from '../icon/mui-icon.component';
import type { MapleIconName, MuiIconSize } from '../icon/mui-icon.component';

export type MuiActionButtonSize = 'sm' | 'md';
export type MuiActionButtonOrientation = 'horizontal' | 'stacked';

const ICON_SIZE_BY_BUTTON_SIZE: Record<MuiActionButtonSize, MuiIconSize> = {
  sm: 'xs',
  md: 'sm',
};

@Component({
  selector: 'mui-action-button',
  standalone: true,
  imports: [MuiIconComponent],
  templateUrl: './mui-action-button.component.html',
  styleUrl: './mui-action-button.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiActionButtonComponent {
  readonly icon = input.required<MapleIconName>();
  readonly label = input.required<string>();
  readonly size = input<MuiActionButtonSize>('md');
  readonly orientation = input<MuiActionButtonOrientation>('horizontal');
  readonly selected = input<boolean>(false);
  readonly disabled = input<boolean>(false);

  readonly pressed = output<MouseEvent>();

  readonly iconSize = () => ICON_SIZE_BY_BUTTON_SIZE[this.size()];

  onClick(event: MouseEvent): void {
    if (this.disabled()) return;
    this.pressed.emit(event);
  }
}
