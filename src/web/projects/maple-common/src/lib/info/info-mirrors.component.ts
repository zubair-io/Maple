// InfoMirrorsComponent — Self-Hosted Info "Backups" section.
//
// Read-only list of the focused asset's backup destinations and their
// per-destination state (`ApiAssetDetail.mirrors`, #4500). Kept as an
// app-level composition of mui atoms (`mui-collapsible`, `mui-text`,
// `mui-status-text`) like `<app-info-vision>`: a row needs several status
// texts side by side (paused AND failed), which no single molecule models.

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { MuiCollapsibleComponent } from '../ui/collapsible/mui-collapsible.component';
import { MuiStatusTextComponent } from '../ui/status-text/mui-status-text.component';
import { MuiTextComponent } from '../ui/text/mui-text.component';
import type { ApiAssetMirrorState } from '../api/bun-api-backend.service';
import { mirrorRows } from './info-mirrors.vm';

@Component({
  selector: 'app-info-mirrors',
  standalone: true,
  imports: [MuiCollapsibleComponent, MuiStatusTextComponent, MuiTextComponent],
  templateUrl: './info-mirrors.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block',
    'data-testid': 'info-mirrors',
  },
})
export class InfoMirrorsComponent {
  readonly mirrors = input.required<readonly ApiAssetMirrorState[]>();

  protected readonly rows = computed(() => mirrorRows(this.mirrors()));
}
