/**
 * Child-process entry that owns the ONNX face pipeline (SCRFD detect + ArcFace
 * embed).
 *
 * Replaces the prior Bun Worker THREAD (`face-pool.worker.ts`). The detector's
 * `session.run()` is 50–300 ms of synchronous native inference that
 * `onnxruntime-node` does not yield for, and a Worker thread shared the API's
 * address space — so an ORT segfault on a malformed crop took the whole server
 * down, and the inference's CPU competed with the HTTP event loop. As an
 * isolated, lower-priority child PROCESS (see `installChildHardening`): a native
 * crash kills only this child (the pool respawns), and the inference yields CPU
 * to request handling under indexer load. See `face-pool.ts` for the manager.
 *
 * The child runs the *real* `OnnxFaceDetector` wholesale — identical output to
 * the in-process path; this is a timing/isolation change, never a results
 * change. Only small values cross IPC: a `DetectedFace[]` for detect, a 512-d
 * `Float32Array` for embed. The heavy buffers (input JPEG, NCHW tensors, the
 * decoded RGB plane) never leave this process.
 */

import { OnnxFaceDetector, ThumbDecodeError, type DetectedFace } from './face-detector.ts';
import { loadFaceModels, type FaceModelsConfig } from './face-models.ts';
import type { FaceWorkerRequest, FaceWorkerResponse } from './face-pool-protocol.ts';
import { installChildHardening } from '../runtime/child-process-worker.ts';

// Lower CPU priority (so the HTTP server wins under indexer load) + self-exit
// if the parent dies. Shared with the FFI decode child; see runtime.
installChildHardening('face');

// One detector for the process lifetime; it lazily loads the model pair on the
// first detect/embed/preload via `loadFaceModels`'s singleton.
const detector = new OnnxFaceDetector();

function post(msg: FaceWorkerResponse): void {
  // `process.send` exists only when spawned with an IPC channel (always true
  // via the pool). The optional-chain keeps a stray direct invocation safe.
  process.send?.(msg);
}

process.on('message', (raw: unknown) => {
  const req = raw as FaceWorkerRequest;
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
  // Relay the real load outcome so the /settings/enrichment badge reflects
  // truth. Only the genuine terminal states get relayed (no speculative
  // 'downloading' — that status specifically means the antelopev2 auto-download
  // branch ran; see face-models.ts).
  try {
    await loadFaceModels(config);
    post({ type: 'loadStatus', kind: 'loaded' });
    post({ type: 'preload', id, ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    post({ type: 'loadStatus', kind: 'error', errorDetail: message });
    // Preload failures are non-fatal: ok=false so the pool resolves (the first
    // real inference retries the load and surfaces the error to the stage).
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
