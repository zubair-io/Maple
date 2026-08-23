// MuiBanner — Maple UI Molecules-L1 (unified-component-catalog.md §2.3).
// Inline status strip, built from Icon + Text + Link + Button. Per the
// catalog's per-molecule composition rule (§8: "a Banner uses ghost
// Buttons, not primary"), the action slot is always rendered as a ghost
// Button — there is no variant input for it.

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { MuiButtonComponent } from '../button/mui-button.component';
import { MuiIconComponent } from '../icon/mui-icon.component';
import type { MapleIconName } from '../icon/mui-icon.component';
import { MuiLinkComponent } from '../link/mui-link.component';
import { MuiTextComponent } from '../text/mui-text.component';

export type MuiBannerVariant = 'info' | 'success' | 'warning' | 'error';

const VARIANT_ICON: Record<MuiBannerVariant, MapleIconName> = {
  info: 'info',
  success: 'check',
  warning: 'flag',
  error: 'clear-circle-fill',
};

@Component({
  selector: 'mui-banner',
  standalone: true,
  imports: [MuiButtonComponent, MuiIconComponent, MuiLinkComponent, MuiTextComponent],
  templateUrl: './mui-banner.component.html',
  styleUrl: './mui-banner.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiBannerComponent {
  readonly variant = input<MuiBannerVariant>('info');
  readonly message = input.required<string>();
  readonly linkLabel = input<string | null>(null);
  readonly linkHref = input<string | null>(null);
  readonly actionLabel = input<string | null>(null);
  readonly dismissible = input<boolean>(false);

  readonly actionPressed = output<void>();
  readonly dismissed = output<void>();

  readonly icon = computed(() => VARIANT_ICON[this.variant()]);
}
