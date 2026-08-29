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
  errorMessage,
} from '@maple-common';
import { importPercent } from '../imports/import-progress.vm';

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
        this.error.set(errorMessage(e));
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
        this.error.set(errorMessage(e));
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

  /** Completion rate for the row's progress text. Shares its definition with
   * the `/settings/imports` progress bar so the two surfaces can't disagree
   * about how far along the same job is. */
  percent(j: ImportSummary): number {
    return importPercent(j);
  }

  active(j: ImportSummary): boolean {
    return j.status === 'pending' || j.status === 'running';
  }

  /** True for an import that can actually be re-queued, mirroring the server's
   * retry guard (#800). A `failed` import is always retryable: the server
   * either recovers its failed file rows OR — for a scan-level failure that
   * never produced files (`files: []`, `counts.failed: 0`) — re-scans the
   * source from scratch. A `done` import only qualifies when it has failed
   * files left to re-attempt. */
  retryable(j: ImportSummary): boolean {
    return j.status === 'failed' || (j.status === 'done' && j.counts.failed > 0);
  }

  /** Re-queue a failed / partially-failed import, then refresh the list so its
   * status flips back to pending/running. Id of the import currently retrying
   * (for a disabled/in-flight button state), or null. */
  readonly retryingId = signal<string | null>(null);

  retry(id: string): void {
    if (this.retryingId() !== null) return;
    this.retryingId.set(id);
    this.api.retry(id).subscribe({
      next: () => {
        this.retryingId.set(null);
        this.error.set(null);
        this.fetch();
      },
      error: (e: unknown) => {
        this.retryingId.set(null);
        this.error.set(errorMessage(e));
      },
    });
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
