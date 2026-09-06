// Legacy decode worker request contract.
export interface DecodeRequest {
  id: number; // round-trip correlation id
  type: 'decode';
  bytes: ArrayBuffer; // transferable
  ext: string;
  xmp?: string;
  /**
   * Route this render through the wgpu+WGSL GPU live chain (`render_bytes_gpu`)
   * instead of the WASM-CPU `render_bytes` path (epic #925, P4b-web / #1029).
   * Set from `GPU_LIVE_RENDER_ENABLED`. The worker honours it only when the
   * loaded WASM bundle actually exports `render_bytes_gpu` (the `gpu`-feature
   * build); otherwise — and when absent/false — it falls back to `render_bytes`,
   * so a flag-on request against the default (gpu-off) bundle is still correct.
   * The `decode-success` response shape is identical either way (u8 RGB).
   */
  gpu?: boolean;
  /**
   * Cap the render's long edge in REAL (backing-store) pixels (#1101, spec
   * §5.1): the worker routes to the sized entry (`render_bytes_sized`), which
   * downsamples right after demosaic so every later stage runs at the capped
   * size. Never upscales. When set, the render runs on the threaded-CPU sized
   * path (the editor's 2D fast/refine phases — the GPU live path uses the
   * persistent session instead, see `OpenSessionRequest`, whose develop is fit
   * to the same target per #1080). The GPU one-shot route (`render_bytes_gpu`)
   * shares the contract — same name, same units, same never-upscale — and the
   * worker passes the field through to it; unsized GPU one-shots self-cap at
   * the WASM-side 2048 default (#1080), so no route develops a 100 MP frame at
   * full sensor res.
   */
  maxLongEdge?: number;
  /**
   * Only honoured with `maxLongEdge`: `true` runs the half-res Preview
   * demosaic (the fast-phase cost profile), `false`/absent runs Full (the
   * refine phase). The unsized path stays Full-quality, as today.
   */
  qualityPreview?: boolean;
  /** Baked `.mlut` grid (#2683); absent/empty means no film look, regardless
   * of the sidecar fields. `handleLegacyDecode` always uses the CPU film
   * entry when present, even with `gpu: true`: unsized requests use
   * `render_bytes_with_film`, sized requests `render_bytes_sized_with_film`
   * (#2719). One-shot GPU has no film-aware entry; WebLiveSession does.
   * ImageCanvasFilmSync → runRender2d → RawPipelineService.decode supplies
   * this cache (#3171). Structured-clone it: transferring would detach the
   * buffer reused by subsequent fast/refine ticks and native patches. */
  filmLut?: ArrayBuffer;
}
