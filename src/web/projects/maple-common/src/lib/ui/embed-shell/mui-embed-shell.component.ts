// MuiEmbedShell — Maple UI Molecules-L2 (unified-component-catalog.md §3).
// Frame for embedded content, built from Page Header, Progress, Icon.

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { MuiIconComponent } from '../icon/mui-icon.component';
import type { MapleIconName } from '../icon/mui-icon.component';
import { MuiPageHeaderComponent } from '../page-header/mui-page-header.component';
import { MuiProgressComponent } from '../progress/mui-progress.component';

@Component({
  selector: 'mui-embed-shell',
  standalone: true,
  imports: [MuiIconComponent, MuiPageHeaderComponent, MuiProgressComponent],
  templateUrl: './mui-embed-shell.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
})
export class MuiEmbedShellComponent {
  readonly title = input.required<string>();
  readonly loading = input<boolean>(false);
  /** A small leading status glyph next to the title, e.g. a recording
   * indicator for a live embed. `null` shows nothing. */
  readonly statusIcon = input<MapleIconName | null>(null);
  readonly statusLabel = input<string | null>(null);
  readonly showBack = input<boolean>(true);

  readonly back = output<void>();
}
