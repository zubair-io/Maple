import { Injectable, computed, inject, signal, OnDestroy } from '@angular/core';
import { LibraryStateService } from '../../state/library-state.service';
import type { AdjustmentModel } from '../../models/adjustment-model';
import type { BatchTransferProgress } from '../../generated/batch-transfer.generated';
import type { AdjustmentTransferRequest } from './adjustment-transfer';
import type { BatchRecordView } from './batch-ledger';
import type { BatchProgress, BatchSummary } from './batch-sync';
import type { PersistedBatchSync } from './persisted-batch-sync';
import { BatchWorkerClient } from './batch-worker-client';
import { BatchSyncAssetIO } from './batch-sync-asset-io.service';

/** The worker owns the durable ledger; the main thread owns authorized file handles. */
@Injectable({ providedIn: 'root' })
export class HostedBatchSyncService implements PersistedBatchSync, OnDestroy {
  private readonly library = inject(LibraryStateService);
  private readonly assetIO = inject(BatchSyncAssetIO);
  private worker: BatchWorkerClient = this.createWorker();
  private createWorker(): BatchWorkerClient {
    return new BatchWorkerClient({
      prepare: (operation, id) => this.assetIO.prepare(operation, id),
      write: (operation, id, patch) => this.assetIO.write(operation, id, patch),
      changed: (view, progress) => this.show(view, progress),
    });
  }
  readonly record = signal<BatchRecordView | null>(null);
  readonly progress = signal<BatchProgress<string> | null>(null);
  readonly lastSummary = signal<BatchSummary<string> | null>(null);
  readonly error = signal<string | null>(null);
  readonly needsReconnect = signal(false);
  readonly remaining = computed(() => {
    const view = this.record();
    const done = new Set([
      ...(view?.summary.applied ?? []),
      ...(view?.summary.failed.map((f) => f.id) ?? []),
    ]);
    return view?.operation.assetIds.filter((id) => !done.has(id)) ?? [];
  });
  private busy = false;
  private cancelled = false;
  private readonly initialized = this.reconnect();

  private show(view: BatchRecordView, progress?: BatchTransferProgress): void {
    if (progress) {
      this.progress.set({
        ...progress,
        outcome: progress.outcome === 'failed' ? 'failed' : 'applied',
      });
      return;
    }
    this.record.set(view);
    if (view.operation.status === 'running' && this.busy) {
      this.lastSummary.set(null);
    } else {
      this.progress.set(null);
      this.lastSummary.set(view.summary);
    }
  }

  async reconnect(): Promise<BatchSummary<string> | null> {
    try {
      if (this.worker.isUnavailable()) this.worker = this.createWorker();
      const view = await this.worker.request({ type: 'load' });
      if (view) this.show(view);
      this.needsReconnect.set(false);
      return view?.summary ?? null;
    } catch (error) {
      this.report(error);
      return null;
    }
  }

  async apply(
    ids: readonly string[],
    patch: Partial<AdjustmentModel>,
    transfer?: AdjustmentTransferRequest,
  ): Promise<BatchSummary<string> | null> {
    if (this.busy || !ids.length) return null;
    return this.run(async () => {
      await this.initialized;
      if (this.record() && this.record()!.operation.status !== 'complete')
        throw new Error('Resume or dismiss the previous batch before starting another.');
      const folder = this.library.currentFolder();
      if (!folder?.write) throw new Error('Open a writable folder to apply settings.');
      const unique = [...new Set(ids)];
      const assets = unique.map((id) => {
        const asset = this.library.assets().find((a) => a.id === id);
        if (!asset || asset.isVideo) throw new Error('Choose photos from the current library.');
        return asset;
      });
      const sidecarNames = assets.map((asset) =>
        asset.filename.replace(/\.[^.]+$/, '.xmp').toLowerCase(),
      );
      if (new Set(sidecarNames).size !== sidecarNames.length)
        throw new Error(
          'Two selected photos share the same XMP sidecar. Select only one of each matching filename.',
        );
      const request = await this.frozenTransfer(transfer);
      if (this.cancelled) return null;
      return this.worker.request({
        type: 'start',
        operation: {
          id: crypto.randomUUID(),
          createdAt: Date.now(),
          status: 'ready',
          libraryId: await this.assetIO.identity(folder),
          directory: folder.native,
          assetIds: unique,
          assetNames: Object.fromEntries(assets.map((a) => [a.id, a.filename])),
          request,
          patch: structuredClone(patch),
        },
      });
    }, ids.length);
  }

  private async frozenTransfer(
    transfer?: AdjustmentTransferRequest,
  ): Promise<AdjustmentTransferRequest | undefined> {
    if (!transfer) return undefined;
    const request = structuredClone(transfer);
    if (
      !request.relativeWhiteBalance ||
      !request.groups.includes('white_balance') ||
      request.sourceBaseline
    )
      return request;
    if (!request.sourceAssetId)
      throw new Error('Copy the source photo again to read its camera white balance.');
    return { ...request, sourceBaseline: await this.assetIO.baseline(request.sourceAssetId) };
  }

  resume(): Promise<BatchSummary<string> | null> {
    return this.continue(false);
  }
  retryFailed(): Promise<BatchSummary<string> | null> {
    return this.continue(true);
  }
  private async continue(retryOnlyFailed: boolean): Promise<BatchSummary<string> | null> {
    const view = this.record();
    if (!view || this.busy) return null;
    return this.run(async () => {
      const ids = retryOnlyFailed ? view.summary.failed.map((f) => f.id) : this.remaining();
      if (!ids.length) return view;
      await this.assetIO.validate(view.operation, ids[0]);
      if (this.cancelled) return null;
      return this.worker.request({
        type: 'resume',
        operationId: view.operation.id,
        retryOnlyFailed,
      });
    }, view.operation.assetIds.length);
  }

  private async run(
    action: () => Promise<BatchRecordView | null | undefined>,
    total: number,
  ): Promise<BatchSummary<string> | null> {
    this.busy = true;
    this.cancelled = false;
    this.error.set(null);
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
      const view = await action();
      if (view) this.show(view);
      return view?.summary ?? null;
    } catch (error) {
      this.report(error);
      return null;
    } finally {
      this.busy = false;
      this.progress.set(null);
    }
  }

  cancel(): void {
    this.cancelled = true;
    void this.worker.request({ type: 'cancel' }).catch((error) => this.report(error));
  }
  dismissSummary(): void {
    void this.dismiss();
  }
  private async dismiss(): Promise<void> {
    if (this.busy) return;
    try {
      const id = this.record()?.operation.id;
      if (id) await this.worker.request({ type: 'delete', operationId: id });
      this.record.set(null);
      this.lastSummary.set(null);
      this.error.set(null);
    } catch (error) {
      this.report(error);
    }
  }
  private report(error: unknown): void {
    this.error.set(error instanceof Error ? error.message : String(error));
    this.needsReconnect.set(this.worker.isUnavailable());
  }
  ngOnDestroy(): void {
    this.worker.destroy();
  }
}
