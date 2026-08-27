// Non-RAW develop orchestration (#3039) — extracted from `raw-pipeline.service.ts`
// so that file stays inside the file-size budget headroom
// (tools/check-budget-headroom.sh). Mirrors the `raw-pipeline.decode-route.ts`
// split: a pure function over the pieces `RawPipelineService` owns (the
// worker accessor, the id counter, the pending-handler registry), not a
// method on the class itself.
//
// `RawPipelineService.decode()` keeps ownership of the `decodeChain`
// serialisation gate and just delegates the non-RAW branch's whole body
// here; the worker round trip within it further delegates to
// `dispatchDevelopNonRaw` (`raw-pipeline.develop-non-raw-request.ts`).

import type { DecodedImage } from './raw-pipeline.types';
import { decodeNonRawToSceneLinearF32 } from './image-utils';
import { dispatchDevelopNonRaw } from './raw-pipeline.develop-non-raw-request';
import type { RegisterPending } from './raw-pipeline.export-request';

/**
 * The non-RAW sibling of `decodeOnce` (#3039): decode `bytes` to a
 * scene-linear Rec.2020 f32 RGBA buffer via the browser (NOT the WASM RAW
 * decoder — `decodeNonRawToSceneLinearF32` never touches `rawler`), then
 * dispatch that buffer to the worker for `develop_non_raw` to run the
 * per-tick adjustment chain on (AgX skipped — see that WASM entry's doc).
 * Non-RAW images never downsize (`maxLongEdge`/`qualityPreview` have no
 * non-RAW counterpart — the WASM entry always develops at full size),
 * matching the pre-#3039 contract.
 *
 * `ensureWorker`/`nextId`/`register` are passed in rather than closed over a
 * `RawPipelineService` instance so this stays a plain, independently-testable
 * function — the same shape `raw-pipeline.decode-route.ts`'s
 * `selectLegacyDecodeRoute` already established for this file-budget split.
 */
export async function developNonRaw(
  bytes: Uint8Array,
  xmp: string | undefined,
  ensureWorker: () => Worker,
  nextId: () => number,
  register: RegisterPending,
): Promise<DecodedImage> {
  const scene = await decodeNonRawToSceneLinearF32(bytes);
  let worker: Worker;
  try {
    worker = ensureWorker();
  } catch {
    return Promise.reject(new Error('RawPipelineService: worker unavailable'));
  }
  return dispatchDevelopNonRaw(
    worker,
    nextId(),
    register,
    scene.rgba,
    scene.width,
    scene.height,
    xmp,
  );
}
