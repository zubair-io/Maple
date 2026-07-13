/**
 * Wire protocol shared by the FFI decode child process (`raw_ffi.child.ts`)
 * and its pool manager (`ffi-pool.ts`).
 *
 * Kept in its own module so both sides import the same request/response shapes
 * and can't drift, and so the child entry doesn't have to import the pool (which
 * would pull the `Bun.spawn`-ing manager into the child).
 *
 * Only small values cross the IPC boundary: a request carries paths + ints; a
 * response carries `ok`/`error` (renderThumb/renderPreviewJpeg/renderDevelop
 * write straight to disk inside the child) or the 3×256 histogram bins
 * (~3 KB). The heavy buffers (the decoded RGB plane, the rendered image)
 * never leave the child.
 */

import type { HistogramBins } from '../thumbs/histogram.ts';

/** Render a RAW's embedded preview to a JPEG file on disk (`_to_file` path). */
export interface RenderThumbRequest {
  type: 'renderThumb';
  id: number;
  rawPath: string;
  outPath: string;
  maxPx: number;
  quality: number;
}

/** Render a RAW+XMP and bin the result into a 3×256 RGB histogram (in Rust). */
export interface HistogramRequest {
  type: 'histogram';
  id: number;
  rawPath: string;
  /** Optional XMP sidecar path — applied to the render so a re-edit
   *  invalidates the histogram. Null = default adjustments. */
  xmpPath: string | null;
}

/** Develop a RAW with its XMP applied and write the JPEG to disk (#1950). The
 *  DEVELOPED counterpart to `renderThumb` (which extracts the embedded preview
 *  and applies no adjustments). `xmpPath` null → neutral develop. */
export interface RenderDevelopRequest {
  type: 'renderDevelop';
  id: number;
  rawPath: string;
  xmpPath: string | null;
  outPath: string;
  maxPx: number;
  quality: number;
}

/** Render a RAW's embedded preview to a JPEG file on disk — the 1280px VLM
 *  describe/OCR preview tier (`indexer/previewer.ts`). The JPEG counterpart
 *  to `renderThumb` (which is AVIF, for the 256px grid-thumbnail tier):
 *  every describe provider hardcodes `image/jpeg` as the media type it
 *  sends upstream, so this tier must keep emitting real JPEG bytes
 *  regardless of the grid-thumbnail format. */
export interface RenderPreviewJpegRequest {
  type: 'renderPreviewJpeg';
  id: number;
  rawPath: string;
  outPath: string;
  maxPx: number;
  quality: number;
}

export type FfiRequest =
  | RenderThumbRequest
  | HistogramRequest
  | RenderDevelopRequest
  | RenderPreviewJpegRequest;

export interface RenderThumbResponse {
  type: 'renderThumb';
  id: number;
  ok: boolean;
  error?: string;
}

export interface HistogramResponse {
  type: 'histogram';
  id: number;
  ok: boolean;
  bins?: HistogramBins;
  error?: string;
}

export interface RenderDevelopResponse {
  type: 'renderDevelop';
  id: number;
  ok: boolean;
  error?: string;
}

export interface RenderPreviewJpegResponse {
  type: 'renderPreviewJpeg';
  id: number;
  ok: boolean;
  error?: string;
}

export type FfiResponse =
  | RenderThumbResponse
  | HistogramResponse
  | RenderDevelopResponse
  | RenderPreviewJpegResponse;
