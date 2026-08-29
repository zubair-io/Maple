// MuiButton — the Maple UI design-system Button atom
// (docs/design/maple-ui/components/button.md). Contract note: the catalog
// row (unified-component-catalog.md §1.1) lists a 5-way variant set
// (primary/secondary/outline/ghost/destructive), but the contract doc only
// defines four — its "Secondary" already reads as an outlined button
// (`color.border` outline, `color.surface` fill) — so there is no separate
// "outline" variant here. The contract wins per the wave-1 brief; flagged
// as a conflict in the wave-1 report.

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  input,
  output,
  viewChild,
} from '@angular/core';
import { MuiIconComponent } from '../icon/mui-icon.component';
import type { MapleIconName } from '../../icons/maple-icon.component';

export type MuiButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';
export type MuiButtonSize = 'sm' | 'md' | 'lg';

/** `null` stays absent (the attribute shouldn't exist when the caller hasn't
 * opted in); otherwise renders the ARIA-spec "true"/"false" string form. */
function boolAttr(value: boolean | null): string | null {
  return value == null ? null : value ? 'true' : 'false';
}

@Component({
  selector: 'mui-button',
  standalone: true,
  imports: [MuiIconComponent],
  templateUrl: './mui-button.component.html',
  styleUrl: './mui-button.component.scss',
  // `fullWidth` needs the HOST element itself (not just the inner real
  // <button>) to stretch inside a flex/grid container — e.g. a dropdown
  // menu column — hence a host binding rather than a template class. Bound
  // as one computed class string (rather than static `inline-flex` plus
  // conditional `flex`/`w-full`) so the two `display` utilities are never
  // both present at once — Tailwind's cascade order between two classes of
  // equal specificity isn't something the template should depend on.
  host: {
    '[class]': 'hostClasses()',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiButtonComponent {
  readonly variant = input<MuiButtonVariant>('secondary');
  readonly size = input<MuiButtonSize>('md');
  readonly disabled = input<boolean>(false);
  readonly loading = input<boolean>(false);
  readonly iconLeading = input<MapleIconName | null>(null);
  readonly iconTrailing = input<MapleIconName | null>(null);
  /** Icon-only mode: hides the projected label visually. `ariaLabel` is
   * then required to satisfy the contract's "never ship an icon-only
   * button with no accessible name" rule. */
  readonly iconOnly = input<boolean>(false);
  readonly ariaLabel = input<string | null>(null);
  /** For a button that discloses/toggles a region it controls (e.g. "Compare
   * faces" ↔ "Hide faces") — forwarded to the native button's
   * `aria-expanded`. `[attr.aria-expanded]` written directly on `<mui-button>`
   * lands on the custom-element host, not the interactive control inside it,
   * so this exists to reach the real button (MW1, ticket #3020). */
  readonly ariaExpanded = input<boolean | null>(null);
  /** For a two-state toggle button (e.g. a face-selection tile) — forwarded
   * to the native button's `aria-pressed`. Same host-vs-interactive-control
   * reasoning as `ariaExpanded` above. */
  readonly ariaPressed = input<boolean | null>(null);
  /** Forwarded to the native button's `aria-haspopup` (e.g. a kebab menu
   * trigger) — same host-vs-interactive-control reasoning as `ariaExpanded`. */
  readonly ariaHasPopup = input<'menu' | 'listbox' | 'true' | null>(null);
  /** Colored "on" state for a meaningful toggle/selection pill (e.g. Select
   * mode, an active Sort/Filter pill) — consolidates what MW4 found
   * duplicated as `.export-btn.is-active`/`.has-selection` across
   * `toolbar-actions.component.scss` and `asset-grid.component.scss`. */
  readonly active = input<boolean>(false);
  /** Subtler "pressed" overlay for an icon-only chrome toggle (e.g. a
   * sidebar or kebab-menu toggle) — consolidates `.chrome-btn.is-active`,
   * duplicated across `browse-shell.component.scss` and
   * `toolbar-actions.component.scss` (MW4). */
  readonly toggled = input<boolean>(false);
  /** Stretches to fill its container and left-aligns the label — a
   * dropdown/overflow-menu item rather than an inline pill (e.g.
   * `toolbar-actions.component.scss`'s collapsed kebab menu, MW4 ticket
   * #3031). */
  readonly fullWidth = input<boolean>(false);
  /** Forwarded to the native button's `data-testid` — same
   * host-vs-interactive-control reasoning as `ariaExpanded`: a caller's
   * integration test needs to find and click the real `<button>`, not
   * `<mui-button>`'s own custom-element host. */
  readonly testId = input<string | null>(null);

  readonly pressed = output<MouseEvent>();

  readonly isDisabled = computed(() => this.disabled() || this.loading());
  readonly ariaExpandedAttr = computed(() => boolAttr(this.ariaExpanded()));
  readonly ariaPressedAttr = computed(() => boolAttr(this.ariaPressed()));

  readonly hostClasses = computed(() =>
    this.fullWidth() ? 'flex w-full is-full-width' : 'inline-flex',
  );

  /** Icon-only mode pads evenly and forces a square box (button.md §hit
   * target); otherwise padding follows `size`. Kept as one computed string
   * (rather than separate static + conditional classes) so only one
   * `px-*`/`py-*` pair is ever present — two same-specificity padding
   * utilities racing for the cascade would be undefined behavior. */
  readonly paddingClasses = computed(() => {
    if (this.iconOnly()) return 'p-2 aspect-square';
    switch (this.size()) {
      case 'sm':
        return 'px-2 py-1';
      case 'lg':
        return 'px-6 py-2';
      default:
        return 'px-4 py-2';
    }
  });

  readonly fontSizeClasses = computed(() => {
    switch (this.size()) {
      case 'sm':
        return 'text-xs';
      case 'lg':
        return 'text-sm';
      default:
        return 'text-[13px]';
    }
  });

  /** `fullWidth` left-aligns the label instead of centering it — mutually
   * exclusive with the default centered layout, so this is one computed
   * pair rather than a static `justify-center` racing a conditional
   * `justify-start`. */
  readonly layoutClasses = computed(() =>
    this.fullWidth() ? 'w-full justify-start' : 'justify-center',
  );

  /** `active`/`toggled` win over the variant's own color regardless of which
   * variant they're layered on (button.md — colored "on" state, subtler
   * chrome-toggle overlay). Folded into one computed string, mutually
   * exclusive with the plain per-variant colors, for the same
   * one-utility-set-at-a-time reason as `paddingClasses`/`layoutClasses`. */
  readonly colorClasses = computed(() => {
    if (this.active()) return 'bg-primary-dim text-primary border-primary';
    if (this.toggled()) return 'bg-[rgba(255,255,255,0.04)] border-border text-text-main';
    switch (this.variant()) {
      case 'primary':
        return 'bg-primary text-text-main border-primary enabled:hover:brightness-110 enabled:hover:-translate-y-0.5';
      case 'ghost':
        return 'bg-transparent text-text-muted border-transparent enabled:hover:bg-surface-hover enabled:hover:text-text-main';
      case 'destructive':
        // No dedicated "destructive fill" token exists yet in ui_tokens.rs
        // (per button.md's own noted gap) — approximated with the error
        // banner tones until a follow-up foundation task adds one.
        return 'bg-error-bg text-error-text border-error-text enabled:hover:brightness-110 enabled:hover:-translate-y-0.5';
      default:
        return 'bg-surface text-text-main border-border enabled:hover:bg-surface-hover enabled:hover:-translate-y-0.5';
    }
  });

  private readonly nativeButton = viewChild<ElementRef<HTMLButtonElement>>('nativeButton');

  onClick(event: MouseEvent): void {
    if (this.isDisabled()) return;
    this.pressed.emit(event);
  }

  /** Forwards focus to the native `<button>` — needed by callers that
   * manage focus onto a specific `<mui-button>` themselves (e.g.
   * `<mui-dialog>` focusing its Cancel action on open for a destructive
   * confirm, MW2 #3029), since `<mui-button>` is a custom element and
   * `HTMLElement.focus()` on the host would target the wrong node. */
  focus(): void {
    this.nativeButton()?.nativeElement.focus();
  }
}
