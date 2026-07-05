// BackfillPanelService — owns the "Sync existing thumbnails" panel state +
// actions on the Cloudflare settings page (#1757 sub-issue 4). Mirrors
// MigrationPanelService's shape (component-provided, setInterval poll) —
// see src/app/settings/workers/migration-panel.service.ts.
//
// Provided at the component level, not root: this is ephemeral UI state for
// one page, not a cross-page concern.

import { Injectable, computed, inject, signal } from '@angular/core';
import { type CloudflareBackfillJob, CloudflareService, errorMessage } from '@maple-common';

const POLL_MS = 2000;

@Injectable()
export class BackfillPanelService {
  private readonly cloudflare = inject(CloudflareService);

  readonly job = signal<CloudflareBackfillJob | null>(null);
  readonly starting = signal(false);
  readonly error = signal<string | null>(null);

  private timer: ReturnType<typeof setInterval> | null = null;

  readonly isRunning = computed(() => {
    const status = this.job()?.status;
    return this.starting() || status === 'queued' || status === 'running';
  });

  readonly statusLabel = computed(() => {
    if (this.starting()) return 'Starting…';
    const j = this.job();
    if (!j) return '';
    const { current, total } = j.progress;
    switch (j.status) {
      case 'queued':
        return 'Queued…';
      case 'running':
        return total > 0 ? `Syncing ${current} / ${total}…` : 'Syncing…';
      case 'done': {
        const r = j.result;
        return `Done — ${r?.successCount ?? 0} uploaded, ${r?.skippedCount ?? 0} skipped, ${r?.failedCount ?? 0} failed.`;
      }
      case 'cancelled':
        return 'Cancelled.';
      case 'failed':
        return j.error ?? 'Backfill failed.';
    }
  });

  start(): void {
    if (this.isRunning()) return;
    this.starting.set(true);
    this.error.set(null);
    this.cloudflare.triggerBackfill().subscribe({
      next: ({ id }) => {
        this.starting.set(false);
        this.poll(id);
      },
      error: (err: unknown) => {
        this.starting.set(false);
        this.error.set(errorMessage(err));
      },
    });
  }

  cancel(): void {
    const j = this.job();
    if (!j) return;
    this.cloudflare.cancelBackfillJob(j.id).subscribe();
  }

  /** Stop polling — called on component destroy so a navigated-away page
   * doesn't keep firing requests. */
  stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private poll(id: string): void {
    this.stopPolling();
    // Arm the interval BEFORE the first fetch: `fetchOnce` calls
    // `stopPolling()` as soon as the job reaches a terminal status, and
    // that call is a no-op unless `this.timer` is already set — otherwise
    // a job that's already terminal on its very first poll would still
    // leave the interval armed indefinitely.
    this.timer = setInterval(() => this.fetchOnce(id), POLL_MS);
    this.fetchOnce(id);
  }

  private fetchOnce(id: string): void {
    this.cloudflare.getBackfillJob(id).subscribe({
      next: (job) => {
        this.job.set(job);
        if (job.status !== 'queued' && job.status !== 'running') {
          this.stopPolling();
        }
      },
      error: (err: unknown) => {
        this.stopPolling();
        this.error.set(errorMessage(err));
      },
    });
  }
}
