// ChangeLogGcSettingsComponent — the change-log-gc row in the "Maintenance"
// group on the Workers settings page (#3741). Surfaces the retention window for
// the asset_changes journal, an enable toggle, the current row count, and the
// last sweep's readout. Backed by GET /api/change-log-gc/status and
// PUT /api/change-log-gc/config. Modeled on DerivativeAuditSettingsComponent,
// minus the polling — this job runs on a daily interval, not on demand.

import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  BunApiBackendService,
  type ChangeLogGcConfigDto,
  type ChangeLogGcRunDto,
  errorMessage,
  MuiButtonComponent,
  MuiCheckboxComponent,
  MuiInputComponent,
  MuiSettingsRowComponent,
} from '@maple-common';
import { SettingsIconComponent } from '../settings-icon.component';

@Component({
  selector: 'maple-change-log-gc-settings',
  standalone: true,
  imports: [
    MuiSettingsRowComponent,
    MuiButtonComponent,
    MuiCheckboxComponent,
    MuiInputComponent,
    SettingsIconComponent,
  ],
  templateUrl: './change-log-gc-settings.component.html',
  host: { class: 'set-vars set-workers-embedded-panel-host' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChangeLogGcSettingsComponent implements OnInit {
  private readonly backend = inject(BunApiBackendService);

  protected readonly config = signal<ChangeLogGcConfigDto | null>(null);
  protected readonly rows = signal(0);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly saved = signal(false);

  /** Editable copy of the window; committed via Save. */
  protected readonly draftDays = signal<number | null>(null);

  /** Collapsed by default, matching every other row on this page. */
  protected readonly expanded = signal(false);
  protected toggleExpanded(): void {
    this.expanded.update((v) => !v);
  }

  protected statusLabel(): string {
    return this.config()?.enabled ? 'Enabled' : 'Off';
  }
  protected statusColor(): string {
    return this.config()?.enabled ? 'var(--s-ok)' : 'var(--s-text-dim)';
  }

  /** mui-input carries every variant's value as a string. */
  protected numToStr(n: number | null): string {
    return n === null ? '' : String(n);
  }

  /** Thousands separators — this readout is routinely eight digits. */
  protected formatRows(n: number): string {
    return n.toLocaleString();
  }

  /** One-line last-sweep readout for the panel header. */
  protected summaryLine(): string {
    const run = this.lastRun();
    if (!run) return this.config()?.enabled ? 'Not run yet' : '';
    if (run.error) return `Last sweep failed: ${run.error}`;
    return `${this.formatRows(this.rows())} rows · last sweep removed ${this.formatRows(run.deleted)}`;
  }

  protected lastRun(): ChangeLogGcRunDto | null {
    return this.config()?.last_run ?? null;
  }

  /** Localised wall-clock time of the last sweep, or '' when it has never run. */
  protected lastRunAt(): string {
    const at = this.lastRun()?.finished_at;
    if (!at) return '';
    const d = new Date(at);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
  }

  async ngOnInit(): Promise<void> {
    try {
      await this.refresh();
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.loading.set(false);
    }
  }

  protected setDraftDays(raw: string): void {
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    this.draftDays.set(n);
    this.saved.set(false);
  }

  /** Toggle `enabled` immediately — a switch, not part of the Save batch. */
  protected async toggleEnabled(next: boolean): Promise<void> {
    const prev = this.config();
    if (!prev) return;
    this.config.set({ ...prev, enabled: next });
    try {
      const res = await firstValueFrom(this.backend.setChangeLogGcConfig({ enabled: next }));
      this.config.set(res.config);
    } catch (e) {
      this.config.set(prev); // revert on failure
      this.error.set(errorMessage(e));
    }
  }

  protected async save(): Promise<void> {
    const days = this.draftDays();
    if (days === null) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      const res = await firstValueFrom(
        this.backend.setChangeLogGcConfig({ retention_days: Math.round(days) }),
      );
      this.config.set(res.config);
      this.draftDays.set(res.config.retention_days);
      this.saved.set(true);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.saving.set(false);
    }
  }

  private async refresh(): Promise<void> {
    const res = await firstValueFrom(this.backend.getChangeLogGcStatus());
    this.config.set(res.config);
    this.rows.set(res.rows);
    this.draftDays.set(res.config.retention_days);
  }
}
