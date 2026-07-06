// InfoDescriptionComponent — Self-Hosted enrichment "Description" section.
//
// Renders the qwen3-vl-authored description plus an inline manual
// override (textarea) and a "Re-describe" requeue button. The parent
// `<app-info-enrichment>` orchestrator owns the API calls; this
// component is purely presentational.

import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import { MapleCollapsibleComponent } from '../collapsible/maple-collapsible.component';
import {
  EnrichmentStageStatus,
  EnrichmentStatusBadgeComponent,
} from './enrichment-status-badge.component';
import { WORKERS_SETTINGS_URL } from './enrichment.vm';
import type { ApiAssetDetail } from '../api/bun-api-backend.service';

@Component({
  selector: 'app-info-description',
  standalone: true,
  imports: [MapleCollapsibleComponent, EnrichmentStatusBadgeComponent],
  templateUrl: './info-description.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block',
    'data-testid': 'info-description',
  },
})
export class InfoDescriptionComponent {
  readonly detail = input.required<ApiAssetDetail>();
  readonly status = input.required<EnrichmentStageStatus>();
  readonly errorMessage = input<string | null>(null);
  readonly stale = input<boolean>(false);

  /** New override text (or `null` to clear) — parent owns the PUT. */
  readonly save = output<string | null>();
  /** Re-describe click — parent owns the POST + poll start. */
  readonly requeue = output<void>();

  readonly WORKERS_SETTINGS_URL = WORKERS_SETTINGS_URL;
  protected readonly editing = signal(false);
  protected readonly draft = signal('');

  protected startEdit(): void {
    this.draft.set(this.detail().description ?? '');
    this.editing.set(true);
  }

  protected cancelEdit(): void {
    this.editing.set(false);
    this.draft.set('');
  }

  protected saveEdit(): void {
    const text = this.draft();
    this.save.emit(text.length > 0 ? text : null);
    this.editing.set(false);
  }

  protected onRequeue(): void {
    this.requeue.emit();
  }

  protected onDraftInput(event: Event): void {
    this.draft.set((event.target as HTMLTextAreaElement).value);
  }
}
