/// <reference lib="webworker" />
// Worker-side neutral white-balance sampler (#2434).
//
// Own file, like `raw-pipeline.export-handler.ts`, to keep
// `raw-pipeline.worker.ts` inside its size budget.
//
// The WASM entry rejects with a message whose head is a stable kind
// (`clipped:`, `too_dark:`, …). That head is forwarded verbatim in the
// `sample-wb-error` reply so the UI can phrase an actionable message without
// parsing prose — `parseWbSampleError` on the main thread does the split.

import { sample_white_balance_from_bytes } from './pkg/raw_wasm';
import type { SampleWbRequest } from './raw-pipeline.sample-wb.types';
import { parseWbSampleError } from './raw-pipeline.sample-wb.types';
import type { WorkerResponse } from './raw-pipeline.types';
import { markStart, markEnd } from './raw-pipeline.perf';

/**
 * Sample the neutral at the request's normalised point and reply with the
 * slider pair plus the derivation's version.
 *
 * The WASM handle is freed before the reply is posted so a rejected sample
 * and a successful one leave the same (empty) WASM-side footprint.
 */
export function handleSampleWb(req: SampleWbRequest): void {
  const startMark = `maple:sample-wb:${req.id}:start`;
  try {
    markStart(startMark);
    const result = sample_white_balance_from_bytes(
      new Uint8Array(req.bytes),
      req.ext,
      req.xmp ?? undefined,
      req.nx,
      req.ny,
    );
    const sample = {
      temperature: result.temperature,
      tint: result.tint,
      algorithmVersion: result.algorithm_version,
    };
    result.free();
    markEnd(startMark, `maple:sample-wb:${req.id}:end`, 'maple:sample-wb');
    const response: WorkerResponse = { id: req.id, type: 'sample-wb-success', sample };
    (self as unknown as Worker).postMessage(response);
  } catch (e) {
    markEnd(startMark, `maple:sample-wb:${req.id}:end`, 'maple:sample-wb');
    const raw = e instanceof Error ? e.message : String(e);
    const { kind, message } = parseWbSampleError(raw);
    const response: WorkerResponse = { id: req.id, type: 'sample-wb-error', kind, message };
    (self as unknown as Worker).postMessage(response);
  }
}
