// WorkersComponent — /settings/workers (owner-gated).
//
// Polls GET /api/workers/status every 2 s while the route is active.
// One row per stage: Status | Workers | In flight | Pending | Dead | Throughput | ⚙ | ⏸/▶
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
  type StageState,
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
  readonly configs = signal<Map<string, WorkerConfig>>(new Map());

  readonly stages = computed(() => this.status()?.stages ?? []);

  private timer: ReturnType<typeof setInterval> | null = null;

  ngOnInit(): void {
    this.poll();
    this.timer = setInterval(() => this.poll(), POLL_MS);
  }

  ngOnDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private poll(): void {
    this.api.getStatus().subscribe({
      next: (res) => {
        this.status.set(res);
        this.error.set(null);
      },
      error: (err) => {
        this.error.set(err?.error?.error ?? err?.message ?? 'Failed to load worker status.');
      },
    });
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  togglePause(stage: StageState): void {
    // Optimistic: flip the local status before the HTTP round-trip.
    this.setLocalStatus(stage.name, stage.status === 'paused' ? 'running' : 'paused');
    const obs = stage.status === 'paused'
      ? this.api.resume(stage.name)
      : this.api.pause(stage.name);
    obs.subscribe({
      next: () => this.poll(),
      error: () => {
        // Revert the optimistic flip.
        this.setLocalStatus(stage.name, stage.status);
      },
    });
  }

  retryDead(stage: StageState): void {
    this.api.retryDead(stage.name).subscribe({
      next: () => this.poll(),
    });
  }

  openConfig(stage: StageState): void {
    this.dialogStage.set(stage.name);
  }

  closeDialog(): void {
    this.dialogStage.set(null);
  }

  onConfigSaved(name: string, config: WorkerConfig): void {
    this.configs.update((m) => {
      const next = new Map(m);
      next.set(name, config);
      return next;
    });
    this.dialogStage.set(null);
    this.poll();
  }

  // ── Dialog helpers ────────────────────────────────────────────────────────

  /** Signal accessor for the stage currently open in the dialog. */
  readonly activeDialogStage = computed<StageState | null>(() => {
    const name = this.dialogStage();
    if (!name) return null;
    return this.stages().find((s) => s.name === name) ?? null;
  });

  activeConfigSignal(name: string) {
    return computed(() => {
      return this.configs().get(name) ?? { concurrency: 1, pollIntervalMs: 1000, batchSize: 10, maxAttempts: 5 };
    });
  }

  // ── Display helpers ───────────────────────────────────────────────────────

  statusLabel(s: StageState): string {
    switch (s.status) {
      case 'running': return 'Running';
      case 'paused':  return 'Paused';
      case 'error':   return 'Error';
    }
  }

  statusDotClass(s: StageState): string {
    switch (s.status) {
      case 'running': return 'dot-ok';
      case 'paused':  return 'dot-muted';
      case 'error':   return 'dot-err';
    }
  }

  throughputLabel(s: StageState): string {
    return s.throughput_per_minute > 0 ? `${s.throughput_per_minute} /min` : '—';
  }

  pauseResumeLabel(s: StageState): string {
    return s.status === 'paused' ? '▶' : '⏸';
  }

  pauseResumeTitle(s: StageState): string {
    return s.status === 'paused' ? 'Resume stage' : 'Pause stage';
  }

  private setLocalStatus(name: string, status: StageState['status']): void {
    this.status.update((cur) => {
      if (!cur) return cur;
      return {
        stages: cur.stages.map((s) => s.name === name ? { ...s, status } : s),
      };
    });
  }
}
