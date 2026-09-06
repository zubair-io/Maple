import type { BatchWorkerCommand, BatchWorkerEvent } from './batch-sync.worker';
import type { BatchRecordView } from './batch-ledger';
import type { PersistentBatchCallbacks } from './persistent-batch-runner';

type Command = BatchWorkerCommand extends infer T
  ? T extends { requestId: number }
    ? Omit<T, 'requestId'>
    : never
  : never;
export class BatchWorkerClient {
  private nextRequest = 0;
  private current?: BatchRecordView;
  private pending = new Map<
    number,
    { resolve: (view: BatchRecordView | undefined) => void; reject: (error: Error) => void }
  >();
  private readonly worker: Worker;
  private failure?: Error;
  isUnavailable(): boolean {
    return this.failure !== undefined;
  }
  constructor(private readonly callbacks: PersistentBatchCallbacks) {
    this.worker = new Worker(new URL('./batch-sync.worker', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<BatchWorkerEvent>) => {
      void this.receive(event.data);
    };
    this.worker.onmessageerror = () =>
      this.fail(new Error('Batch worker communication stopped. Reconnect to its saved record.'));
    this.worker.onerror = (event) =>
      this.fail(
        new Error(
          event.message || 'Batch worker stopped. Reopen Maple to resume its saved record.',
        ),
      );
  }
  request(command: Command): Promise<BatchRecordView | undefined> {
    if (this.failure) return Promise.reject(this.failure);
    const requestId = ++this.nextRequest;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker.postMessage({ ...command, requestId });
    });
  }
  private async receive(message: BatchWorkerEvent): Promise<void> {
    if (message.type === 'changed') {
      this.current = message.view;
      this.callbacks.changed(message.view);
      return;
    }
    if (message.type === 'progress') {
      if (this.current) this.callbacks.changed(this.current, message.progress);
      return;
    }
    if (message.type === 'result') {
      const response = this.pending.get(message.requestId);
      this.pending.delete(message.requestId);
      if (message.error) response?.reject(new Error(message.error));
      else response?.resolve(message.view);
      return;
    }
    await this.assetStep(message);
  }
  private async assetStep(
    message: Extract<BatchWorkerEvent, { type: 'prepare' | 'write' }>,
  ): Promise<void> {
    try {
      const operation = this.current?.operation;
      if (!operation || operation.id !== message.operationId)
        throw new Error('Batch context was lost; reload to resume.');
      const patch =
        message.type === 'prepare'
          ? await this.callbacks.prepare(operation, message.id)
          : undefined;
      if (message.type === 'write')
        await this.callbacks.write(operation, message.id, message.patch!);
      this.worker.postMessage({
        type: 'asset-result',
        requestId: message.requestId,
        patch,
      } satisfies BatchWorkerCommand);
    } catch (error) {
      this.worker.postMessage({
        type: 'asset-result',
        requestId: message.requestId,
        error: error instanceof Error ? error.message : String(error),
      } satisfies BatchWorkerCommand);
    }
  }
  private fail(error: Error): void {
    this.failure = error;
    this.worker.terminate();
    for (const call of this.pending.values()) call.reject(error);
    this.pending.clear();
  }
  destroy(): void {
    this.fail(new Error('Batch paused when Maple closed.'));
  }
}
