// Export request dispatch (#943) — extracted from `raw-pipeline.service.ts`
// so that file stays inside the 600-line hard budget.
//
// Pure function over the worker plus the service's pending-handler registry;
// `RawPipelineService.exportImage` keeps ownership of the `decodeChain`
// serialisation gate and just delegates the round trip here. The post/mark/
// register boilerplate itself lives in `raw-pipeline.dispatch-with-mark.ts`
// (#3039 review — shared with `auto-adjust-request.ts` / `develop-non-raw-request.ts`,
// which had grown byte-for-byte identical copies of it).

import type { RemovalCompanionBundle } from '../removal/removal-companion-bundle';
import type { ExportedFile, ExportRequest, RawExportOptions } from './raw-pipeline.types';
import { dispatchWithMark, type RegisterPending } from './raw-pipeline.dispatch-with-mark';

export type { RegisterPending } from './raw-pipeline.dispatch-with-mark';

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
  filmLut?: ArrayBuffer,
  saved?: RemovalCompanionBundle,
): Promise<ExportedFile> {
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const removals = saved
    ? { manifest: saved.manifest, companions: saved.bytes.slice().buffer as ArrayBuffer }
    : undefined;
  const request: ExportRequest = {
    id,
    type: 'export',
    bytes: buffer,
    ext,
    xmp,
    options,
    filmLut,
    removals,
  };
  const transfer = [
    buffer,
    ...(filmLut ? [filmLut] : []),
    ...(removals ? [removals.companions] : []),
  ];
  return dispatchWithMark<ExportedFile>(
    worker,
    request,
    transfer,
    'maple:export',
    ({ resolve, reject }) => ({ kind: 'export', resolve, reject }),
    register,
  );
}
