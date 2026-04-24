/// <reference lib="webworker" />

import { render_bytes } from './pkg/raw_wasm';
import { initRawWasm, type RawWasmInitResult } from './raw-wasm-init';
import type { DecodeRequest, WorkerResponse } from './raw-pipeline.types';

// Forward worker console output to the main thread so Rust panic-hook messages
// (which call console.error inside the worker) are visible in browser DevTools
// and in test harnesses that only read the main-frame console.
{
  const forward = (level: 'log' | 'warn' | 'error', orig: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      try {
        (self as unknown as Worker).postMessage({
          id: 0,
          type: 'worker-log',
          level,
          text: args.map((a) => (a instanceof Error ? a.stack ?? a.message : String(a))).join(' '),
        });
      } catch {
        /* ignore — main thread may be gone */
      }
      orig(...args);
    };
  // eslint-disable-next-line no-console
  console.log = forward('log', console.log.bind(console));
  console.warn = forward('warn', console.warn.bind(console));
  console.error = forward('error', console.error.bind(console));
}

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
    // Worker-local mark so DevTools' Performance panel shows the WASM
    // `render_bytes` call as a distinct entry independent of the
    // main-thread round-trip the service brackets.
    performance.mark(`maple:wasm:${req.id}:start`);
    const result = render_bytes(bytes, req.ext, req.xmp ?? null);
    performance.mark(`maple:wasm:${req.id}:end`);
    performance.measure(
      `maple:wasm`,
      `maple:wasm:${req.id}:start`,
      `maple:wasm:${req.id}:end`,
    );
    const rgb = result.rgb;
    const buffer = rgb.buffer.slice(rgb.byteOffset, rgb.byteOffset + rgb.byteLength);
    const response: WorkerResponse = {
      id: req.id,
      type: 'decode-success',
      width: result.width,
      height: result.height,
      rgb: buffer,
      asShotTemperature: result.as_shot_temperature,
      asShotTint: result.as_shot_tint,
    };
    (self as unknown as Worker).postMessage(response, [buffer]);
  } catch (e) {
    const err = e instanceof Error ? e : null;
    // Surface the full stack so main-thread logs show WASM function indices
    // (useful when a trap hits the panic hook and we need more than the
    // message to find the culprit). `worker-log` forwarding carries this to
    // the page console.
    if (err?.stack) console.error('[raw-pipeline.worker] decode threw:', err.message, err.stack);
    const response: WorkerResponse = {
      id: req.id,
      type: 'decode-error',
      message: err?.message ?? String(e),
    };
    (self as unknown as Worker).postMessage(response);
  }
});
