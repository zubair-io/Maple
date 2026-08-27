// MuiToast — the Maple UI design-system Toast atom
// (unified-component-catalog.md §1.5; contract:
// docs/design/maple-ui/components/toast.md). A transient notification with
// an optional action, auto-dismiss timing, and enter/exit motion built from
// the shared `MapleMotion` vocabulary (sheet present/dismiss durations —
// the closest existing pair to a toast's own slide-and-fade).

import {
  ChangeDetectionStrategy,
  Component,
  OnChanges,
  OnDestroy,
  SimpleChanges,
  computed,
  input,
  output,
  signal,
} from '@angular/core';
import { MuiIconComponent } from '../icon/mui-icon.component';
import type { MapleIconName } from '../icon/mui-icon.component';
import { MapleMotion } from '../../motion';

export type MuiToastVariant = 'info' | 'success' | 'warning' | 'error';
/** `glass` swaps the flat app-chrome surface for the editor canvas's glass
 * material (`--pro-glass-*`, pro-tokens.scss) — for a toast that has to stay
 * legible floating over live photo pixels rather than page chrome (toast
 * sweep, ticket #3043). */
export type MuiToastSurface = 'default' | 'glass';

const VARIANT_ICON: Record<MuiToastVariant, MapleIconName> = {
  info: 'info',
  success: 'check',
  warning: 'flag',
  error: 'clear-circle-fill',
};

const VARIANT_ICON_COLOR: Record<MuiToastVariant, string> = {
  info: 'var(--color-text-muted)',
  success: 'var(--color-success-text)',
  warning: 'var(--color-warn)',
  error: 'var(--color-error-text)',
};

@Component({
  selector: 'mui-toast',
  standalone: true,
  imports: [MuiIconComponent],
  templateUrl: './mui-toast.component.html',
  styleUrl: './mui-toast.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { role: 'status', 'aria-live': 'polite', '[attr.aria-label]': 'ariaLabel()' },
})
export class MuiToastComponent implements OnChanges, OnDestroy {
  readonly variant = input<MuiToastVariant>('info');
  readonly message = input.required<string>();
  readonly actionLabel = input<string | null>(null);
  /** `null` disables auto-dismiss (the toast stays until closed by hand). */
  readonly autoDismissMs = input<number | null>(5000);
  /** Hides the close button for a toast whose dismissal is meant to stay in
   * the caller's hands — e.g. a persistent capability warning the user
   * shouldn't be able to lose track of (toast sweep, ticket #3043). Default
   * `true` keeps every existing caller's built-in close affordance. */
  readonly dismissible = input<boolean>(true);
  /** Overrides the host's accessible name — for callers with more than one
   * concurrent toast whose meaning isn't obvious from `role="status"` alone
   * (toast sweep, ticket #3043). */
  readonly ariaLabel = input<string | null>(null);
  /** `glass` swaps the flat app-chrome surface for the editor canvas's glass
   * material — see `MuiToastSurface`. */
  readonly surface = input<MuiToastSurface>('default');

  readonly actionPressed = output<void>();
  readonly dismissed = output<void>();

  readonly icon = computed(() => VARIANT_ICON[this.variant()]);
  readonly iconColor = computed(() => VARIANT_ICON_COLOR[this.variant()]);
  readonly entered = signal(false);
  readonly leaving = signal(false);

  private autoDismissTimer: ReturnType<typeof setTimeout> | null = null;
  private exitTimer: ReturnType<typeof setTimeout> | null = null;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['message'] || changes['autoDismissMs']) {
      this.clearTimers();
      // Enter transition: flip to `entered` on the next tick so the
      // 0 -> 1 CSS transition actually runs instead of starting "already in".
      this.entered.set(false);
      this.leaving.set(false);
      setTimeout(() => this.entered.set(true), 0);
      this.scheduleAutoDismiss();
    }
  }

  ngOnDestroy(): void {
    this.clearTimers();
  }

  onActionClick(): void {
    this.actionPressed.emit();
  }

  dismiss(): void {
    if (this.leaving()) return;
    this.clearTimers();
    this.leaving.set(true);
    this.exitTimer = setTimeout(() => {
      this.dismissed.emit();
    }, MapleMotion.sheetDismiss.ms);
  }

  private scheduleAutoDismiss(): void {
    const ms = this.autoDismissMs();
    if (ms === null) return;
    this.autoDismissTimer = setTimeout(() => this.dismiss(), ms);
  }

  private clearTimers(): void {
    if (this.autoDismissTimer !== null) clearTimeout(this.autoDismissTimer);
    if (this.exitTimer !== null) clearTimeout(this.exitTimer);
    this.autoDismissTimer = null;
    this.exitTimer = null;
  }
}
