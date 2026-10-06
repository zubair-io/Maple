import * as wasm from './pkg/raw_wasm';
import type { render_bytes } from './pkg/raw_wasm';
import type { DecodeRequest } from './raw-pipeline.decode.types';

type CpuSession = {
  render(
    xmp: string | null,
    preview: boolean,
    cap: number,
    film: Uint8Array,
  ): ReturnType<typeof render_bytes>;
  free(): void;
};
let retained: { token: number; ext: string; session: CpuSession } | undefined;
const emptyFilm = new Uint8Array(0);

/** Same decode-success shape and request generation; only source custody changes. */
export function renderRetainedCpu(
  req: DecodeRequest,
  film: Uint8Array | null,
): ReturnType<typeof render_bytes> {
  if (req.cpuSourceToken === undefined || !req.maxLongEdge) {
    throw new Error('Retained CPU render requires source generation and viewport cap');
  }
  if (retained?.token !== req.cpuSourceToken || retained.ext !== req.ext) {
    if (!req.bytes.byteLength) throw new Error('CPU source generation has not been opened');
    releaseRetainedCpu();
    const constructor = Reflect.get(wasm, 'CpuLiveSession') as
      | {
          open(bytes: Uint8Array, ext: string): CpuSession;
        }
      | undefined;
    if (!constructor) throw new Error('Shipping WASM lacks CpuLiveSession');
    const session = constructor.open(new Uint8Array(req.bytes), req.ext);
    retained = { token: req.cpuSourceToken, ext: req.ext, session };
  }
  return retained.session.render(
    req.xmp ?? null,
    req.qualityPreview ?? false,
    req.maxLongEdge,
    film ?? emptyFilm,
  );
}
export function releaseRetainedCpu(): void {
  retained?.session.free();
  retained = undefined;
}
