/// <reference lib="webworker" />

import init, { render_bytes } from './pkg/raw_wasm';
import type { DecodeRequest, WorkerResponse } from './raw-pipeline.types';

let ready = false;

async function ensureReady(): Promise<void> {
  if (ready) return;
  await init();
  ready = true;
}

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
