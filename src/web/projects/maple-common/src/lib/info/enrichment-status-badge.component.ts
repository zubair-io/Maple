// Small badge that visualises an enrichment-stage status: failed, paused,
// skipped, running, pending, or complete. Extracted from the original
// `<maple-info-tab>` where the same 14-line block was inlined four times
// (once per stage). The component is dumb — the parent computes the
// StageStatus shape and passes it in along with the workers settings URL
// for the "paused" case.

import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

export interface EnrichmentStageStatus {
  kind: 'failed' | 'skipped' | 'paused' | 'running' | 'pending' | 'complete';
  label: string;
  tooltip?: string;
}

@Component({
  selector: 'app-enrichment-status-badge',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './enrichment-status-badge.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EnrichmentStatusBadgeComponent {
  status = input.required<EnrichmentStageStatus>();
  /** Link target for the paused-state anchor — typically /settings/workers. */
  pausedHref = input<string>('/settings/workers');
}
