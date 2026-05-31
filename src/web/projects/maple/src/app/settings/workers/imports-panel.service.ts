// ImportsPanelService — owns the "Import" group on the Workers page (ticket
// #755 follow-up). The group renders as the last pipeline group in the
// worker table; this service holds the job list, the light poll, and the
// expand-to-detail state (a clicked row fetches the full import so its
// per-file src → dest → status list can be shown inline).
//
// Provided at the component level (lives/dies with the Workers page), mirroring
// MigrationPanelService.

import { Injectable, inject, signal } from '@angular/core';
import {
  BunApiBackendService,
  ImportsApiService,
  type ImportSummary,
  type ImportView,
} from '@maple-common';

const POLL_MS = 4000;
/** Cap the inline file list so a huge import can't render tens of thousands
 * of DOM rows. */
const MAX_FILES_SHOWN = 300;

@Injectable()
export class ImportsPanelService {
  private readonly api = inject(ImportsApiService);
  private readonly backend = inject(BunApiBackendService);

  readonly jobs = signal<ImportSummary[]>([]);
  readonly error = signal<string | null>(null);

  /** Id of the expanded row, or null. */
  readonly expandedId = signal<string | null>(null);
  /** Full doc (with files) for the expanded row. */
  readonly detail = signal<ImportView | null>(null);
  readonly detailLoading = signal(false);

  readonly maxFilesShown = MAX_FILES_SHOWN;

  private readonly libLabels = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  startPolling(intervalMs = POLL_MS): void {
    if (this.timer) return;
    // Library labels for the "Src → Library" detail header — fetched once.
    this.backend.listFolders().subscribe({
      next: (folders) => {
        for (const f of folders) this.libLabels.set(f.id, f.label);
      },
      error: () => {
        /* labels are cosmetic; fall back to the path basename */
      },
    });
    this.fetch();
    this.timer = setInterval(() => this.fetch(), intervalMs);
  }

  stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Reload the job list. Skips while a prior request is in flight so the
   * interval can't stack overlapping responses that race. */
  private fetch(): void {
    if (this.inFlight) return;
    this.inFlight = true;
    this.api.list(undefined, 25).subscribe({
      next: ({ imports }) => {
        this.inFlight = false;
        this.jobs.set(imports);
        this.error.set(null);
      },
      error: (e: unknown) => {
        this.inFlight = false;
        this.error.set(e instanceof Error ? e.message : String(e));
      },
    });
  }

  isExpanded(id: string): boolean {
    return this.expandedId() === id;
  }

  /** Expand a row and load its full detail (or collapse if already open). */
  toggle(id: string): void {
    if (this.expandedId() === id) {
      this.expandedId.set(null);
      this.detail.set(null);
      return;
    }
    this.expandedId.set(id);
    this.detail.set(null);
    this.detailLoading.set(true);
    this.api.get(id).subscribe({
      next: (doc) => {
        // Ignore a late response for a row the user already collapsed or
        // swapped — it must not clear a newer expansion's loading state.
        if (this.expandedId() !== id) return;
        this.detailLoading.set(false);
        this.detail.set(doc);
      },
      error: (e: unknown) => {
        if (this.expandedId() !== id) return;
        this.detailLoading.set(false);
        this.error.set(e instanceof Error ? e.message : String(e));
      },
    });
  }

  /** Display name for the target library of the expanded import. */
  libraryName(d: ImportView): string {
    return this.libLabels.get(d.library_id) ?? this.basename(d.library_root);
  }

  basename(p: string): string {
    const t = p.replace(/\/+$/, '');
    const i = t.lastIndexOf('/');
    return i >= 0 ? t.slice(i + 1) || '/' : t;
  }

  percent(j: ImportSummary): number {
    if (j.progress.total === 0) return 0;
    return Math.round((j.progress.current / j.progress.total) * 100);
  }

  active(j: ImportSummary): boolean {
    return j.status === 'pending' || j.status === 'running';
  }

  statusColor(status: ImportSummary['status']): string {
    switch (status) {
      case 'done':
        return '#4ade80';
      case 'running':
      case 'pending':
        return '#60a5fa';
      case 'failed':
        return '#f87171';
      default:
        return '#a8a29e'; // cancelled
    }
  }
}
