/// <reference lib="webworker" />
// Worker-side mask colour-range eyedropper (#362).
//
// Own file, like `raw-pipeline.sample-wb-handler.ts`, to keep
// `raw-pipeline.worker.ts` inside its size budget.
//
// The WASM entry rejects with a message whose head is a stable kind
// (`neutral:`, `too_dark:`, …). That head is forwarded verbatim in the
// `sample-range-error` reply so the UI can phrase an actionable message
// without parsing prose — `parseRangeSampleError` does the split.

import { sample_mask_range_from_bytes } from './pkg/raw_wasm';
import type { SampleRangeRequest } from './raw-pipeline.sample-range.types';
import { parseRangeSampleError } from './raw-pipeline.sample-range.types';
import type { WorkerResponse } from './raw-pipeline.types';
import { markStart, markEnd } from './raw-pipeline.perf';

/**
 * Sample the colour at the request's normalised point and reply with the
 * range seed for it.
 *
 * The WASM handle is freed before the reply is posted so a rejected sample
 * and a successful one leave the same (empty) WASM-side footprint.
 */
export function handleSampleRange(req: SampleRangeRequest): void {
  const startMark = `maple:sample-range:${req.id}:start`;
  try {
    markStart(startMark);
    const result = sample_mask_range_from_bytes(
      new Uint8Array(req.bytes),
      req.ext,
      req.xmp ?? undefined,
      req.nx,
      req.ny,
    );
    const seed = {
      hueDeg: result.hue_deg,
      chromaMin: result.chroma_min,
      lMin: result.l_min,
      lMax: result.l_max,
    };
    result.free();
    markEnd(startMark, `maple:sample-range:${req.id}:end`, 'maple:sample-range');
    const response: WorkerResponse = { id: req.id, type: 'sample-range-success', seed };
    (self as unknown as Worker).postMessage(response);
  } catch (e) {
    markEnd(startMark, `maple:sample-range:${req.id}:end`, 'maple:sample-range');
    const raw = e instanceof Error ? e.message : String(e);
    const { kind, message } = parseRangeSampleError(raw);
    const response: WorkerResponse = { id: req.id, type: 'sample-range-error', kind, message };
    (self as unknown as Worker).postMessage(response);
  }
}
