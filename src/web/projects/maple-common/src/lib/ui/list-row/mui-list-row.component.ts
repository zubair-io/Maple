// MuiListRow — Maple UI Molecules-L1 (unified-component-catalog.md §2.2;
// binding contract: docs/design/maple-ui/components/list-row.md). Row
// with metadata and inline actions, built from Icon, Text, Timestamp,
// Button. The base horizontal row primitive for settings rows, tree/folder
// rows, and filterable list items.
//
// Contract notes followed exactly: Active is `surface_alt` fill + a 2px
// `primary` left border — never a full primary fill. Active composes with
// (doesn't replace) Hover, since Active is a persistent selection state, not
// a transient interaction state. `trailing` is composed content (value text,
// icon, toggle, chevron, or a Button), not a fixed enum, so it's a
// projected slot rather than a typed input.

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { MuiIconComponent } from '../icon/mui-icon.component';
import type { MapleIconName } from '../icon/mui-icon.component';
import { MuiTextComponent } from '../text/mui-text.component';
import { MuiTimestampComponent } from '../timestamp/mui-timestamp.component';
import { handleActivationKeydown } from '../internal/activation-keydown';

@Component({
  selector: 'mui-list-row',
  standalone: true,
  imports: [MuiIconComponent, MuiTextComponent, MuiTimestampComponent],
  templateUrl: './mui-list-row.component.html',
  styleUrl: './mui-list-row.component.scss',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiListRowComponent {
  readonly icon = input<MapleIconName | null>(null);
  readonly label = input.required<string>();
  /** Plain-text subtitle. Ignored when `timestampValue` is set. */
  readonly subtitle = input<string | null>(null);
  /** Renders the subtitle as a relative Timestamp instead of plain text
   * (e.g. "Edited 2m ago"). Takes priority over `subtitle`. */
  readonly timestampValue = input<Date | number | string | null>(null);
  readonly active = input<boolean>(false);
  readonly disabled = input<boolean>(false);
  /** Forwarded to the row's own interactive `[role="button"]` element's
   * `data-testid` — not `<mui-list-row>`'s custom-element host, which
   * carries no click/keydown handling of its own. */
  readonly testId = input<string | null>(null);

  /** The contract's `onPress` — fires on a click/tap anywhere in the row. */
  readonly pressed = output<void>();

  onRowClick(): void {
    if (this.disabled()) return;
    this.pressed.emit();
  }

  onKeydown(event: KeyboardEvent): void {
    handleActivationKeydown(event, () => this.onRowClick());
  }
}
