// MuiResultReportModal — Maple UI Organisms (Wave W6 Lane B). Per-item
// outcome report after a batch job (export, rename, …) — built from
// Overlay Shell, List Row, Badge, Empty State.

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { MuiBadgeComponent } from '../badge/mui-badge.component';
import type { MuiBadgeVariant } from '../badge/mui-badge.component';
import { MuiButtonComponent } from '../button/mui-button.component';
import { MuiEmptyStateComponent } from '../empty-state/mui-empty-state.component';
import { MuiListRowComponent } from '../list-row/mui-list-row.component';
import { MuiOverlayShellComponent } from '../overlay-shell/mui-overlay-shell.component';
import type { MapleIconName } from '../icon/mui-icon.component';

export type MuiResultStatus = 'success' | 'error' | 'skipped';

export interface MuiResultItem {
  readonly id: string;
  readonly label: string;
  readonly status: MuiResultStatus;
  readonly detail?: string | null;
}

const STATUS_BADGE_VARIANT: Record<MuiResultStatus, MuiBadgeVariant> = {
  success: 'count',
  error: 'signal',
  skipped: 'count',
};

const STATUS_ICON: Record<MuiResultStatus, MapleIconName> = {
  success: 'check',
  error: 'clear-circle-fill',
  skipped: 'flag',
};

const STATUS_LABEL: Record<MuiResultStatus, string> = {
  success: 'Success',
  error: 'Error',
  skipped: 'Skipped',
};

@Component({
  selector: 'mui-result-report-modal',
  standalone: true,
  imports: [
    MuiBadgeComponent,
    MuiButtonComponent,
    MuiEmptyStateComponent,
    MuiListRowComponent,
    MuiOverlayShellComponent,
  ],
  templateUrl: './mui-result-report-modal.component.html',
  host: { class: 'contents' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiResultReportModalComponent {
  readonly open = input<boolean>(false);
  readonly results = input.required<readonly MuiResultItem[]>();

  readonly dismissed = output<void>();
  readonly retryFailedRequested = output<readonly string[]>();

  readonly statusBadgeVariant = STATUS_BADGE_VARIANT;
  readonly statusIcon = STATUS_ICON;
  readonly statusLabel = STATUS_LABEL;

  readonly failedIds = computed(() =>
    this.results()
      .filter((result) => result.status === 'error')
      .map((result) => result.id),
  );

  readonly summary = computed(() => {
    const results = this.results();
    const succeeded = results.filter((r) => r.status === 'success').length;
    const failed = results.filter((r) => r.status === 'error').length;
    const skipped = results.filter((r) => r.status === 'skipped').length;
    return `${succeeded} succeeded, ${failed} failed, ${skipped} skipped`;
  });

  retryFailed(): void {
    if (this.failedIds().length === 0) return;
    this.retryFailedRequested.emit(this.failedIds());
  }

  onDismiss(): void {
    this.dismissed.emit();
  }
}
