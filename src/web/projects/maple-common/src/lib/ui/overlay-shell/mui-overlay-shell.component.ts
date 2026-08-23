// MuiOverlayShell — Maple UI Templates (unified-component-catalog.md §5).
// Four-region modal layout: Scrim, Header, Body, Footer. The general-purpose
// surface every organism-level modal (Export, Batch Rename, Batch Metadata,
// Move To, …) is built on — §4.4's note "All built on the Overlay Shell
// template" is this component. Regions only — no content of its own.
// `mui-dialog` is a narrower, opinionated specialization of the same idea
// (fixed prompt/confirm copy + actions); this is the general shell for
// everything else.
//
// Dismissal mirrors mui-dialog/mui-popover: Escape (document-level, only
// while open) and an outside (scrim) click both emit `dismissed`, and the
// panel receives focus on open. Overlay Shell additionally does basic Tab
// focus containment (mui-popover's doc comment calls its own version
// "focus containment basics — not a full trap"; this one goes one step
// further and wraps Tab/Shift+Tab at the panel's first/last focusable
// element, since — unlike a Popover — this is meant to be truly modal).
//
// Scroll containment: Header and Footer are flex-shrink-0 chrome; only Body
// scrolls (`overflow: auto`), so long content never pushes the actions off
// screen.

import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { OverlayFocusBase } from '../internal/overlay-focus';

export type MuiOverlayShellSize = 'sm' | 'md' | 'lg' | 'full';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

@Component({
  selector: 'mui-overlay-shell',
  standalone: true,
  templateUrl: './mui-overlay-shell.component.html',
  styleUrl: './mui-overlay-shell.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiOverlayShellComponent extends OverlayFocusBase {
  readonly size = input<MuiOverlayShellSize>('md');
  /** Accessible name for the `role="dialog"` panel — there's no built-in
   * title (that's Header's job), so the caller supplies one directly. */
  readonly ariaLabel = input<string>('Dialog');
  /** Positions the scrim absolutely within the nearest positioned ancestor
   * instead of fixed to the viewport — for demoing/embedding the shell
   * without it hijacking the whole page (mirrors mui-toast-container's
   * `inline` input). */
  readonly contained = input<boolean>(false);

  /** Also traps Tab/Shift+Tab at the panel's first/last focusable element —
   * the one thing mui-dialog's Escape-only base behavior doesn't do (see
   * `OverlayFocusBase.handleNonEscapeKeydown`'s doc comment). */
  protected override handleNonEscapeKeydown(event: KeyboardEvent): void {
    if (event.key === 'Tab') this.trapTab(event);
  }

  private trapTab(event: KeyboardEvent): void {
    const panelEl = this.panel()?.nativeElement;
    if (!panelEl) return;
    const focusables = Array.from(panelEl.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    if (focusables.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = panelEl.ownerDocument.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }
}
