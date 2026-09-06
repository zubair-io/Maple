/// <reference lib="webworker" />
import { IndexedBatchLedger, type BatchOperation, type BatchRecordView } from './batch-ledger';
import { PersistentBatchRunner } from './persistent-batch-runner';
import type { PreparedBatchPatch } from './batch-ledger';
import type { BatchTransferProgress } from '../../generated/batch-transfer.generated';

export type BatchWorkerCommand =
  | { requestId: number; type: 'load' }
  | { requestId: number; type: 'cancel' }
  | { requestId: number; type: 'start'; operation: BatchOperation }
  | { requestId: number; type: 'resume'; operationId: string; retryOnlyFailed: boolean }
  | { requestId: number; type: 'delete'; operationId: string }
  | { requestId: number; type: 'asset-result'; patch?: PreparedBatchPatch; error?: string };
export type BatchWorkerEvent =
  | { type: 'result'; requestId: number; view?: BatchRecordView; error?: string }
  | { type: 'changed'; view: BatchRecordView }
  | { type: 'progress'; operationId: string; progress: BatchTransferProgress }
  | {
      type: 'prepare' | 'write';
      requestId: number;
      operationId: string;
      id: string;
      patch?: PreparedBatchPatch;
    };

const ledger = new IndexedBatchLedger();
const pending = new Map<
  number,
  { resolve: (patch: PreparedBatchPatch | undefined) => void; reject: (error: Error) => void }
>();
let nextAssetRequest = 0;
let cancelEpoch = 0;
const send = (message: BatchWorkerEvent) => postMessage(message);
function assetStep(
  type: 'prepare' | 'write',
  operation: BatchOperation,
  id: string,
  patch?: PreparedBatchPatch,
): Promise<PreparedBatchPatch | undefined> {
  const requestId = ++nextAssetRequest;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    send({ type, requestId, operationId: operation.id, id, patch });
  });
}
const runner = new PersistentBatchRunner(ledger, {
  prepare: async (operation, id) => (await assetStep('prepare', operation, id))!,
  write: async (operation, id, patch) => {
    await assetStep('write', operation, id, patch);
  },
  changed: (view, progress) =>
    progress
      ? send({ type: 'progress', operationId: view.operation.id, progress })
      : send({ type: 'changed', view }),
});

async function createOperation(operation: BatchOperation): Promise<void> {
  const prior = await ledger.latest();
  if (prior && prior.status !== 'complete')
    throw new Error('Resume or dismiss the previous batch before starting another.');
  if (prior) await ledger.delete(prior.id);
  await ledger.create(operation);
}

addEventListener('message', async (event: MessageEvent<BatchWorkerCommand>) => {
  const command = event.data;
  const startingEpoch = cancelEpoch;
  if (command.type === 'asset-result') {
    const step = pending.get(command.requestId);
    pending.delete(command.requestId);
    if (command.error) step?.reject(new Error(command.error));
    else step?.resolve(command.patch);
    return;
  }
  try {
    let view: BatchRecordView | undefined;
    if (command.type === 'cancel') {
      ++cancelEpoch;
      await runner.cancel();
    } else if (command.type === 'load') {
      const operation = await ledger.latest();
      if (operation) view = await runner.view(operation);
    } else {
      // Browser releases the lock when a tab/worker dies. An interrupted
      // prepared item is then safe for the next tab to resume, exactly once
      // at a time. Never run two tabs' sidecar writers concurrently.
      if (!navigator.locks)
        throw new Error(
          'This browser cannot safely resume batch edits. Use a browser with Web Locks support.',
        );
      view = await navigator.locks.request(
        'maple-batch-sync',
        { ifAvailable: true },
        async (lock) => {
          if (!lock) throw new Error('A batch is running in another Maple tab.');
          if (command.type === 'delete') {
            await ledger.delete(command.operationId);
            return undefined;
          }
          if (command.type === 'start') await createOperation(command.operation);
          const operationId = command.type === 'start' ? command.operation.id : command.operationId;
          if (startingEpoch !== cancelEpoch) {
            const cancelled = {
              ...(await ledger.operation(operationId)),
              status: 'cancelled' as const,
            };
            await ledger.saveOperation(cancelled);
            return runner.view(cancelled);
          }
          return runner.run(operationId, command.type === 'resume' && command.retryOnlyFailed);
        },
      );
    }
    send({ type: 'result', requestId: command.requestId, view });
  } catch (error) {
    send({
      type: 'result',
      requestId: command.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
