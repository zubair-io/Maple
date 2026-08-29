// MuiAppShell — Maple UI Templates (unified-component-catalog.md §5).
// Root page layout: a Navigation region, a Content region, and an Overlay
// region that sits above both for toasts, banners, and dialogs. Regions
// only — no content of its own.
//
// Content projection uses a `slot` attribute so a caller can place elements
// into a named region: `<div slot="nav">…</div>`, `<div slot="overlay">…
// </div>`. Anything without a `slot` attribute lands in the default
// Content region. `mui-toast-container` and `mui-dialog` are already safe
// to project into `slot="overlay"` — both establish their own
// `pointer-events: auto` so the overlay region's `pointer-events: none`
// (which keeps an empty overlay from blocking clicks to Nav/Content below
// it) doesn't swallow their input.

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export type MuiAppShellNavPlacement = 'top' | 'side';

@Component({
  selector: 'mui-app-shell',
  standalone: true,
  templateUrl: './mui-app-shell.component.html',
  host: { class: 'block relative h-full min-h-0' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiAppShellComponent {
  /** 'top' (default) renders Navigation as a full-width bar above Content;
   * 'side' renders it as a rail beside Content. */
  readonly navPlacement = input<MuiAppShellNavPlacement>('top');

  /** `flex-row` for 'side' vs `flex-col` for 'top' — mutually exclusive
   * `flex-direction`, folded into one computed string per the conversion
   * recipe rather than a static class racing a conditional one. */
  readonly directionClasses = computed(() =>
    this.navPlacement() === 'side' ? 'flex-row' : 'flex-col',
  );

  /** `.side-nav > .nav { align-self: stretch }` only applied in side mode —
   * mutually exclusive with the default (no align-self override). */
  readonly navAlignClasses = computed(() => (this.navPlacement() === 'side' ? 'self-stretch' : ''));
}
