// Export request dispatch (#943) — extracted from `raw-pipeline.service.ts`
// so that file stays inside the 600-line hard budget.
//
// Pure function over the worker plus the service's pending-handler registry;
// `RawPipelineService.exportImage` keeps ownership of the `decodeChain`
// serialisation gate and just delegates the round trip here.

import type { PendingHandler } from './raw-pipeline.service-internals';
import type { ExportedFile, ExportRequest, RawExportOptions } from './raw-pipeline.types';
import { markStart, markEnd } from './raw-pipeline.perf';

/** Registers a pending handler against a correlation id. */
export type RegisterPending = (id: number, handler: PendingHandler) => void;

/**
 * Post one export request and resolve with the encoded file.
 *
 * The RAW bytes are copied off the caller's view before being transferred, so
 * the caller's `Uint8Array` stays usable for a later decode (mirrors
 * `decodeOnce`). The reply is a `Blob` the worker assembled from chunks, so
 * nothing here ever holds a full-resolution buffer.
 */
export function dispatchExport(
  worker: Worker,
  id: number,
  register: RegisterPending,
  bytes: Uint8Array,
  ext: string,
  options: RawExportOptions,
  xmp: string | undefined,
): Promise<ExportedFile> {
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const request: ExportRequest = { id, type: 'export', bytes: buffer, ext, xmp, options };
  const startMark = `maple:export:${id}:start`;
  markStart(startMark);
  return new Promise<ExportedFile>((resolve, reject) => {
    register(id, {
      kind: 'export',
      resolve: (file) => {
        markEnd(startMark, `maple:export:${id}:end`, 'maple:export');
        resolve(file);
      },
      reject,
    });
    worker.postMessage(request, [buffer]);
  });
}
