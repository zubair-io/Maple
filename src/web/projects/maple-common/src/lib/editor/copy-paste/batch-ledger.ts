// Durable records are separate per asset: advancing a 2,000-photo run never
// rewrites a 2,000-entry document. No original bytes live in this database.
import type { AdjustmentModel } from '../../models/adjustment-model';
import type {
  BatchAssetStatus,
  BatchTransferStatus,
  BatchTransferSummary,
} from '../../generated/batch-transfer.generated';
import type { AdjustmentTransferRequest } from './adjustment-transfer';

export interface BatchOperation {
  id: string;
  libraryId: string;
  createdAt: number;
  status: BatchTransferStatus;
  /** Frozen selection of the in-flight attempt, retained across tab loss. */
  attempt?: { id: string; assetIds: string[] };
  request?: AdjustmentTransferRequest;
  patch?: Partial<AdjustmentModel>;
  assetIds: string[];
  assetNames: Record<string, string>;
  // Directory identity survives repicking (persisted-handle keys do not).
  directory?: FileSystemDirectoryHandle;
}
export interface PreparedBatchPatch {
  patch: Partial<AdjustmentModel>;
  before: Partial<AdjustmentModel>;
  after: Partial<AdjustmentModel>;
}
export interface BatchAssetRecord {
  operationId: string;
  id: string;
  status: BatchAssetStatus;
  attemptId?: string;
  prepared?: PreparedBatchPatch;
  error?: string;
}
export interface BatchRecordView {
  operation: BatchOperation;
  summary: BatchTransferSummary;
  remaining: number;
}
export interface BatchLedger {
  latest(): Promise<BatchOperation | undefined>;
  operation(id: string): Promise<BatchOperation>;
  create(operation: BatchOperation): Promise<void>;
  saveOperation(operation: BatchOperation): Promise<void>;
  assets(operationId: string): Promise<BatchAssetRecord[]>;
  saveAsset(asset: BatchAssetRecord): Promise<void>;
  delete(operationId: string): Promise<void>;
}

function request<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function complete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('Batch ledger write was aborted'));
    tx.onerror = () => reject(tx.error);
  });
}

export class IndexedBatchLedger implements BatchLedger {
  private database?: Promise<IDBDatabase>;
  private db(): Promise<IDBDatabase> {
    return (this.database ??= new Promise((resolve, reject) => {
      const open = indexedDB.open('maple-batch-sync', 1);
      open.onupgradeneeded = () => {
        open.result.createObjectStore('operations', { keyPath: 'id' });
        const assets = open.result.createObjectStore('assets', { keyPath: ['operationId', 'id'] });
        assets.createIndex('operationId', 'operationId');
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    }));
  }
  async latest(): Promise<BatchOperation | undefined> {
    const db = await this.db();
    const all = (await request(
      db.transaction('operations').objectStore('operations').getAll(),
    )) as BatchOperation[];
    return all.sort((a, b) => b.createdAt - a.createdAt)[0];
  }
  async operation(id: string): Promise<BatchOperation> {
    const db = await this.db();
    const value = (await request(
      db.transaction('operations').objectStore('operations').get(id),
    )) as BatchOperation | undefined;
    if (!value) throw new Error('This batch record no longer exists.');
    return value;
  }
  async create(operation: BatchOperation): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(['operations', 'assets'], 'readwrite');
    const done = complete(tx);
    tx.objectStore('operations').add(operation);
    for (const id of operation.assetIds)
      tx.objectStore('assets').add({
        operationId: operation.id,
        id,
        status: 'pending',
      } satisfies BatchAssetRecord);
    await done;
  }
  async saveOperation(operation: BatchOperation): Promise<void> {
    const db = await this.db();
    const tx = db.transaction('operations', 'readwrite');
    const done = complete(tx);
    tx.objectStore('operations').put(operation);
    await done;
  }
  async assets(operationId: string): Promise<BatchAssetRecord[]> {
    const db = await this.db();
    return request(
      db.transaction('assets').objectStore('assets').index('operationId').getAll(operationId),
    );
  }
  async saveAsset(asset: BatchAssetRecord): Promise<void> {
    const db = await this.db();
    const tx = db.transaction('assets', 'readwrite');
    const done = complete(tx);
    tx.objectStore('assets').put(asset);
    await done;
  }
  async delete(operationId: string): Promise<void> {
    const records = await this.assets(operationId);
    const db = await this.db();
    const tx = db.transaction(['operations', 'assets'], 'readwrite');
    const done = complete(tx);
    tx.objectStore('operations').delete(operationId);
    for (const asset of records) tx.objectStore('assets').delete([operationId, asset.id]);
    await done;
  }
}
