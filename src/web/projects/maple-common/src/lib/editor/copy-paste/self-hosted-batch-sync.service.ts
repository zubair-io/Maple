import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { API_BASE_URL } from '../../api/api-base-url.token';
import { LibraryStateService } from '../../state/library-state.service';
import { LibraryStore } from '../../state/library-store.service';
import { defaultAdjustmentModel, type AdjustmentModel } from '../../models/adjustment-model';
import { XmpSerializerService } from '../../xmp/xmp-serializer.service';
import { XmpAdjustmentRestoreService } from '../../xmp/xmp-adjustment-restore.service';
import { BatchPreviewService } from './batch-preview.service';
import { buildXmpTransferPatch } from './xmp-transfer-patch';
import { CURRENT_WHITE_BALANCE_SCALE_VERSION } from '../../generated/adjustment-transfer.generated';
import { whiteBalanceCorrection, type AdjustmentTransferRequest } from './adjustment-transfer';
import type { PersistedBatchSync } from './persisted-batch-sync';
import type { BatchProgress, BatchSummary } from './batch-sync';

type SavedSummary = Omit<BatchSummary<string>, 'cancelled'> & { remaining: string[] };
interface SyncJob {
  id: string;
  status: 'queued' | 'running' | 'done' | 'cancelled' | 'failed';
  progress: { current: number; total: number };
  checkpoint?: SavedSummary;
  result: (SavedSummary & { cancelled: boolean }) | null;
  error: string | null;
}

/** Mongo owns the target list and ledger; the browser stores only a recovery pointer. */
@Injectable({ providedIn: 'root' })
export class SelfHostedBatchSyncService implements PersistedBatchSync {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);
  private readonly library = inject(LibraryStateService);
  private readonly store = inject(LibraryStore);
  private readonly serializer = inject(XmpSerializerService);
  private readonly restore = inject(XmpAdjustmentRestoreService);
  private readonly preview = inject(BatchPreviewService);
  private readonly storageKey = `maple.batch-sync:${this.base}`;
  readonly progress = signal<BatchProgress<string> | null>(null);
  readonly lastSummary = signal<BatchSummary<string> | null>(null);
  readonly error = signal<string | null>(null);
  readonly remaining = signal<readonly string[]>([]);
  readonly needsReconnect = signal(false);
  private jobId: string | null = null;
  private inFlight = false;
  private destroyed = false;
  private cancelRequested = false;
  private readonly refreshed = new Set<string>();
  private beforeModels = new Map<string, AdjustmentModel>();

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
    });
    try {
      this.jobId = localStorage.getItem(this.storageKey);
    } catch {
      /* Storage can be disabled. */
    }
    if (this.jobId) void this.reconnect();
  }

  // Invoked through the PERSISTED_BATCH_SYNC injection-token interface.
  // fallow-ignore-next-line unused-class-member
  async apply(
    ids: readonly string[],
    patch: Partial<AdjustmentModel>,
    request?: AdjustmentTransferRequest,
  ): Promise<BatchSummary<string> | null> {
    if (this.inFlight || this.needsReconnect() || ids.length === 0) return null;
    if (this.remaining().length > 0) {
      this.error.set('Resume or dismiss the interrupted batch before starting another.');
      return null;
    }
    return this.run(async () => {
      await this.library.flushPendingXmpWrites();
      const targets = ids.map((id) => {
        const path = this.store.absPathFor(id);
        if (!path) throw new Error(`Cannot resolve the photo ${id}`);
        return { id, path };
      });
      const xml = this.serializer.serialize({ ...defaultAdjustmentModel(), ...patch });
      const transfer = buildXmpTransferPatch(patch, xml);
      const relativeWhiteBalance =
        request?.relativeWhiteBalance && request.groups.includes('white_balance')
          ? whiteBalanceCorrection(request)
          : undefined;
      // As Shot legitimately omits its XMP scale stamp. The relative command
      // still states the scale validated by whiteBalanceCorrection above.
      const wirePatch = relativeWhiteBalance
        ? {
            ...transfer,
            attributes: {
              ...transfer.attributes,
              'papp:WbScaleVersion': String(CURRENT_WHITE_BALANCE_SCALE_VERSION),
            },
          }
        : transfer;
      const requestId = this.newRequestId();
      return firstValueFrom(
        this.http.post<{ id: string }>(`${this.base}/jobs`, {
          kind: 'batch_adjustment_sync',
          requestId,
          payload: { targets, patch: wirePatch, relativeWhiteBalance },
        }),
      );
    }, ids.length);
  }

  // Invoked through the PERSISTED_BATCH_SYNC injection-token interface.
  // fallow-ignore-next-line unused-class-member
  retryFailed(): Promise<BatchSummary<string> | null> {
    return this.remaining().length ? Promise.resolve(null) : this.action('retry-failed');
  }
  // Invoked through the PERSISTED_BATCH_SYNC injection-token interface.
  // fallow-ignore-next-line unused-class-member
  resume(): Promise<BatchSummary<string> | null> {
    return this.action('resume');
  }
  reconnect(): Promise<BatchSummary<string> | null> {
    if (!this.jobId || this.inFlight) return Promise.resolve(null);
    const id = this.jobId;
    return this.run(async () => ({ id }), 0, false);
  }

  private action(action: string): Promise<BatchSummary<string> | null> {
    if (!this.jobId || this.inFlight || this.needsReconnect()) return Promise.resolve(null);
    const id = this.jobId;
    return this.run(() => {
      const requestId = action === 'retry-failed' ? this.newRequestId() : id;
      this.jobId = requestId;
      return firstValueFrom(
        this.http.post<{ id: string }>(`${this.base}/jobs/${id}/${action}`, { requestId }),
      );
    }, 0);
  }

  // Invoked through the PERSISTED_BATCH_SYNC injection-token interface.
  // fallow-ignore-next-line unused-class-member
  cancel(): void {
    this.cancelRequested = true;
    if (this.jobId && this.inFlight) void this.requestCancel();
  }

  private async requestCancel(): Promise<void> {
    try {
      await firstValueFrom(this.http.post(`${this.base}/jobs/${this.jobId}/cancel`, {}));
    } catch (error) {
      this.error.set(`Could not cancel: ${this.message(error)}`);
    }
  }

  // Invoked through the PERSISTED_BATCH_SYNC injection-token interface.
  // fallow-ignore-next-line unused-class-member
  dismissSummary(): void {
    if (this.inFlight || this.needsReconnect()) return;
    this.lastSummary.set(null);
    this.error.set(null);
    this.remaining.set([]);
    this.jobId = null;
    try {
      localStorage.removeItem(this.storageKey);
    } catch {
      /* Storage can be disabled. */
    }
  }

  private async run(
    start: () => Promise<{ id: string }>,
    total: number,
    reset = true,
  ): Promise<BatchSummary<string> | null> {
    const previousId = this.jobId;
    const previousSummary = this.lastSummary();
    let accepted = false;
    this.inFlight = true;
    this.jobId = null;
    this.beforeModels = new Map(this.store.adjustmentModels());
    this.cancelRequested = false;
    this.error.set(null);
    this.needsReconnect.set(false);
    this.lastSummary.set(null);
    this.progress.set({
      total,
      processed: 0,
      applied: 0,
      failed: 0,
      current: '',
      outcome: 'applied',
    });
    try {
      const created = await start();
      accepted = true;
      this.jobId = created.id;
      if (reset) this.refreshed.clear();
      try {
        localStorage.setItem(this.storageKey, created.id);
      } catch {
        /* The server ledger still survives. */
      }
      if (this.cancelRequested) await this.requestCancel();
      return await this.poll(created.id, total);
    } catch (error) {
      this.handleFailure(error, accepted, previousId, previousSummary);
      return null;
    } finally {
      this.progress.set(null);
      this.inFlight = false;
    }
  }

  private handleFailure(
    error: unknown,
    accepted: boolean,
    previousId: string | null,
    previousSummary: BatchSummary<string> | null,
  ): void {
    this.error.set(this.message(error));
    const rejected =
      error instanceof HttpErrorResponse && error.status >= 400 && error.status < 500;
    const uncertain = (accepted || this.jobId !== null) && !rejected;
    if (!accepted && !uncertain) {
      this.jobId = previousId;
      this.lastSummary.set(previousSummary);
      try {
        if (previousId) localStorage.setItem(this.storageKey, previousId);
        else localStorage.removeItem(this.storageKey);
      } catch {
        /* Storage can be disabled. */
      }
    }
    this.needsReconnect.set(uncertain);
  }

  private async poll(id: string, total: number): Promise<BatchSummary<string> | null> {
    while (!this.destroyed) {
      const job = await firstValueFrom(this.http.get<SyncJob>(`${this.base}/jobs/${id}?summary=1`));
      const summary = job.result ?? job.checkpoint ?? { applied: [], failed: [], remaining: [] };
      this.remaining.set(summary.remaining);
      this.progress.set({
        total: job.progress.total || total,
        processed: job.progress.current,
        applied: summary.applied.length,
        failed: summary.failed.length,
        current: '',
        outcome: 'applied',
      });
      if (job.status !== 'queued' && job.status !== 'running') {
        await this.refreshApplied(summary.applied);
        const completed = {
          applied: summary.applied,
          failed: summary.failed,
          cancelled: job.status === 'cancelled',
        };
        this.lastSummary.set(completed);
        this.error.set(job.error);
        return completed;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return null;
  }

  private async refreshApplied(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      if (this.refreshed.has(id)) continue;
      this.restore.invalidateForAsset(id);
      const before = this.beforeModels.get(id);
      if (before && this.store.adjustmentModels().get(id) === before) {
        const persisted = await this.preview.readPersisted(id);
        if (this.store.adjustmentModels().get(id) === before)
          this.store.mergePersistedAdjustment(id, persisted, {});
      }
      this.refreshed.add(id);
    }
    const applied = new Set(ids);
    this.store.assets.update((assets) =>
      assets.map((asset) =>
        applied.has(asset.id) && !asset.edited ? { ...asset, edited: true } : asset,
      ),
    );
  }

  private message(error: unknown): string {
    if (error instanceof HttpErrorResponse && typeof error.error?.error === 'string')
      return error.error.error;
    return error instanceof Error ? error.message : String(error);
  }

  private newRequestId(): string {
    const id = [...crypto.getRandomValues(new Uint8Array(12))]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    this.jobId = id;
    try {
      localStorage.setItem(this.storageKey, id);
    } catch {
      /* The server ledger still survives. */
    }
    return id;
  }
}
