// DerivativeAuditSettingsComponent — the "Maintenance" panel on the Workers
// settings page. Surfaces the derivative-audit worker: an enable toggle, the
// runtime knobs (resets/pass, cadence, concurrency, deep R2), a "Run now"
// button, and the last-pass readout. Backed by GET /api/derivative-audit/status,
// PUT /api/derivative-audit/config, POST /api/derivative-audit/run. Modeled on
// MirrorSettingsComponent (same signals + poll-while-running shape).

import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  BunApiBackendService,
  type DerivativeAuditConfigDto,
  type DerivativeAuditSummaryDto,
  errorMessage,
} from '@maple-common';
import { SettingsRowComponent } from '../settings-row.component';
import { SettingsIconComponent } from '../settings-icon.component';

interface AuditDraft {
  max_resets_per_pass: number;
  interval_hours: number;
  concurrency: number;
  deep_r2_enabled: boolean;
}

@Component({
  selector: 'maple-derivative-audit-settings',
  standalone: true,
  imports: [SettingsRowComponent, SettingsIconComponent],
  templateUrl: './derivative-audit-settings.component.html',
  styleUrl: './derivative-audit-settings.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DerivativeAuditSettingsComponent implements OnInit, OnDestroy {
  private readonly backend = inject(BunApiBackendService);

  protected readonly config = signal<DerivativeAuditConfigDto | null>(null);
  protected readonly progress = signal<DerivativeAuditSummaryDto | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly saved = signal(false);
  /** True from clicking "Run now" until the pass reports not-running. */
  protected readonly running = signal(false);

  /** Editable copy of the numeric/boolean knobs; committed via Save. */
  protected readonly draft = signal<AuditDraft | null>(null);

  /** Collapsed by default, matching the stage rows on this page. */
  protected readonly expanded = signal(false);
  protected toggleExpanded(): void {
    this.expanded.update((v) => !v);
  }

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  /** Per-stage re-arm counts of the last pass, as label/value pairs. */
  protected readonly stageCounts = computed<{ stage: string; count: number }[]>(() => {
    const by = this.progress()?.byStage ?? {};
    return Object.entries(by).map(([stage, count]) => ({ stage, count }));
  });

  protected statusLabel(): string {
    if (this.progress()?.running || this.running()) return 'Running';
    return this.config()?.enabled ? 'Enabled' : 'Off';
  }
  protected statusColor(): string {
    if (this.progress()?.running || this.running()) return 'var(--s-accent)';
    return this.config()?.enabled ? 'var(--s-ok)' : 'var(--s-text-dim)';
  }

  /** One-line last-pass readout for the panel header. */
  protected summaryLine(): string {
    const p = this.progress();
    if (!p || !p.finishedAt) return this.config()?.enabled ? 'Not run yet' : '';
    const errs = p.errors > 0 ? ` · ${p.errors} errors` : '';
    return `Last pass: ${p.scanned} scanned · ${p.reArmed} re-armed${errs}`;
  }

  async ngOnInit(): Promise<void> {
    try {
      await this.refreshStatus();
      // If a pass is already running server-side, reflect it and poll to done.
      if (this.progress()?.running) {
        this.running.set(true);
        this.startPolling();
      }
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.loading.set(false);
    }
  }

  ngOnDestroy(): void {
    this.stopPolling();
  }

  protected draftValue<K extends keyof AuditDraft>(key: K): AuditDraft[K] | undefined {
    return this.draft()?.[key];
  }

  protected setDraft<K extends keyof AuditDraft>(key: K, value: AuditDraft[K]): void {
    this.draft.update((d) => (d ? { ...d, [key]: value } : d));
    this.saved.set(false);
  }

  protected setDraftNumber(
    key: 'max_resets_per_pass' | 'interval_hours' | 'concurrency',
    raw: string,
  ): void {
    const n = Number(raw);
    if (Number.isFinite(n)) this.setDraft(key, n);
  }

  /** Toggle `enabled` immediately (a switch, not part of the Save batch). */
  protected async toggleEnabled(next: boolean): Promise<void> {
    const prev = this.config();
    if (!prev) return;
    this.config.set({ ...prev, enabled: next });
    try {
      const res = await firstValueFrom(this.backend.setDerivativeAuditConfig({ enabled: next }));
      this.config.set(res.config);
    } catch (e) {
      this.config.set(prev); // revert on failure
      this.error.set(errorMessage(e));
    }
  }

  protected async save(): Promise<void> {
    const d = this.draft();
    if (!d) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      const res = await firstValueFrom(
        this.backend.setDerivativeAuditConfig({
          max_resets_per_pass: Math.round(d.max_resets_per_pass),
          interval_ms: Math.round(d.interval_hours * 3_600_000),
          concurrency: Math.round(d.concurrency),
          deep_r2_enabled: d.deep_r2_enabled,
        }),
      );
      this.applyConfig(res.config);
      this.saved.set(true);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.saving.set(false);
    }
  }

  protected async runNow(): Promise<void> {
    this.error.set(null);
    this.running.set(true);
    try {
      const res = await firstValueFrom(this.backend.runDerivativeAudit());
      if (!res.started && res.reason) this.error.set(`Not started: ${res.reason}`);
      await this.refreshStatus();
      if (this.progress()?.running) this.startPolling();
      else this.running.set(false);
    } catch (e) {
      this.error.set(errorMessage(e));
      this.running.set(false);
    }
  }

  private applyConfig(cfg: DerivativeAuditConfigDto): void {
    this.config.set(cfg);
    this.draft.set({
      max_resets_per_pass: cfg.max_resets_per_pass,
      interval_hours: cfg.interval_ms / 3_600_000,
      concurrency: cfg.concurrency,
      deep_r2_enabled: cfg.deep_r2_enabled,
    });
  }

  private async refreshStatus(): Promise<void> {
    const res = await firstValueFrom(this.backend.getDerivativeAuditStatus());
    // Seed the draft only once so in-progress edits aren't clobbered by polling.
    if (!this.draft()) this.applyConfig(res.config);
    else this.config.set(res.config);
    this.progress.set(res.progress);
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      if (this.polling) return;
      this.polling = true;
      void (async () => {
        try {
          await this.refreshStatus();
          if (!this.progress()?.running) {
            this.stopPolling();
            this.running.set(false);
          }
        } catch {
          // Status is informational — a transient fetch failure shouldn't nuke the panel.
        } finally {
          this.polling = false;
        }
      })();
    }, 1200);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
