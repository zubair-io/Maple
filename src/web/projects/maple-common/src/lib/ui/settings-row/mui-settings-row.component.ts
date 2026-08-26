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
  /** The row's accessible name. Required in every mode, including
   * `customSummary` — the projected `[summary]` slot supplies the *visible*
   * header content, but this is still the only text fed to the disclosure
   * button's `aria-label`, so a `customSummary` consumer with no visible
   * label text of its own (e.g. a status pill row) must still pass a
   * non-empty string here. */
  readonly label = input.required<string>();
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

  /** `aria-controls` target for the customSummary disclosure button, and the
   * `id` of the content region it points at. A plain per-instance counter is
   * enough — this only needs to be unique within one rendered page. */
  private static nextContentId = 0;
  protected readonly contentId = `mui-settings-row-body-${MuiSettingsRowComponent.nextContentId++}`;

  toggle(): void {
    this.open.update((value) => !value);
  }

  /** The customSummary header's `.header` wrapper is a plain, non-semantic
   * `<div>` — the projected summary itself often contains real interactive
   * controls (e.g. a "Run now" button), and nesting interactive elements
   * inside an ARIA `role="button"` is invalid (assistive tech flattens the
   * subtree, making the nested controls unreachable). This click handler is
   * therefore pointer-only convenience, guarded so a click that lands on a
   * nested interactive element — including the real `<button>` disclosure
   * toggle itself — activates that element only, not the row's own toggle;
   * the keyboard/AT path is exclusively that `<button>`, which handles
   * Enter/Space natively. */
  onSummaryClick(event: Event): void {
    if (this.isFromInteractive(event)) return;
    this.toggle();
  }

  private isFromInteractive(event: Event): boolean {
    const target = event.target;
    return (
      target instanceof Element &&
      target.closest('button, a, input, select, textarea, label') !== null
    );
  }
}
