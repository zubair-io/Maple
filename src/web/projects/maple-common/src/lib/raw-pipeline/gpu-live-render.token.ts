// GPU_LIVE_RENDER_ENABLED — runtime flag (epic #925, P4b-web / #1029) that
// routes the live RAW render through the wgpu+WGSL GPU chain
// (`render_bytes_gpu`) instead of the WASM-CPU `render_bytes` path.
//
// Default `false`: the CPU `render_bytes` + WebGL2 paths stay the shipping
// default (deletion is P5). Flag OFF is byte-for-byte today's behaviour — the
// worker only calls the GPU entry when this is `true` AND the loaded WASM build
// actually exports it (the GPU entry is gated behind raw-wasm's `gpu` feature;
// the default `wasm-pack --features parallel` build does not include it, so a
// flag-on request against a gpu-off bundle falls back to `render_bytes`).
//
// Override per deployment in `app.config.ts`:
//   { provide: GPU_LIVE_RENDER_ENABLED, useValue: true }
// and build the WASM with `wasm-pack build --target web --features gpu,parallel`
// (then `sync-raw-wasm.sh`) so `render_bytes_gpu` is present. Real-WebGPU-browser
// parity + the 16 ms slider-tick budget are a manual checkpoint (W3 / #1029) —
// headless CI WebGPU is unreliable.

import { InjectionToken } from '@angular/core';

export const GPU_LIVE_RENDER_ENABLED = new InjectionToken<boolean>('GPU_LIVE_RENDER_ENABLED', {
  providedIn: 'root',
  factory: () => false,
});
