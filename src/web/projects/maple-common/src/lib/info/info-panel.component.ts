// InfoPanelComponent — Responsive-program S6 Info content (web side).
//
// Spec: docs/design/responsive-program/s6-info-inspector.md.
// Tracking ticket: #621 (closed by PR #637). #634 follow-up consolidates
// the former `<maple-info-tab>` enrichment surface into this component
// (renders conditionally when `LIBRARY_BACKEND === 'self-hosted'`).
//
// One component, two slots:
//   • Phone bottom sheet (`<app-bottom-sheet>`) triggered by the `i` icon
//     in the Editor (S5) header. `[insideSheet]="true"` renders an inline
//     sheet header (title + close X) because the bottom sheet primitive
//     ships only a grab handle.
//   • Tablet / desktop right inspector pane. `[insideSheet]="false"`
//     drops the sheet header because the parent panel's tab bar already
//     labels the panel "Info".
//
// Sections (rendered top-to-bottom):
//   1. <app-rating-flags-row>      — pick/unflag/reject pills + 5 stars.
//   2. <app-info-histogram>        — server-rendered RGB curves placeholder
//                                    until the API endpoint lands.
//   3. <app-camera-location-grid>  — 2-col EXIF / GPS key-value grid.
//   4. <app-keyword-chips-row>     — read-only chips in v0.1; the `+ add`
//                                    affordance opens a stub message until
//                                    the keyword-editing model work lands.
//   5. <app-info-enrichment>       — Self-Hosted only: place / description /
//                                    vision / faces. Owns the detail fetch,
//                                    worker-status cache, requeue, polling.

import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import type { Asset } from '../models/asset';
import { LIBRARY_BACKEND } from '../api/library-backend.token';
import { RatingFlagsRowComponent } from './rating-flags-row.component';
import { InfoHistogramComponent } from './histogram.component';
import { CameraLocationGridComponent } from './camera-location-grid.component';
import { KeywordChipsRowComponent } from './keyword-chips-row.component';
import { InfoEnrichmentComponent } from './info-enrichment.component';

@Component({
  selector: 'app-info-panel',
  standalone: true,
  imports: [
    RatingFlagsRowComponent,
    InfoHistogramComponent,
    CameraLocationGridComponent,
    KeywordChipsRowComponent,
    InfoEnrichmentComponent,
  ],
  templateUrl: './info-panel.component.html',
  styleUrl: './info-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    'data-testid': 'info-panel',
    class: 'block bg-sidebar overflow-auto',
    '[class.inside-sheet]': 'insideSheet()',
  },
})
export class InfoPanelComponent {
  private readonly backend = inject(LIBRARY_BACKEND);

  /** Focused asset whose info to render. `null` keeps the layout stable
   * (each section degrades to placeholder values) so the panel doesn't
   * jump between empty and populated states. */
  readonly asset = input<Asset | null>(null);

  /** `true` on the phone bottom-sheet slot — renders the in-content
   * header (title + close X). `false` on the tablet/desktop inspector
   * pane, where the parent tab bar already says "Info". */
  readonly insideSheet = input<boolean>(false);

  /** Phone-only dismiss signal for the sheet's close X. Ignored when
   * `insideSheet=false`. */
  readonly close = output<void>();

  /** Self-Hosted is the only backend that serves the enrichment payload
   * (place / description / vision / faces). Hosted browses the local
   * FS via FSA — no server-side workers, so no enrichment surface. */
  protected readonly showEnrichment = computed(() => this.backend === 'self-hosted');

  onClose(): void {
    this.close.emit();
  }
}
