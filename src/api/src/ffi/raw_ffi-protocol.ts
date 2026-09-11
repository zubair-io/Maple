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
import type { LensProfileInventory } from '../lens-profiles/types.ts';

export interface RegisterLensProfileRequest {
  type: 'registerLensProfile';
  id: number;
  profilePath: string;
}

export interface RegisterLensProfileResponse {
  type: 'registerLensProfile';
  id: number;
  ok: boolean;
  inventory?: LensProfileInventory;
  error?: string;
}

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

export interface ExportRecipeRequest {
  type: 'exportRecipe';
  id: number;
  rawPath: string;
  xmp: string;
  recipeJson: string;
  filmPath: string | null;
  outPath: string;
}
export interface AsShotRequest {
  type: 'asShot';
  id: number;
  rawPath: string;
}
export interface AsShotResponse {
  type: 'asShot';
  id: number;
  ok: boolean;
  baseline?: { temperature: number; tint: number };
  error?: string;
}

export type FfiRequest =
  | AsShotRequest
  | ExportRecipeRequest
  | RegisterLensProfileRequest
  | RenderThumbRequest
  | HistogramRequest
  | RenderDevelopRequest
  | RenderPreviewJpegRequest;

/** Every `type` the child dispatches. Kept as a value (not just the union)
 *  so the wire guard below can check an incoming payload against it. */
export const FFI_REQUEST_TYPES = [
  'asShot',
  'exportRecipe',
  'registerLensProfile',
  'renderThumb',
  'histogram',
  'renderDevelop',
  'renderPreviewJpeg',
] as const satisfies readonly FfiRequest['type'][];

/**
 * Wire-format guard the child applies to every IPC message before dispatch.
 * Returns the payload typed as `FfiRequest` when it is an object carrying a
 * known `type` and a numeric `id`, else null. The child's dispatch is a chain
 * of `if` arms, and without this guard a payload of any other shape used to
 * fall through to whichever arm came last (the histogram renderer) and be
 * answered with that arm's `type` — which the pool's caller then ignored,
 * hanging its promise. Field-level validation stays with each arm; this only
 * guarantees the arm is the one the sender asked for.
 */
export function coerceFfiRequest(raw: unknown): FfiRequest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { type, id } = raw as { type?: unknown; id?: unknown };
  const known = (FFI_REQUEST_TYPES as readonly unknown[]).includes(type);
  return known && typeof id === 'number' && Number.isFinite(id) ? (raw as FfiRequest) : null;
}

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
  | { type: 'exportRecipe'; id: number; ok: boolean; error?: string }
  | AsShotResponse
  | RegisterLensProfileResponse
  | RenderThumbResponse
  | HistogramResponse
  | RenderDevelopResponse
  | RenderPreviewJpegResponse;

/** Reply to a request the child could not dispatch: the (unrecognised) `type`
 *  is echoed so the pool can name it when it rejects the caller. Deliberately
 *  NOT a member of `FfiResponse` — a `string` discriminant there would stop
 *  the pool's per-type narrowing. */
export interface FfiRejectedResponse {
  type: string;
  id: number;
  ok: false;
  error: string;
}

/** The reply for a payload `coerceFfiRequest` rejected: echoes its `type`
 *  under its `id` so the pool rejects exactly that caller. Null when the
 *  payload carries no numeric `id` — there is then nobody to answer. */
export function rejectedFfiReply(raw: unknown): FfiRejectedResponse | null {
  const { type, id } = (raw && typeof raw === 'object' ? raw : {}) as {
    type?: unknown;
    id?: unknown;
  };
  if (typeof id !== 'number') return null;
  return { type: String(type), id, ok: false, error: `unknown request type '${String(type)}'` };
}
