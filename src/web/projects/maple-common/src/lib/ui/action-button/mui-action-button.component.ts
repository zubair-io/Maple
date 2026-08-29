// MuiActionButton — the Maple UI design-system Action Button atom
// (docs/design/maple-ui/components/action-button.md). Compact icon+label
// pill used inside toolbars; unlike Button it always carries an icon and is
// meant to sit shoulder-to-shoulder with siblings of the same size.

import { ChangeDetectionStrategy, Component, computed, output } from '@angular/core';
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
  host: { class: 'inline-flex' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiActionButtonComponent {
  readonly icon = input.required<MapleIconName>();
  readonly label = input.required<string>();
  readonly size = input<MuiActionButtonSize>('md');
  readonly orientation = input<MuiActionButtonOrientation>('horizontal');
  readonly selected = input<boolean>(false);
  readonly disabled = input<boolean>(false);
  /** Tooltip text — e.g. a label plus a "coming soon" note for a disabled
   * placeholder entry a caller still wants hoverable. Native `title`
   * attribute; omitted entirely when unset. */
  readonly title = input<string | null>(null);
  /** Removes the button from the accessibility tree and tab order
   * altogether (native `disabled` already blocks interaction and screen
   * reader activation, but leaves the button announced as a dimmed
   * control — some callers want a placeholder gone from assistive tech
   * entirely, mirroring a platform's `.accessibilityHidden(true)`). */
  readonly ariaHidden = input<boolean>(false);
  /** Shows a small accent dot at the icon's corner — a lightweight "this
   * control's underlying state differs from default" indicator, distinct
   * from `selected` (which reflects the toggle's own pressed state). */
  readonly modified = input<boolean>(false);

  readonly pressed = output<MouseEvent>();

  readonly iconSize = () => ICON_SIZE_BY_BUTTON_SIZE[this.size()];

  /** `selected` colors win outright over the default+hover pair — mutually
   * exclusive, one computed string per the conversion recipe (matches the
   * established mui-button `active`/`toggled` pattern). */
  readonly colorClasses = computed(() =>
    this.selected()
      ? 'bg-primary-dim text-primary border-primary'
      : 'bg-transparent text-text-muted border-transparent enabled:hover:bg-surface-hover enabled:hover:text-text-main',
  );

  readonly sizeClasses = computed(() =>
    this.size() === 'sm' ? 'text-[10px] p-1' : 'text-[11px] py-1 px-2',
  );

  readonly orientationClasses = computed(() =>
    this.orientation() === 'stacked' ? 'flex-col gap-[2px] text-center' : '',
  );

  onClick(event: MouseEvent): void {
    if (this.disabled()) return;
    this.pressed.emit(event);
  }
}
