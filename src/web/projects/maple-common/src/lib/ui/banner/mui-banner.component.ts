// MuiBanner — Maple UI Molecules-L1 (unified-component-catalog.md §2.3).
// Inline status strip, built from Icon + Text + Link + Button. Per the
// catalog's per-molecule composition rule (§8: "a Banner uses ghost
// Buttons, not primary"), the action slot is always rendered as a ghost
// Button — there is no variant input for it.
//
// `loading` variant (MW2, #3029): the migrated `app-loading-banner`
// consumer needs an in-progress banner, not just the four static severity
// icons — a spinner communicates "in progress" the way a static icon can't.
// Swaps the icon slot for `<mui-spinner>` instead of an icon; every other
// variant keeps the static `<mui-icon>`.
//
// `role="alert"` for the `error` variant (MW2, #3029): the migrated
// `app-error-banner` consumer previously used `role="alert"` (assertive —
// announced immediately) rather than the generic `role="status"` (polite —
// announced when the screen reader is next idle). An error banner reporting
// a failed fetch needs the assertive announcement; the other three variants
// keep `role="status"`.

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { MuiButtonComponent } from '../button/mui-button.component';
import { MuiIconComponent } from '../icon/mui-icon.component';
import type { MapleIconName } from '../icon/mui-icon.component';
import { MuiLinkComponent } from '../link/mui-link.component';
import { MuiSpinnerComponent } from '../spinner/mui-spinner.component';
import { MuiTextComponent } from '../text/mui-text.component';

export type MuiBannerVariant = 'info' | 'success' | 'warning' | 'error' | 'loading';

const VARIANT_ICON: Partial<Record<MuiBannerVariant, MapleIconName>> = {
  info: 'info',
  success: 'check',
  warning: 'flag',
  error: 'clear-circle-fill',
};

@Component({
  selector: 'mui-banner',
  standalone: true,
  imports: [
    MuiButtonComponent,
    MuiIconComponent,
    MuiLinkComponent,
    MuiSpinnerComponent,
    MuiTextComponent,
  ],
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

  readonly icon = computed(() => VARIANT_ICON[this.variant()] ?? null);
  readonly role = computed(() => (this.variant() === 'error' ? 'alert' : 'status'));
}
