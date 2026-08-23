import { ChangeDetectionStrategy, Component } from '@angular/core';
import {
  MuiActionButtonComponent,
  MuiBadgeComponent,
  MuiButtonComponent,
  MuiDividerComponent,
  MuiIconComponent,
  MuiLinkComponent,
  MuiListComponent,
  MuiStatComponent,
  MuiTextComponent,
  MuiTimestampComponent,
} from '@maple-common';
import type { MuiListItem } from '@maple-common';

// Atom-tier specimens ported verbatim from the Unified Component Catalog
// canvas (Canvas.dc.html, claude.ai/design project 288a7180) — except the
// wave-1 Actions + Content atoms (Button, Action Button, Icon, Link, Text,
// Timestamp, Badge, Stat, Divider, List), which render the real `mui-*`
// components instead of the static mockup markup so this page can never
// drift from the shipped implementation. The other 12 atom cards stay
// static mockups pending wave 2.
@Component({
  selector: 'app-tier-atoms',
  imports: [
    MuiButtonComponent,
    MuiActionButtonComponent,
    MuiIconComponent,
    MuiLinkComponent,
    MuiTextComponent,
    MuiTimestampComponent,
    MuiBadgeComponent,
    MuiStatComponent,
    MuiDividerComponent,
    MuiListComponent,
  ],
  templateUrl: './tier-atoms.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TierAtomsComponent {
  // Fixed reference instant for the Timestamp specimen — a live `Date.now()`
  // would make the "2m ago" card silently drift as the page stays open.
  readonly timestampNow = new Date();
  readonly timestampRecent = new Date(this.timestampNow.getTime() - 2 * 60_000);
  readonly timestampOlder = new Date(this.timestampNow.getTime() - 3 * 24 * 60 * 60_000);

  readonly listItems: readonly MuiListItem[] = [{ text: 'First item' }, { text: 'Second item' }];
}
