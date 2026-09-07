// Cold one-shot samplers (#2434 white balance, #362 mask colour range) —
// the bodies of `RawPipelineService.sampleWhiteBalance` /
// `sampleMaskRange`, out here because that file is at its size budget (the
// same split `editor-state.wb-sample.ts` made for the same reason).
//
// Every sampler decodes and develops its own probe, so they run behind the
// service's `decodeChain` — the gate `decode()` and the auto-adjust one-shot
// share — which the caller passes in as `queue`. That is the only piece of
// the service these need, which keeps this module a leaf.
//
// Shared parameters: `bytes` is the RAW file (copied; the caller's view is
// not consumed), `ext` its lowercase extension (e.g. `"dng"`), `xmp` the
// current sidecar text or `undefined` for a fresh open, and `(nx, ny)` a
// normalised image point — `(0, 0)` the top-left corner, `(1, 1)` the
// bottom-right.

import type { RegisterPending } from './raw-pipeline.export-request';
import { dispatchSampleWb } from './raw-pipeline.sample-wb-request';
import { dispatchSampleRange } from './raw-pipeline.sample-range-request';
import type { WbSampleResult } from './raw-pipeline.sample-wb.types';
import type { MaskRangeSeed } from './raw-pipeline.sample-range.types';

/** Runs one request behind the service's decode chain, handing it the
 *  worker, a fresh correlation id and the pending-map registrar. */
export type SampleQueue = <T>(
  run: (worker: Worker, id: number, register: RegisterPending) => Promise<T>,
) => Promise<T>;

/**
 * The slider pair that renders the clicked surface neutral, plus the version
 * of the derivation (`wb_algorithm_version`). Rejects with a
 * `WbSampleRejected` naming why the click was not usable — clipped, too
 * dark, outside the image, or outside the slider domain — so the caller can
 * phrase an actionable message rather than a generic failure.
 */
export function sampleWhiteBalance(
  queue: SampleQueue,
  bytes: Uint8Array,
  ext: string,
  xmp: string | undefined,
  nx: number,
  ny: number,
): Promise<WbSampleResult> {
  return queue((worker, id, register) =>
    dispatchSampleWb(worker, id, register, bytes, ext, xmp, nx, ny),
  );
}

/**
 * The four `papp:Range*` coordinates that place the clicked colour at weight
 * 1 in a mask's range refinement, read where raw-core evaluates it — the
 * pixel entering the local-adjustments stage. Rejects with a
 * `RangeSampleRejected` for a neutral, black or out-of-frame click.
 */
export function sampleMaskRange(
  queue: SampleQueue,
  bytes: Uint8Array,
  ext: string,
  xmp: string | undefined,
  nx: number,
  ny: number,
): Promise<MaskRangeSeed> {
  return queue((worker, id, register) =>
    dispatchSampleRange(worker, id, register, bytes, ext, xmp, nx, ny),
  );
}
