// One frozen patch is durably prepared before each sidecar write. Replaying a
// prepared item after a crash repeats that patch, never adds a relative delta.
import type { BatchTransferProgress } from '../../generated/batch-transfer.generated';
import type {
  BatchAssetRecord,
  BatchLedger,
  BatchOperation,
  BatchRecordView,
  PreparedBatchPatch,
} from './batch-ledger';

export interface PersistentBatchCallbacks {
  prepare(operation: BatchOperation, id: string): Promise<PreparedBatchPatch>;
  write(operation: BatchOperation, id: string, patch: PreparedBatchPatch): Promise<void>;
  changed(view: BatchRecordView, progress?: BatchTransferProgress): void;
}
export class PersistentBatchRunner {
  private cancelled = false;
  private cancelVersion = 0;
  private active?: BatchOperation;
  constructor(
    private readonly ledger: BatchLedger,
    private readonly callbacks: PersistentBatchCallbacks,
  ) {}

  async cancel(): Promise<void> {
    this.cancelled = true;
    ++this.cancelVersion;
    if (this.active) await this.ledger.saveOperation({ ...this.active, status: 'cancelled' });
  }
  async view(operation: BatchOperation): Promise<BatchRecordView> {
    return this.makeView(operation, await this.ledger.assets(operation.id));
  }
  private makeView(operation: BatchOperation, records: BatchAssetRecord[]): BatchRecordView {
    return {
      operation,
      summary: {
        applied: records.filter((r) => r.status === 'applied').map((r) => r.id),
        failed: records
          .filter((r) => r.status === 'failed')
          .map((r) => ({ id: r.id, reason: r.error ?? 'Sidecar write failed' })),
        cancelled: operation.status === 'cancelled',
      },
      remaining: records.filter((r) => r.status === 'pending' || r.status === 'prepared').length,
    };
  }
  async run(operationId: string, retryOnlyFailed = false): Promise<BatchRecordView> {
    if (this.active) throw new Error('Another batch is already running.');
    const cancelVersion = this.cancelVersion;
    const { operation, records } = await this.loadAttempt(operationId, retryOnlyFailed);
    const attempt = operation.attempt!;
    const byId = new Map(records.map((r) => [r.id, r]));
    this.active = operation;
    this.cancelled = cancelVersion !== this.cancelVersion;
    try {
      await this.ledger.saveOperation(operation);
      this.callbacks.changed(this.makeView(operation, records));
      const selected = new Set(attempt.assetIds);
      for (const id of operation.assetIds) {
        if (this.cancelled) break;
        const previous = byId.get(id);
        if (!previous) throw new Error(`Batch ledger is missing an asset record: ${id}`);
        if (!selected.has(id) || !this.needsAttempt(previous, attempt.id)) continue;
        const result = await this.attempt(operation, previous);
        byId.set(id, result);
        if (this.cancelled && result.status === 'prepared') break;
        // If this persistence fails, stop. The previous prepared record is
        // recoverable, but proceeding would lose trustworthy progress.
        await this.ledger.saveAsset(result);
        byId.set(id, result);
        const view = this.makeView(operation, [...byId.values()]);
        this.callbacks.changed(view, {
          total: operation.assetIds.length,
          processed: view.summary.applied.length + view.summary.failed.length,
          applied: view.summary.applied.length,
          failed: view.summary.failed.length,
          current: id,
          outcome: result.status,
        });
      }
      return await this.finish(operation, [...byId.values()]);
    } finally {
      this.active = undefined;
    }
  }
  private needsAttempt(record: BatchAssetRecord, attemptId: string): boolean {
    return (
      record.status !== 'applied' && (record.status !== 'failed' || record.attemptId !== attemptId)
    );
  }

  private async loadAttempt(operationId: string, retryOnlyFailed: boolean) {
    const saved = await this.ledger.operation(operationId);
    const records = await this.ledger.assets(operationId);
    const eligibleStatuses = retryOnlyFailed ? ['failed'] : ['pending', 'prepared'];
    const attempt = (!retryOnlyFailed && saved.attempt) || {
      id: crypto.randomUUID(),
      assetIds: records
        .filter((record) => eligibleStatuses.includes(record.status))
        .map((r) => r.id),
    };
    const operation = { ...saved, attempt, status: 'running' as const };
    return { operation, records };
  }

  private async attempt(
    operation: BatchOperation,
    previous: BatchAssetRecord,
  ): Promise<BatchAssetRecord> {
    let prepared = previous;
    try {
      const patch = previous.prepared ?? (await this.callbacks.prepare(operation, previous.id));
      prepared = {
        ...previous,
        prepared: patch,
        attemptId: operation.attempt!.id,
        status: 'prepared',
        error: undefined,
      };
      await this.ledger.saveAsset(prepared);
      if (this.cancelled) return { ...prepared, status: 'prepared' };
      await this.callbacks.write(operation, previous.id, prepared.prepared!);
      return { ...prepared, status: 'applied', error: undefined };
    } catch (error) {
      return {
        ...prepared,
        attemptId: operation.attempt!.id,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  private async finish(
    operation: BatchOperation,
    records: BatchAssetRecord[],
  ): Promise<BatchRecordView> {
    const pending = records.some(
      (record) => record.status === 'pending' || record.status === 'prepared',
    );
    const status = this.cancelled ? 'cancelled' : pending ? 'ready' : 'complete';
    const settled: BatchOperation = {
      ...operation,
      status,
      attempt: this.cancelled ? operation.attempt : undefined,
    };
    await this.ledger.saveOperation(settled);
    const view = this.makeView(settled, records);
    this.callbacks.changed(view);
    return view;
  }
}
