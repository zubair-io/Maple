// WorkersComponent — /settings/workers (owner-gated).
//
// Polls GET /api/workers/status while the route is active, self-scheduling to
// avoid overlapping requests on slow networks. One row per stage:
// Status | In flight | Pending | Dead | Throughput | ⚙ | ⏸/▶
//
// Pause/resume are optimistically applied in the UI signal, then reverted on
// HTTP error. The settings cog opens WorkerConfigDialogComponent as an
// in-template conditional (no router modal — keeps the URL clean).

import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import {
  WorkersApiService,
  type StageStatus,
  type WorkerConfig,
  type WorkersStatusResponse,
} from '@maple-common';
import { WorkerConfigDialogComponent } from './worker-config-dialog.component';

const POLL_MS = 2_000;

@Component({
  standalone: true,
  selector: 'maple-workers-settings',
  imports: [RouterLink, DecimalPipe, WorkerConfigDialogComponent],
  templateUrl: './workers.component.html',
  styleUrl: './workers.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkersComponent implements OnInit, OnDestroy {
  private readonly api = inject(WorkersApiService);

  readonly status = signal<WorkersStatusResponse | null>(null);
  readonly error = signal<string | null>(null);
  /** Name of the stage whose config dialog is open; null = closed. */
  readonly dialogStage = signal<string | null>(null);
  /** Configs as returned by the most recent status poll or PATCH response.
   * Keyed by stage name. */
  readonly configs = signal<Record<string, WorkerConfig>>({});

  readonly stages = computed(() => this.status()?.stages ?? []);

  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  ngOnInit(): void {
    // First poll fires immediately (synchronous in tests, immediate in prod).
    this.doPoll();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private doPoll(): void {
    if (this.destroyed) return;
    this.api.getStatus().subscribe({
      next: (data) => {
        this.status.set(data);
        this.error.set(null);
        // Hydrate configs from each stage's persisted config field.
        const entries: [string, WorkerConfig][] = [];
        for (const s of data.stages) {
          if (s.config) entries.push([s.name, s.config]);
        }
        if (entries.length > 0) {
          this.configs.set(Object.fromEntries(entries));
        }
      },
      error: (err) => {
        this.error.set(err?.error?.error ?? err?.message ?? 'Failed to load worker status.');
      },
      complete: () => this.scheduleNextPoll(POLL_MS),
    });
  }

  private scheduleNextPoll(delay: number): void {
    if (this.destroyed) return;
    this.pollTimer = setTimeout(() => this.doPoll(), delay);
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  togglePause(stage: StageStatus): void {
    // Optimistic: flip the local status before the HTTP round-trip.
    this.setLocalStatus(stage.name, stage.status === 'paused' ? 'running' : 'paused');
    const obs = stage.status === 'paused'
      ? this.api.resume(stage.name)
      : this.api.pause(stage.name);
    obs.subscribe({
      next: () => { /* next poll will sync */ },
      error: () => {
        // Revert the optimistic flip.
        this.setLocalStatus(stage.name, stage.status);
      },
    });
  }

  retryDead(stage: StageStatus): void {
    this.api.retryDead(stage.name).subscribe({
      next: () => { /* next poll will sync */ },
    });
  }

  openConfig(stage: StageStatus): void {
    this.dialogStage.set(stage.name);
  }

  closeDialog(): void {
    this.dialogStage.set(null);
  }

  onConfigSaved(name: string, config: WorkerConfig): void {
    this.configs.update((cur) => ({ ...cur, [name]: config }));
    this.dialogStage.set(null);
  }

  // ── Dialog helpers ────────────────────────────────────────────────────────

  /** Signal accessor for the stage currently open in the dialog. */
  readonly activeDialogStage = computed<StageStatus | null>(() => {
    const name = this.dialogStage();
    if (!name) return null;
    return this.stages().find((s) => s.name === name) ?? null;
  });

  readonly dialogConfig = computed<WorkerConfig>(() => {
    const name = this.dialogStage();
    const defaults: WorkerConfig = { concurrency: 1, pollIntervalMs: 1000, batchSize: 10, maxAttempts: 5 };
    if (!name) return defaults;
    return this.configs()[name] ?? defaults;
  });

  // ── Display helpers ───────────────────────────────────────────────────────

  statusLabel(s: StageStatus): string {
    switch (s.status) {
      case 'running':    return 'Running';
      case 'paused':     return 'Paused';
      case 'error':      return 'Error';
      case 'starting':   return 'Starting';
      case 'restarting': return 'Restarting';
      case 'stopped':    return 'Stopped';
    }
  }

  statusDotClass(s: StageStatus): string {
    switch (s.status) {
      case 'running':    return 'dot-ok';
      case 'paused':     return 'dot-muted';
      case 'error':      return 'dot-err';
      case 'starting':
      case 'restarting': return 'dot-muted';
      case 'stopped':    return 'dot-muted';
    }
  }

  throughputLabel(s: StageStatus): string {
    return s.throughput > 0 ? `${s.throughput} /min` : '—';
  }

  pauseResumeLabel(s: StageStatus): string {
    return s.status === 'paused' ? '▶' : '⏸';
  }

  pauseResumeTitle(s: StageStatus): string {
    return s.status === 'paused' ? 'Resume stage' : 'Pause stage';
  }

  private setLocalStatus(name: string, status: StageStatus['status']): void {
    this.status.update((cur) => {
      if (!cur) return cur;
      return {
        stages: cur.stages.map((s) => s.name === name ? { ...s, status } : s),
      };
    });
  }
}
