// MuiPipelineMonitor — Maple UI Organisms, Wave W6 Lane B "Configuration"
// (docs/unified-component-catalog.md §4.8). Live per-stage status and
// metrics for the worker pipeline (src/api/src/workers/stages/ — exif,
// thumb, describe, geocode), built from ListRow, Progress, Badge,
// EmptyState.
//
// Badge only has two pill tones (`count` = neutral, `signal` = warn), so
// status is carried by the pill's text value plus a colored leading icon on
// the row rather than a five-way badge palette that doesn't exist on the
// atom.

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { MapleIconName } from '../icon/mui-icon.component';
import { MuiBadgeComponent } from '../badge/mui-badge.component';
import type { MuiBadgeVariant } from '../badge/mui-badge.component';
import { MuiButtonComponent } from '../button/mui-button.component';
import { MuiEmptyStateComponent } from '../empty-state/mui-empty-state.component';
import { MuiIconComponent } from '../icon/mui-icon.component';
import { MuiListRowComponent } from '../list-row/mui-list-row.component';
import { MuiProgressComponent } from '../progress/mui-progress.component';
import { MuiTextComponent } from '../text/mui-text.component';

export type MuiPipelineStageStatus = 'running' | 'paused' | 'done' | 'error';

export interface MuiPipelineStage {
  readonly id: string;
  readonly name: string;
  readonly status: MuiPipelineStageStatus;
  readonly processed: number;
  readonly total: number;
}

const STATUS_LABEL: Record<MuiPipelineStageStatus, string> = {
  running: 'Running',
  paused: 'Paused',
  done: 'Done',
  error: 'Error',
};

const STATUS_BADGE_VARIANT: Record<MuiPipelineStageStatus, MuiBadgeVariant> = {
  running: 'signal',
  paused: 'count',
  done: 'count',
  error: 'signal',
};

const STATUS_ICON: Record<MuiPipelineStageStatus, MapleIconName> = {
  running: 'history',
  paused: 'dot',
  done: 'check',
  error: 'clear-circle-fill',
};

const STATUS_ICON_COLOR: Record<MuiPipelineStageStatus, string> = {
  running: 'var(--color-warn)',
  paused: 'var(--color-text-muted)',
  done: 'var(--color-success-text)',
  error: 'var(--color-error-text)',
};

@Component({
  selector: 'mui-pipeline-monitor',
  standalone: true,
  imports: [
    MuiBadgeComponent,
    MuiButtonComponent,
    MuiEmptyStateComponent,
    MuiIconComponent,
    MuiListRowComponent,
    MuiProgressComponent,
    MuiTextComponent,
  ],
  templateUrl: './mui-pipeline-monitor.component.html',
  styleUrl: './mui-pipeline-monitor.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiPipelineMonitorComponent {
  readonly stages = input.required<readonly MuiPipelineStage[]>();

  /** Stage id whose pause/resume affordance was pressed. */
  readonly stagePauseToggled = output<string>();
  /** Stage id whose retry affordance was pressed (only offered on `error`). */
  readonly stageRetried = output<string>();

  readonly statusLabel = STATUS_LABEL;
  readonly statusBadgeVariant = STATUS_BADGE_VARIANT;
  readonly statusIcon = STATUS_ICON;
  readonly statusIconColor = STATUS_ICON_COLOR;

  readonly overallProgress = computed<number>(() => {
    const stages = this.stages();
    if (stages.length === 0) return 0;
    const totals = stages.reduce(
      (acc, stage) => ({
        processed: acc.processed + stage.processed,
        total: acc.total + stage.total,
      }),
      { processed: 0, total: 0 },
    );
    return totals.total === 0 ? 0 : Math.round((totals.processed / totals.total) * 100);
  });

  stageProgress(stage: MuiPipelineStage): number {
    return stage.total === 0 ? 0 : Math.round((stage.processed / stage.total) * 100);
  }

  canToggle(stage: MuiPipelineStage): boolean {
    return stage.status === 'running' || stage.status === 'paused';
  }

  toggleLabel(stage: MuiPipelineStage): string {
    return stage.status === 'running' ? 'Pause' : 'Resume';
  }
}
