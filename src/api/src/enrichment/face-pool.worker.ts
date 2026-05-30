/**
 * Bun Worker entry point that owns the ONNX face pipeline.
 *
 * Before this worker, the SCRFD-10G detector's `session.run()` (50–300 ms of
 * synchronous native inference that `onnxruntime-node` does NOT yield for),
 * the ArcFace R100 embed, and the surrounding CPU loops — `alignFaceCrop`'s
 * 112×112 bilinear warp and `decodeScrfdOutputs`' ~16.8k-anchor decode + NMS —
 * all ran on the main HTTP thread inside the `face-detect` / `face-embed`
 * stage handlers (dispatched via `run-stage.ts`'s `dispatchPool`). Every
 * face-bearing asset froze the whole Bun event loop, stalling every request
 * including `GET /api/health`. See `face-pool.ts` for the manager side and
 * ticket #707 for the diagnosis.
 *
 * The worker runs the *real* `OnnxFaceDetector` wholesale — the exact class
 * the main thread used to call in-process — so its detect/embed output is
 * byte-identical to the old path. Moving it here changes timing only, never
 * results. The two ONNX `InferenceSession` instances live entirely on this
 * thread (loaded once via `loadFaceModels`, the same bootstrap logic, honouring
 * `MAPLE_FACE_ORT_INTRA_OP_THREADS` / `MAPLE_FACE_ORT_INTER_OP_THREADS`, both
 * inherited from `process.env` which Bun copies into the worker). Only the
 * small results cross `postMessage`: a detection array for `detect`, a 512-d
 * Float32Array for `embed`. The heavy buffers (the input JPEG bytes, the NCHW
 * tensors, the rendered RGB plane) never leave this thread.
 */

import { OnnxFaceDetector, ThumbDecodeError, type DetectedFace } from './face-detector.ts';
import { loadFaceModels, type FaceModelsConfig } from './face-models.ts';
import type { FaceWorkerRequest, FaceWorkerResponse } from './face-pool-protocol.ts';

// One detector instance for the worker's lifetime. It lazily loads the model
// pair on first detect/embed/preload through `loadFaceModels`'s singleton, so
// every request reuses the same warm sessions.
const detector = new OnnxFaceDetector();

function post(msg: FaceWorkerResponse): void {
  self.postMessage(msg);
}

self.addEventListener('message', (event: MessageEvent) => {
  const req = event.data as FaceWorkerRequest;
  if (!req || typeof req !== 'object') return;

  switch (req.type) {
    case 'preload':
      void runPreload(req.id, req.config);
      return;
    case 'detect':
      void runDetect(req.id, req.jpegBytes);
      return;
    case 'embed':
      void runEmbed(req.id, req.jpegBytes, req.detection);
      return;
  }
});

async function runPreload(id: number, config: FaceModelsConfig): Promise<void> {
  // Relay the real load outcome to the main thread so the
  // /settings/enrichment badge reflects truth (the worker's `liveStatus` is a
  // separate module instance the main thread can't read). We do NOT post a
  // speculative `'downloading'` here: that status specifically means the
  // antelopev2 auto-download branch ran (see `face-models.ts`), so emitting it
  // unconditionally would show "downloading" even when the models are already
  // on disk. Only the genuine terminal states get relayed.
  try {
    await loadFaceModels(config);
    post({ type: 'loadStatus', kind: 'loaded' });
    post({ type: 'preload', id, ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    post({ type: 'loadStatus', kind: 'error', errorDetail: message });
    // preload failures are non-fatal: report ok=false so the pool resolves
    // (the first real inference will retry the load and surface the error to
    // the stage handler, exactly as the old main-thread preload did).
    post({ type: 'preload', id, ok: false, error: message });
  }
}

async function runDetect(id: number, jpegBytes: Uint8Array): Promise<void> {
  try {
    const detections = await detector.detectFaces(jpegBytes);
    post({ type: 'detect', id, ok: true, detections });
  } catch (err) {
    post({
      type: 'detect',
      id,
      ok: false,
      errorKind: err instanceof ThumbDecodeError ? 'thumb-decode' : 'generic',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function runEmbed(id: number, jpegBytes: Uint8Array, detection: DetectedFace): Promise<void> {
  try {
    const embedding = await detector.embedFace(jpegBytes, detection);
    post({ type: 'embed', id, ok: true, embedding });
  } catch (err) {
    post({
      type: 'embed',
      id,
      ok: false,
      errorKind: err instanceof ThumbDecodeError ? 'thumb-decode' : 'generic',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
