// MuiSettingsShell — Maple UI Templates (unified-component-catalog.md §5).
// Two-region layout: a Section nav (fixed width) and a Pane (max-width,
// centered). Backs the Settings and Admin pages (§6). Regions only — no
// content of its own.
//
// Below a phone-width container-query breakpoint, the fixed-width nav
// column stacks above the pane at full width instead of sitting beside it
// (mirrors the iOS Settings app's list-then-detail pattern rather than
// trying to fit two columns on a phone).

import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'mui-settings-shell',
  standalone: true,
  templateUrl: './mui-settings-shell.component.html',
  styleUrl: './mui-settings-shell.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiSettingsShellComponent {
  readonly navWidth = input<number>(240);
  readonly paneMaxWidth = input<number>(640);
}
