import { parseSampleError } from './raw-pipeline.sample-error';

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
  return parseSampleError(raw, KINDS, 'develop');
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

/** Main thread → worker: sample the Stage 22b Oklab color curve input (#5041). */
export interface SampleColorCurveRequest {
  id: number;
  type: 'sample-color-curve';
  bytes: ArrayBuffer;
  ext: string;
  xmp?: string;
  nx: number;
  ny: number;
}

export interface ColorCurveSampleResult {
  uH: number;
  uC: number;
  uL: number;
  l: number;
  c: number;
  hueDeg: number;
}

export interface SampleColorCurveSuccess {
  id: number;
  type: 'sample-color-curve-success';
  sample: ColorCurveSampleResult;
}

export interface SampleColorCurveError {
  id: number;
  type: 'sample-color-curve-error';
  kind: RangeSampleErrorKind;
  message: string;
}

export class ColorCurveSampleRejected extends Error {
  constructor(
    readonly kind: RangeSampleErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'ColorCurveSampleRejected';
  }
}
