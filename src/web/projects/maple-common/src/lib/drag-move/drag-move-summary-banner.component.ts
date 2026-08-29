// DragMoveSummaryBannerComponent — post-drop report for a drag-move/copy
// (#2644): "N of M moved to <folder>", plus a per-item failure breakdown
// when the relocate queue hit non-collision errors. Mirrors the inline
// `trashPartialWarning` banner `folder-tree.component.html` already renders
// for folder-trash partial failure — same shape, generalized to also cover
// the plain-success case (a drag-move that fully succeeds still gets a
// confirmation, since nothing else in this UI confirms a background move).

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { DragMoveSummary } from './drag-move.types';

@Component({
  selector: 'app-drag-move-summary-banner',
  standalone: true,
  templateUrl: './drag-move-summary-banner.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DragMoveSummaryBannerComponent {
  readonly summary = input.required<DragMoveSummary>();

  readonly dismiss = output<void>();

  protected readonly verb = computed(() => (this.summary().mode === 'copy' ? 'copied' : 'moved'));

  protected readonly headline = computed(() => {
    const s = this.summary();
    return `${s.moved} of ${s.total} ${s.moved === 1 ? 'photo' : 'photos'} ${this.verb()} to "${s.targetLabel}"`;
  });

  onDismiss(): void {
    this.dismiss.emit();
  }
}
