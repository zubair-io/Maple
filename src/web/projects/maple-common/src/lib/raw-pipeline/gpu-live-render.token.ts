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
// fails), it falls back to the WASM-CPU `render_bytes`. Chromium-family runtimes
// currently keep that CPU path serial because of #2515; restoration is tracked in
// #2516. Safe, isolated non-Chromium runtimes can still initialize Rayon.
//
// Build/deploy-time override in `app.config.ts`:
//   { provide: GPU_LIVE_RENDER_ENABLED, useValue: false }
//
// #1062: this token is no longer the operator switch — it is the FALLBACK
// default and the hard floor. The runtime ramp/kill is the DB-backed
// `render.gpu_live_render_enabled` setting (Settings → Workers → Web GPU live
// render), combined with this token by `GpuLiveRenderGate`: the token being
// `false` is unconditional, and the DB setting decides otherwise. Consumers
// read `GpuLiveRenderGate.enabled()` (or `RawPipelineService
// .gpuLiveRenderEnabled`), never this token directly.
//
// Real-WebGPU-browser parity + the 16 ms slider-tick budget remain a manual
// checkpoint (W3 / #1029) — headless CI WebGPU is unreliable.

import { InjectionToken } from '@angular/core';

export const GPU_LIVE_RENDER_ENABLED = new InjectionToken<boolean>('GPU_LIVE_RENDER_ENABLED', {
  providedIn: 'root',
  factory: () => true,
});
