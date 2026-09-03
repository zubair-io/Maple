// Neutral white-balance sampler (#2434) — worker request/response shapes.
// Split from `raw-pipeline.types.ts` (at its file budget); that file's
// `WorkerRequest` / `WorkerResponse` unions reference these.

/** Main thread → worker: sample the neutral at a normalised image point. */
export interface SampleWbRequest {
  id: number;
  type: 'sample-wb';
  bytes: ArrayBuffer;
  ext: string;
  xmp?: string;
  /** Normalised image-relative point, `(0, 0)` top-left → `(1, 1)` bottom-right. */
  nx: number;
  ny: number;
}

/** The slider pair that renders the sampled surface neutral, plus the
 *  derivation's version (`raw_core::stages::white_balance_sample::WB_ALGORITHM_VERSION`). */
export interface WbSampleResult {
  temperature: number;
  tint: number;
  algorithmVersion: number;
}

/** Why a click could not become a white balance — mirrors `WbSampleError`
 *  in raw-core; the WASM entry prefixes its message with this kind. */
export type WbSampleErrorKind =
  | 'outside_image'
  | 'clipped'
  | 'too_dark'
  | 'out_of_domain'
  | 'develop';

export interface SampleWbSuccess {
  id: number;
  type: 'sample-wb-success';
  sample: WbSampleResult;
}

export interface SampleWbError {
  id: number;
  type: 'sample-wb-error';
  kind: WbSampleErrorKind;
  message: string;
}

const KINDS: readonly WbSampleErrorKind[] = [
  'outside_image',
  'clipped',
  'too_dark',
  'out_of_domain',
  'develop',
];

/** Split the WASM sampler's `"<kind>: <message>"` error into its parts;
 *  anything unrecognised is a `develop` failure. */
export function parseWbSampleError(raw: string): { kind: WbSampleErrorKind; message: string } {
  const idx = raw.indexOf(': ');
  const head = idx > 0 ? raw.slice(0, idx) : '';
  const kind = KINDS.find((k) => k === head);
  return kind ? { kind, message: raw.slice(idx + 2) } : { kind: 'develop', message: raw };
}

/** Error thrown to `RawPipelineService.sampleWhiteBalance` callers — carries
 *  the kind so the UI can phrase an actionable message. */
export class WbSampleRejected extends Error {
  constructor(
    readonly kind: WbSampleErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'WbSampleRejected';
  }
}
