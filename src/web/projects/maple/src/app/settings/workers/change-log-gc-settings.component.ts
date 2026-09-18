// ChangeLogGcSettingsComponent — the "Change log GC" panel on the Workers
// settings page (#3741). Operates the change log retention and pruning worker:
// configures the retention window (days kept before pruning), triggers on-demand
// sweeps via "Run now", and reports the last sweep result.
//
// Backed by GET/PATCH /api/workers/change-log-gc/retention-window and
// POST /api/workers/change-log-gc/run.

import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  WorkersApiService,
  errorMessage,
  MuiButtonComponent,
  MuiInputComponent,
  MuiSettingsRowComponent,
} from '@maple-common';
import { SettingsIconComponent } from '../settings-icon.component';

@Component({
  selector: 'maple-change-log-gc-settings',
  standalone: true,
  imports: [MuiSettingsRowComponent, MuiButtonComponent, MuiInputComponent, SettingsIconComponent],
  templateUrl: './change-log-gc-settings.component.html',
  host: { class: 'set-vars set-workers-embedded-panel-host' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChangeLogGcSettingsComponent implements OnInit {
  private readonly api = inject(WorkersApiService);

  protected readonly retentionDays = signal<number>(30);
  protected readonly draftDays = signal<number>(30);
  protected readonly loading = signal<boolean>(true);
  protected readonly saving = signal<boolean>(false);
  protected readonly saved = signal<boolean>(false);
  protected readonly running = signal<boolean>(false);
  protected readonly error = signal<string | null>(null);
  protected readonly expanded = signal<boolean>(false);
  protected readonly lastRunResult = signal<{
    deleted: number;
    batches: number;
    durationMs: number;
  } | null>(null);

  protected readonly hasChanges = computed(() => this.draftDays() !== this.retentionDays());
  protected readonly statusColor = computed(() =>
    this.running() ? 'var(--s-accent)' : 'var(--s-ok)',
  );
  protected readonly statusLabel = computed(() => (this.running() ? 'running' : 'active'));

  protected readonly summaryLine = computed(() => {
    const days = this.retentionDays();
    const run = this.lastRunResult();
    if (run) {
      return `${days}d retention · Last sweep: ${run.deleted} pruned (${run.durationMs}ms)`;
    }
    return `${days} days retention`;
  });

  async ngOnInit(): Promise<void> {
    await this.reload();
  }

  protected toggleExpanded(): void {
    this.expanded.update((v) => !v);
  }

  protected onDraftChange(raw: string): void {
    const val = Number(raw);
    if (Number.isFinite(val)) {
      this.draftDays.set(val);
      this.saved.set(false);
    }
  }

  protected async reload(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const res = await firstValueFrom(this.api.getChangeLogRetentionWindow());
      this.retentionDays.set(res.days);
      this.draftDays.set(res.days);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.loading.set(false);
    }
  }

  protected async save(): Promise<void> {
    const days = Math.min(3650, Math.max(1, Math.round(this.draftDays())));
    this.saving.set(true);
    this.saved.set(false);
    this.error.set(null);
    try {
      const res = await firstValueFrom(this.api.setChangeLogRetentionWindow(days));
      this.retentionDays.set(res.days);
      this.draftDays.set(res.days);
      this.saved.set(true);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.saving.set(false);
    }
  }

  protected async runNow(): Promise<void> {
    this.running.set(true);
    this.error.set(null);
    try {
      const res = await firstValueFrom(this.api.runChangeLogGcNow());
      this.lastRunResult.set(res);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.running.set(false);
    }
  }
}
