import { InjectionToken, type Signal } from '@angular/core';
import type { AdjustmentModel } from '../../models/adjustment-model';
import type { AdjustmentTransferRequest } from './adjustment-transfer';
import type { BatchProgress, BatchSummary } from './batch-sync';

/** Optional Self Hosted runner; the shared editor never imports its HTTP implementation. */
export interface PersistedBatchSync {
  readonly progress: Signal<BatchProgress<string> | null>;
  readonly lastSummary: Signal<BatchSummary<string> | null>;
  readonly error: Signal<string | null>;
  readonly remaining: Signal<readonly string[]>;
  readonly needsReconnect: Signal<boolean>;
  apply(
    ids: readonly string[],
    patch: Partial<AdjustmentModel>,
    transfer?: AdjustmentTransferRequest,
  ): Promise<BatchSummary<string> | null>;
  retryFailed(): Promise<BatchSummary<string> | null>;
  resume(): Promise<BatchSummary<string> | null>;
  reconnect(): Promise<BatchSummary<string> | null>;
  cancel(): void;
  dismissSummary(): void;
}

export const PERSISTED_BATCH_SYNC = new InjectionToken<PersistedBatchSync>('PERSISTED_BATCH_SYNC');
