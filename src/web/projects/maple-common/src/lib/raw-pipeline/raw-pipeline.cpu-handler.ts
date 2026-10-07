import { CpuLiveSession } from './pkg/raw_wasm';
import type { render_bytes } from './pkg/raw_wasm';
import type { DecodeRequest } from './raw-pipeline.decode.types';

let retained: { token: number; ext: string; session: CpuLiveSession } | undefined;
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
    const session = CpuLiveSession.open(new Uint8Array(req.bytes), req.ext);
    retained = { token: req.cpuSourceToken, ext: req.ext, session };
  }
  return retained.session.render(
    req.xmp ?? null,
    req.qualityPreview ?? false,
    req.maxLongEdge,
    film ?? emptyFilm,
  );
}
function releaseRetainedCpu(): void {
  retained?.session.free();
  retained = undefined;
}

// Requests that decode their own copy of a RAW must not share the WASM heap
// with a retained editor source; the service clears its custody in step.
const DECODING_REQUESTS = new Set([
  'develop-non-raw',
  'open-session',
  'native-detail',
  'export',
  'auto-adjust',
  'sample-wb',
  'sample-range',
  'import-lens-profile',
  'lens-profile-compatible',
  'lens-profile-evidence',
]);
export function releaseRetainedCpuBefore(req: { type: string; cpuSourceToken?: number }): void {
  const unretainedDecode = req.type === 'decode' && req.cpuSourceToken === undefined;
  if (unretainedDecode || DECODING_REQUESTS.has(req.type)) releaseRetainedCpu();
}
