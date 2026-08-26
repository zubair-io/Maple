// MuiButton — the Maple UI design-system Button atom
// (docs/design/maple-ui/components/button.md). Contract note: the catalog
// row (unified-component-catalog.md §1.1) lists a 5-way variant set
// (primary/secondary/outline/ghost/destructive), but the contract doc only
// defines four — its "Secondary" already reads as an outlined button
// (`color.border` outline, `color.surface` fill) — so there is no separate
// "outline" variant here. The contract wins per the wave-1 brief; flagged
// as a conflict in the wave-1 report.

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
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

  readonly pressed = output<MouseEvent>();

  readonly isDisabled = computed(() => this.disabled() || this.loading());
  readonly ariaExpandedAttr = computed(() => boolAttr(this.ariaExpanded()));
  readonly ariaPressedAttr = computed(() => boolAttr(this.ariaPressed()));

  onClick(event: MouseEvent): void {
    if (this.isDisabled()) return;
    this.pressed.emit(event);
  }
}
