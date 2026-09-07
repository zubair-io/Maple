import '@angular/compiler';
import { BatchWorkerClient } from '../../projects/maple-common/src/lib/editor/copy-paste/batch-worker-client';
import { buildTransferPatch } from '../../projects/maple-common/src/lib/editor/copy-paste/adjustment-transfer';
import { defaultAdjustmentModel } from '../../projects/maple-common/src/lib/models/adjustment-model';
import { XmpSerializerService } from '../../projects/maple-common/src/lib/xmp/xmp-serializer.service';
import type {
  BatchOperation,
  BatchRecordView,
} from '../../projects/maple-common/src/lib/editor/copy-paste/batch-ledger';

// A browser-only test host for the production Worker and IndexedDB ledger.
// OPFS supplies actual durable files and transferable directory handles.
const directory = await navigator.storage.getDirectory();
const serializer = new XmpSerializerService();
let latest: BatchRecordView | undefined;
let stopAfter = 0;
let writes = 0;
let failId: string | undefined;
let holdAfterWrite = false;
const worker = new BatchWorkerClient({
  prepare: async (operation) => ({
    patch: buildTransferPatch(operation.request!),
    before: {},
    after: {},
  }),
  write: async (_operation, id, prepared) => {
    if (id === failId) throw new Error('The test photo is read-only.');
    const handle = await directory.getFileHandle(id + '.xmp', { create: true });
    const writer = await handle.createWritable();
    await writer.write(serializer.serialize({ ...defaultAdjustmentModel(), ...prepared.patch }));
    await writer.close();
    writes++;
    if (holdAfterWrite) await new Promise(() => {});
  },
  changed: (view, progress) => {
    latest = view;
    if (progress && stopAfter && progress.processed >= stopAfter)
      void worker.request({ type: 'cancel' });
  },
});
const api = {
  ready: true,
  configure: (options: { stopAfter?: number; failId?: string; holdAfterWrite?: boolean }) => {
    stopAfter = options.stopAfter ?? 0;
    failId = options.failId;
    holdAfterWrite = options.holdAfterWrite ?? false;
  },
  writes: () => writes,
  start: async () => {
    const operation: BatchOperation = {
      id: crypto.randomUUID(),
      libraryId: 'browser-test',
      createdAt: Date.now(),
      status: 'ready',
      directory,
      request: {
        source: { ...defaultAdjustmentModel(), exposure: 1.25 },
        groups: ['tone'],
        relativeWhiteBalance: false,
      },
      assetIds: ['a', 'b', 'c'],
      assetNames: { a: 'a.dng', b: 'b.dng', c: 'c.dng' },
    };
    return worker.request({ type: 'start', operation });
  },
  load: () => worker.request({ type: 'load' }),
  resume: (id: string, retryOnlyFailed = false) =>
    worker.request({ type: 'resume', operationId: id, retryOnlyFailed }),
  dismiss: (id: string) => worker.request({ type: 'delete', operationId: id }),
  read: async (id: string) => {
    try {
      return await (await (await directory.getFileHandle(id + '.xmp')).getFile()).text();
    } catch {
      return null;
    }
  },
  current: () => latest,
  stopWorker: () => worker.destroy(),
};
Object.assign(window, { batchTest: api });
export type BatchBrowserTest = typeof api;
