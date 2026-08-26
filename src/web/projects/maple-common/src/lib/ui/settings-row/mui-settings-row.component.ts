// MuiSettingsRow — Maple UI Molecules-L2 (unified-component-catalog.md §3).
// Collapsible labeled setting, built from Collapsible, Icon, Text, Divider.
//
// `customSummary` (MW1, ticket #3020): a settings-row whose collapsed header
// is a data-rich row — a status pill, a mono readout, an inline "Run now"
// button, a spacer — rather than a plain text label (the worker/import/mirror
// stage rows this component replaced `maple-settings-row` for). Delegating to
// `MuiCollapsibleComponent` only supports a plain-text header, so in this mode
// the row owns its own disclosure button + animated content region (same
// class names/behavior as `MuiCollapsibleComponent`'s, so existing consumers
// and specs targeting `.header`/`.chevron`/`.content-wrapper` keep working)
// and projects the summary content via the `[summary]` slot instead of
// rendering `label()`. `MuiCollapsibleComponent` itself is untouched — that
// migration is a separate wave (MW2).

import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, input, model } from '@angular/core';
import { MuiCollapsibleComponent } from '../collapsible/mui-collapsible.component';
import { MuiDividerComponent } from '../divider/mui-divider.component';
import { MuiIconComponent } from '../icon/mui-icon.component';
import type { MapleIconName } from '../icon/mui-icon.component';
import { MuiTextComponent } from '../text/mui-text.component';

@Component({
  selector: 'mui-settings-row',
  standalone: true,
  imports: [
    NgTemplateOutlet,
    MuiCollapsibleComponent,
    MuiDividerComponent,
    MuiIconComponent,
    MuiTextComponent,
  ],
  templateUrl: './mui-settings-row.component.html',
  styleUrl: './mui-settings-row.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiSettingsRowComponent {
  /** Required in the default (plain-text header) mode; unused when
   * `customSummary` is set (the `[summary]` slot supplies the header instead) —
   * still accepted there as the row's accessible name. */
  readonly label = input<string | null>(null);
  readonly icon = input<MapleIconName | null>(null);
  readonly description = input<string | null>(null);
  readonly open = model<boolean>(false);
  /** Renders a trailing divider below the row — off by default so a caller
   * stacking several rows in a list can supply the divider itself once,
   * between rows, rather than doubling it up. */
  readonly showDivider = input<boolean>(true);
  /** Switches the header from the default icon+label+description collapsible
   * to a projected `[summary]` slot the caller fully controls. */
  readonly customSummary = input<boolean>(false);

  toggle(): void {
    this.open.update((value) => !value);
  }

  /** The customSummary header is a `role="button"` div, not a real
   * `<button>` — the projected summary itself often contains real buttons
   * (e.g. a "Run now" action), and a `<button>` cannot legally nest another
   * `<button>`. Click-to-toggle is therefore guarded the same way the
   * `settings-row.component` it replaces was: a click that originated on a
   * nested interactive element activates that element only, not the row's
   * own toggle. */
  onSummaryClick(event: Event): void {
    if (this.isFromInteractive(event)) return;
    this.toggle();
  }

  /** Enter/Space toggles only when the row itself is focused — never when
   * the key event bubbled up from a projected interactive child, which
   * would otherwise both toggle the row and (for Space) swallow the child's
   * own activation. */
  onSummaryKeydown(event: KeyboardEvent): void {
    if (event.target !== event.currentTarget) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    this.toggle();
  }

  private isFromInteractive(event: Event): boolean {
    const target = event.target;
    return (
      target instanceof Element && target.closest('button, a, input, select, textarea') !== null
    );
  }
}
