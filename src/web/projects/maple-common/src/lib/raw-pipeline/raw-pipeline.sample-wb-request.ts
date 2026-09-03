// Dispatch helper for the neutral white-balance sampler (#2434) — same shape
// as `raw-pipeline.auto-adjust-request.ts`.

import type { RegisterPending } from './raw-pipeline.export-request';
import type { SampleWbRequest, WbSampleResult } from './raw-pipeline.sample-wb.types';
import { dispatchWithMark } from './raw-pipeline.dispatch-with-mark';

export function dispatchSampleWb(
  worker: Worker,
  id: number,
  register: RegisterPending,
  bytes: Uint8Array,
  ext: string,
  xmp: string | undefined,
  nx: number,
  ny: number,
): Promise<WbSampleResult> {
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const request: SampleWbRequest = { id, type: 'sample-wb', bytes: buffer, ext, xmp, nx, ny };
  return dispatchWithMark<WbSampleResult>(
    worker,
    request,
    [buffer],
    'maple:sample-wb',
    ({ resolve, reject }) => ({ kind: 'sample-wb', resolve, reject }),
    register,
  );
}
