/// <reference lib="webworker" />

import { render_bytes } from './pkg/raw_wasm';
import { initRawWasm, type RawWasmInitResult } from './raw-wasm-init';
import type { DecodeRequest, WorkerResponse } from './raw-pipeline.types';

let readyPromise: Promise<RawWasmInitResult> | null = null;

function ensureReady(): Promise<RawWasmInitResult> {
  if (!readyPromise) {
    readyPromise = initRawWasm().then((result) => {
      // Let the main thread know whether threading is live so the UI can
      // show a "single-threaded mode" indicator on non-isolated hosts.
      const statusMsg: WorkerResponse = {
        id: 0,
        type: 'status',
        threaded: result.threaded,
        threads: result.threads,
      };
      (self as unknown as Worker).postMessage(statusMsg);
      return result;
    });
  }
  return readyPromise;
}

// Kick off init eagerly so the status message is delivered without waiting
// for the first decode request.
void ensureReady();

addEventListener('message', async (event: MessageEvent<DecodeRequest>) => {
  const req = event.data;
  if (req.type !== 'decode') return;
  try {
    await ensureReady();
    const bytes = new Uint8Array(req.bytes);
    const result = render_bytes(bytes, req.ext, req.xmp ?? null);
    const rgb = result.rgb;
    const buffer = rgb.buffer.slice(rgb.byteOffset, rgb.byteOffset + rgb.byteLength);
    const response: WorkerResponse = {
      id: req.id,
      type: 'decode-success',
      width: result.width,
      height: result.height,
      rgb: buffer,
    };
    (self as unknown as Worker).postMessage(response, [buffer]);
  } catch (e) {
    const response: WorkerResponse = {
      id: req.id,
      type: 'decode-error',
      message: e instanceof Error ? e.message : String(e),
    };
    (self as unknown as Worker).postMessage(response);
  }
});
