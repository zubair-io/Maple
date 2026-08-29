// MuiToastContainer — Maple UI Molecules-L1 (unified-component-catalog.md
// §2.3). Stacks and positions Toast atoms; each slot's exit gets a small
// per-index delay so a multi-toast dismissal cascades rather than all
// vanishing on the same frame.

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { MuiToastComponent } from '../toast/mui-toast.component';
import type { MuiToastVariant } from '../toast/mui-toast.component';

export interface MuiToastEntry {
  readonly id: string;
  readonly variant: MuiToastVariant;
  readonly message: string;
  readonly actionLabel?: string | null;
  readonly autoDismissMs?: number | null;
}

export type MuiToastContainerPosition = 'top-right' | 'bottom-right' | 'bottom-center';

const EXIT_STAGGER_MS = 60;

@Component({
  selector: 'mui-toast-container',
  standalone: true,
  imports: [MuiToastComponent],
  templateUrl: './mui-toast-container.component.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiToastContainerComponent {
  readonly toasts = input.required<readonly MuiToastEntry[]>();
  readonly position = input<MuiToastContainerPosition>('bottom-right');
  /** Positions the stack relative to its nearest positioned ancestor instead
   * of the viewport — for a toast stack scoped to one panel rather than the
   * whole app (e.g. embedded previews, split-panel layouts). */
  readonly inline = input<boolean>(false);

  readonly actionPressed = output<string>();
  readonly dismissed = output<string>();

  readonly exitStaggerMs = EXIT_STAGGER_MS;

  private static readonly POSITION_CLASS: Record<MuiToastContainerPosition, string> = {
    'top-right': 'position-top-right top-6 right-6 items-end',
    'bottom-right': 'position-bottom-right bottom-6 right-6 items-end flex-col-reverse',
    'bottom-center':
      'position-bottom-center bottom-6 left-1/2 -translate-x-1/2 items-center flex-col-reverse',
  };

  readonly containerClass = computed(() => {
    const base = 'mui-toast-container z-[100] flex flex-col gap-2 pointer-events-none';
    const position = MuiToastContainerComponent.POSITION_CLASS[this.position()];
    const placement = this.inline() ? 'is-inline absolute' : 'fixed';
    return `${base} ${placement} ${position}`;
  });
}
