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
  // menu column — hence a host binding rather than a template class.
  host: {
    '[class.is-full-width]': 'fullWidth()',
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
