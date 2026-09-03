// BatchSyncBannerComponent — the progress and result surface for a batch
// adjustment transfer (#2436).
//
// One component covering both halves of the run's life, because they are the
// same row to the user: while it runs it shows how far along it is and offers
// Cancel; when it finishes it states what happened and — if anything failed —
// offers Retry failed. Mirrors `DragMoveSummaryBannerComponent`'s toast shape,
// which is the established place in this shell for a background operation to
// report itself.

import { ChangeDetectionStrategy, Component, computed, inject, output } from '@angular/core';
import { BatchSyncService } from './batch-sync.service';
import { MuiButtonComponent } from '../../ui/button/mui-button.component';

@Component({
  selector: 'app-batch-sync-banner',
  standalone: true,
  imports: [MuiButtonComponent],
  templateUrl: './batch-sync-banner.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BatchSyncBannerComponent {
  protected readonly batch = inject(BatchSyncService);

  /** The user asked to re-run the failures; the shell owns the patch. */
  readonly retryFailed = output<void>();

  protected readonly progressText = computed<string | null>(() => {
    const p = this.batch.progress();
    if (!p) return null;
    const failed = p.failed > 0 ? ` · ${p.failed} failed` : '';
    return `Applying settings — ${p.processed} of ${p.total}${failed}`;
  });
}
