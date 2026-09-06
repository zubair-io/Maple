import { Injectable, Injector, computed, inject, signal } from '@angular/core';
import { PERSISTED_BATCH_SYNC, type PersistedBatchSync } from './persisted-batch-sync';
import type { AdjustmentModel } from '../../models/adjustment-model';
import type { AdjustmentTransferRequest } from './adjustment-transfer';
import { batchSummaryText, type BatchSummary } from './batch-sync';

/** Platform facade. Both deployments persist outcomes; browser I/O loads lazily. */
@Injectable({ providedIn: 'root' })
export class BatchSyncService {
  private readonly injector = inject(Injector);
  private readonly persisted = signal(inject(PERSISTED_BATCH_SYNC, { optional: true }));
  private readonly initializing = this.initialize();
  readonly error = computed(() => this.persisted()?.error() ?? null);
  readonly remaining = computed(() => this.persisted()?.remaining() ?? []);
  readonly needsReconnect = computed(() => this.persisted()?.needsReconnect() ?? false);
  readonly progress = computed(() => this.persisted()?.progress() ?? null);
  readonly lastSummary = computed(() => this.persisted()?.lastSummary() ?? null);
  readonly running = computed(() => this.progress() !== null);
  readonly percent = computed(() => {
    const p = this.progress();
    return p && p.total > 0 ? Math.round((p.processed / p.total) * 100) : null;
  });
  readonly summaryText = computed(() => {
    const summary = this.lastSummary();
    return summary ? batchSummaryText(summary) : null;
  });
  readonly failedIds = computed(() => this.lastSummary()?.failed.map((f) => f.id) ?? []);

  private async initialize(): Promise<PersistedBatchSync> {
    if (this.persisted()) return this.persisted()!;
    const { HostedBatchSyncService } = await import('./hosted-batch-sync.service');
    const service = this.injector.get(HostedBatchSyncService);
    this.persisted.set(service);
    return service;
  }

  async apply(
    ids: readonly string[],
    patch: Partial<AdjustmentModel>,
    transfer?: AdjustmentTransferRequest,
  ): Promise<BatchSummary<string> | null> {
    const runner = this.persisted() ?? (await this.initializing);
    return runner.apply(ids, patch, transfer);
  }
  retryFailed(_patch?: Partial<AdjustmentModel>): Promise<BatchSummary<string> | null> {
    return this.persisted()?.retryFailed() ?? Promise.resolve(null);
  }
  resume(): void {
    void this.persisted()?.resume();
  }
  reconnect(): void {
    void this.persisted()?.reconnect();
  }
  cancel(): void {
    this.persisted()?.cancel();
  }
  dismissSummary(): void {
    this.persisted()?.dismissSummary();
  }
}
