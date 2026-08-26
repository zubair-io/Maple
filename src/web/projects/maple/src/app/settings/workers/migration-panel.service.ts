// MigrationPanelService — owns the "Migrations" panel state + actions for the
// Workers page. Extracted from WorkersComponent so that file stays under the
// 600-LOC budget; the panel markup + styles remain in the component template
// (and its scoped scss), this just holds the signals, the poll timer, and the
// API round-trips.
//
// Provided at the component level (not root) — the state is ephemeral UI for
// one page, so it lives and dies with the component instance.

import { Injectable, inject, signal } from '@angular/core';
import { type MigrationInfo, WorkersApiService } from '@maple-common';
import { errorMessage } from './workers.vm';

@Injectable()
export class MigrationPanelService {
  private readonly api = inject(WorkersApiService);

  readonly list = signal<MigrationInfo[]>([]);
  readonly error = signal<string | null>(null);
  /** Per-migration in-flight flag so a toggle/reset disables its controls. */
  private readonly busyMap = signal<Record<string, boolean>>({});

  private fetchInFlight = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Fetch once and start a light poll so a running migration's progress stays
   * current (the WS status frame only carries the worker row, not per-migration
   * detail). Idempotent — a second call is ignored while already polling. */
  startPolling(intervalMs = 4000): void {
    if (this.timer) return;
    this.fetch();
    this.timer = setInterval(() => this.fetch(), intervalMs);
  }

  stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  isBusy(id: string): boolean {
    return this.busyMap()[id] ?? false;
  }

  /** Reload the registry + state. Skips when a prior request is still in flight
   * so the interval can't stack overlapping calls whose responses could race
   * (an older response overwriting newer progress). */
  fetch(): void {
    if (this.fetchInFlight) return;
    this.fetchInFlight = true;
    this.api.listMigrations().subscribe({
      next: ({ migrations }) => {
        this.fetchInFlight = false;
        this.list.set(migrations);
        this.error.set(null);
      },
      error: (err: unknown) => {
        this.fetchInFlight = false;
        this.error.set(errorMessage(err));
      },
    });
  }

  toggle(m: MigrationInfo, enabled: boolean): void {
    this.setBusy(m.id, true);
    this.api.setMigrationEnabled(m.id, enabled).subscribe({
      next: () => {
        this.setBusy(m.id, false);
        this.fetch();
      },
      error: (err: unknown) => {
        this.setBusy(m.id, false);
        this.error.set(errorMessage(err));
        this.fetch();
      },
    });
  }

  reset(m: MigrationInfo): void {
    this.setBusy(m.id, true);
    this.api.resetMigration(m.id).subscribe({
      next: () => {
        this.setBusy(m.id, false);
        this.fetch();
      },
      error: (err: unknown) => {
        this.setBusy(m.id, false);
        this.error.set(errorMessage(err));
      },
    });
  }

  private setBusy(id: string, busy: boolean): void {
    this.busyMap.update((m) => ({ ...m, [id]: busy }));
  }
}
