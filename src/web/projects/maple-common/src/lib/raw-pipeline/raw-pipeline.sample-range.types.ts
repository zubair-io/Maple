// Mask colour-range eyedropper (#362) — worker request/response shapes.
// Sibling of `raw-pipeline.sample-wb.types.ts`, same split reason: the
// `WorkerRequest` / `WorkerResponse` unions live in a file already at its
// size budget, so each sampler's shapes live next to it instead.

/** Main thread → worker: sample the colour at a normalised image point. */
export interface SampleRangeRequest {
  id: number;
  type: 'sample-range';
  bytes: ArrayBuffer;
  ext: string;
  xmp?: string;
  /** Normalised image-relative point, `(0, 0)` top-left → `(1, 1)` bottom-right. */
  nx: number;
  ny: number;
}

/**
 * The four `papp:Range*` coordinates a pick seeds — the band centre, the
 * chroma floor and the lightness window, placed so the sampled colour reads
 * weight 1 (`raw_core::stages::mask_range_sample::RangeSeed`). The band
 * width and feather are the user's own settings and are never sampled.
 */
export interface MaskRangeSeed {
  hueDeg: number;
  chromaMin: number;
  lMin: number;
  lMax: number;
}

/** Why a click could not become a colour range — mirrors `RangeSampleError`
 *  in raw-core; the WASM entry prefixes its message with this kind. */
export type RangeSampleErrorKind = 'outside_image' | 'neutral' | 'too_dark' | 'develop';

export interface SampleRangeSuccess {
  id: number;
  type: 'sample-range-success';
  seed: MaskRangeSeed;
}

export interface SampleRangeError {
  id: number;
  type: 'sample-range-error';
  kind: RangeSampleErrorKind;
  message: string;
}

const KINDS: readonly RangeSampleErrorKind[] = ['outside_image', 'neutral', 'too_dark', 'develop'];

/** Split the WASM sampler's `"<kind>: <message>"` error into its parts;
 *  anything unrecognised is a `develop` failure. */
export function parseRangeSampleError(raw: string): {
  kind: RangeSampleErrorKind;
  message: string;
} {
  const idx = raw.indexOf(': ');
  const head = idx > 0 ? raw.slice(0, idx) : '';
  const kind = KINDS.find((k) => k === head);
  return kind ? { kind, message: raw.slice(idx + 2) } : { kind: 'develop', message: raw };
}

/** Error thrown to `RawPipelineService.sampleMaskRange` callers — carries
 *  the kind so the UI can phrase an actionable message. */
export class RangeSampleRejected extends Error {
  constructor(
    readonly kind: RangeSampleErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'RangeSampleRejected';
  }
}
