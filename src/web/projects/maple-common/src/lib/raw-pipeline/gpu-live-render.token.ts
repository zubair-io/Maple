// GPU_LIVE_RENDER_ENABLED — runtime flag (epic #925, P4b-web / #1029 / #1059) that
// routes the live RAW render through the wgpu+WGSL GPU chain (`render_bytes_gpu` /
// `WebLiveSession`) instead of the WASM-CPU `render_bytes` path.
//
// Default `true` (#1059): the shipped WASM bundle now co-builds the `gpu` AND
// `parallel` features into ONE threaded-GPU bundle (`wasm-pack build --target web
// --features gpu,parallel`), so the GPU entry points are present. The worker still
// makes the path SAFE at runtime — it only calls the GPU entry when this is `true`
// AND the runtime advertises WebGPU (`'gpu' in navigator`) AND the bundle exports
// it; on a no-WebGPU browser, or if the WebGPU adapter is broken (`requestAdapter()`
// fails), it falls back to the threaded-CPU `render_bytes`. So flipping this default
// on does NOT change behaviour on a no-WebGPU host — that path stays byte-for-byte
// the threaded CPU render it is today.
//
// Operator override per deployment in `app.config.ts` (e.g. a kill-switch):
//   { provide: GPU_LIVE_RENDER_ENABLED, useValue: false }
// A DB-backed settings gate for runtime operator ramp/kill is tracked as a
// fast-follow (see #1059's follow-up); until then this token is the switch.
//
// Real-WebGPU-browser parity + the 16 ms slider-tick budget remain a manual
// checkpoint (W3 / #1029) — headless CI WebGPU is unreliable.

import { InjectionToken } from '@angular/core';

export const GPU_LIVE_RENDER_ENABLED = new InjectionToken<boolean>('GPU_LIVE_RENDER_ENABLED', {
  providedIn: 'root',
  factory: () => true,
});
