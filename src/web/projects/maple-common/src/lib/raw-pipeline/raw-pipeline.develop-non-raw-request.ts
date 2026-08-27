// Non-RAW develop request dispatch (#3039) — extracted from
// `raw-pipeline.service.ts` so that file stays inside the 600-line hard
// budget. Mirrors `raw-pipeline.auto-adjust-request.ts` / `raw-pipeline.export-request.ts`:
// a pure function over the worker plus the service's pending-handler registry.
// `RawPipelineService.developNonRawOnce` keeps ownership of the `decodeChain`
// serialisation gate and the browser-side scene-linear conversion, and just
// delegates the worker round trip here. The post/mark/register boilerplate
// itself lives in `raw-pipeline.dispatch-with-mark.ts`, shared with the other
// two dispatch functions above.

import type { RegisterPending } from './raw-pipeline.export-request';
import type { DecodedImage, DevelopNonRawRequest } from './raw-pipeline.types';
import { dispatchWithMark } from './raw-pipeline.dispatch-with-mark';

/**
 * Post one `develop-non-raw` request and resolve with the developed
 * `DecodedImage`. `rgba` is NOT a RAW file's bytes — it's the caller's own
 * browser-decoded scene-linear Rec.2020 f32 RGBA buffer
 * (`decodeNonRawToSceneLinearF32`), transferred like every other decode
 * request's bytes.
 *
 * Replies through the SAME `decode-success`/`decode-error` pair `decodeOnce`
 * does (`kind: 'legacy'`) — see `raw-wasm`'s `develop_non_raw` doc for why
 * the result is the identical `MapleRender` shape.
 */
export function dispatchDevelopNonRaw(
  worker: Worker,
  id: number,
  register: RegisterPending,
  rgba: Float32Array,
  width: number,
  height: number,
  xmp: string | undefined,
): Promise<DecodedImage> {
  const buffer = rgba.buffer as ArrayBuffer;
  const request: DevelopNonRawRequest = {
    id,
    type: 'develop-non-raw',
    rgba: buffer,
    width,
    height,
    xmp,
  };
  return dispatchWithMark<DecodedImage>(
    worker,
    request,
    [buffer],
    'maple:decode-non-raw',
    ({ resolve, reject }) => ({ kind: 'legacy', resolve, reject }),
    register,
  );
}
