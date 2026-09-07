// Dispatch helper for the mask colour-range eyedropper (#362) — same shape
// as `raw-pipeline.sample-wb-request.ts`.

import type { RegisterPending } from './raw-pipeline.export-request';
import type { MaskRangeSeed, SampleRangeRequest } from './raw-pipeline.sample-range.types';
import { dispatchWithMark } from './raw-pipeline.dispatch-with-mark';

export function dispatchSampleRange(
  worker: Worker,
  id: number,
  register: RegisterPending,
  bytes: Uint8Array,
  ext: string,
  xmp: string | undefined,
  nx: number,
  ny: number,
): Promise<MaskRangeSeed> {
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const request: SampleRangeRequest = { id, type: 'sample-range', bytes: buffer, ext, xmp, nx, ny };
  return dispatchWithMark<MaskRangeSeed>(
    worker,
    request,
    [buffer],
    'maple:sample-range',
    ({ resolve, reject }) => ({ kind: 'sample-range', resolve, reject }),
    register,
  );
}
