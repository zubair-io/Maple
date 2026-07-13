// InfoPlaceComponent — Self-Hosted enrichment "Place" section.
//
// Renders the reverse-geocoded place from the Bun API enrichment payload
// with an inline manual-override editor (single-line display_name) and a
// "Re-geocode" requeue button. The parent `<app-info-enrichment>`
// orchestrator owns the API calls; this component is purely
// presentational. Stage state (status + error + stale flag) is computed
// in the parent and threaded in via inputs.
//
// Hidden by the parent (via `showPlaceSection()` in `enrichment.vm.ts`)
// when the worker already ran and produced "no place" for this asset.

import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MapleCollapsibleComponent } from '../collapsible/maple-collapsible.component';
import {
  EnrichmentStageStatus,
  EnrichmentStatusBadgeComponent,
} from './enrichment-status-badge.component';
import { WORKERS_SETTINGS_URL, formatRollups } from './enrichment.vm';
import type { ApiAssetDetail, ApiPlace } from '../api/bun-api-backend.service';

@Component({
  selector: 'app-info-place',
  standalone: true,
  imports: [MapleCollapsibleComponent, EnrichmentStatusBadgeComponent, RouterLink],
  templateUrl: './info-place.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block',
    'data-testid': 'info-place',
  },
})
export class InfoPlaceComponent {
  readonly detail = input.required<ApiAssetDetail>();
  readonly status = input.required<EnrichmentStageStatus>();
  /** Inline error string surfaced under the row after a failed save /
   * requeue. `null` hides the message. */
  readonly errorMessage = input<string | null>(null);
  /** True after the 30 s post-requeue poll deadline expires without
   * `done_at` flipping — the parent toggles it; we just render the hint. */
  readonly stale = input<boolean>(false);

  /** New override (or `null` to clear) — parent owns the PUT. */
  readonly save = output<ApiPlace | null>();
  /** Re-geocode click — parent owns the POST + poll start. */
  readonly requeue = output<void>();

  readonly WORKERS_SETTINGS_URL = WORKERS_SETTINGS_URL;
  protected readonly editing = signal(false);
  protected readonly draft = signal('');

  protected formatRollups = formatRollups;

  protected startEdit(): void {
    this.draft.set(this.detail().place?.display_name ?? '');
    this.editing.set(true);
  }

  protected cancelEdit(): void {
    this.editing.set(false);
    this.draft.set('');
  }

  protected saveEdit(): void {
    const text = this.draft().trim();
    const d = this.detail();
    // The override route accepts a full Place document (the worker's
    // output shape). For a manual single-line correction we synthesise
    // a minimal Place keyed off the existing one; if the row had no
    // place at all, we send a stub with display_name + everything else
    // empty so it at least surfaces in the UI.
    const next: ApiPlace | null = text
      ? {
          source: 'manual',
          geocoder_version: 0,
          geocoded_at: new Date().toISOString(),
          lat: d.place?.lat ?? 0,
          lon: d.place?.lon ?? 0,
          display_name: text,
          address: d.place?.address ?? {},
          pois: d.place?.pois ?? [],
          rollups: d.place?.rollups ?? {
            locality: null,
            region: null,
            country_code: null,
          },
          search_blob: text.toLowerCase(),
        }
      : null;
    this.save.emit(next);
    this.editing.set(false);
  }

  protected onRequeue(): void {
    this.requeue.emit();
  }

  protected onDraftInput(event: Event): void {
    this.draft.set((event.target as HTMLInputElement).value);
  }
}
