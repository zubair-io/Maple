// InfoFacesComponent — Self-Hosted enrichment "Faces" section.
//
// Renders detected-face count, tagged person chips (linking to the
// people settings page), and a stub chip for untagged faces, plus a
// "Re-detect" requeue button. The parent `<app-info-enrichment>`
// orchestrator owns the API call; this component is presentational.

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MapleCollapsibleComponent } from '../collapsible/maple-collapsible.component';
import { MapleIconComponent } from '../icons/maple-icon.component';
import {
  EnrichmentStageStatus,
  EnrichmentStatusBadgeComponent,
} from './enrichment-status-badge.component';
import { WORKERS_SETTINGS_URL, taggedFaces, untaggedFaceCount } from './enrichment.vm';
import type { ApiAssetDetail } from '../api/bun-api-backend.service';

@Component({
  selector: 'app-info-faces',
  standalone: true,
  imports: [
    MapleCollapsibleComponent,
    MapleIconComponent,
    EnrichmentStatusBadgeComponent,
    RouterLink,
  ],
  templateUrl: './info-faces.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block',
    'data-testid': 'info-faces',
  },
})
export class InfoFacesComponent {
  readonly detail = input.required<ApiAssetDetail>();
  readonly status = input.required<EnrichmentStageStatus>();
  readonly errorMessage = input<string | null>(null);
  readonly stale = input<boolean>(false);

  /** Re-detect click — parent owns the POST + poll start. */
  readonly requeue = output<void>();

  readonly WORKERS_SETTINGS_URL = WORKERS_SETTINGS_URL;

  protected taggedFaces = taggedFaces;
  protected untaggedFaceCount = untaggedFaceCount;

  protected onRequeue(): void {
    this.requeue.emit();
  }
}
