// BatchRenameResultsComponent — the 'done' phase of the Batch Rename dialog
// (#2640): the partial-failure summary line and the full per-file outcome
// list. Split out of `BatchRenameDialogComponent` for the same reason as
// `BatchRenameFormComponent` — see that component's module doc.

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { BatchRenamePreviewListComponent } from './batch-rename-preview-list.component';
import { applyResultToRow } from './batch-rename-preview-row';
import type { BatchRenameApplyResult } from './batch-rename.types';

@Component({
  selector: 'app-batch-rename-results',
  standalone: true,
  imports: [BatchRenamePreviewListComponent],
  templateUrl: './batch-rename-results.component.html',
  styleUrl: './batch-rename-results.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BatchRenameResultsComponent {
  readonly result = input.required<BatchRenameApplyResult>();
  /** "18 of 20 renamed, 2 skipped: collision" — computed by the parent
   * (`BatchRenameDialogComponent.summaryMessage`) since it's pure string
   * formatting over `result`, not view state this component owns. */
  readonly summary = input.required<string>();

  readonly close = output<void>();

  /** Normalized the same way `BatchRenameFormComponent.previewRows` is —
   * see `batch-rename-preview-row.ts`'s module doc. */
  readonly resultRows = computed(() => this.result().results.map(applyResultToRow));
}
