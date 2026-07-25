/**
 * Wire protocol shared by the imgdecode child process (`imgdecode.child.ts`)
 * and its pool manager (`imgdecode-pool.ts`).
 *
 * Only small values cross the IPC boundary: a request carries paths + ints;
 * a response carries `ok`/`error`. The heavy buffers (decoded input, resized
 * output) stay inside the child — the child writes the image straight to
 * `outPath` on disk and never ships pixel data over IPC.
 */

/** Render a non-RAW image to a resized image file on disk. */
export interface ImgRenderRequest {
  type: 'render';
  id: number;
  srcPath: string;
  outPath: string;
  maxPx: number;
  quality: number;
  /** Lowercase extension without leading dot (e.g. "jpeg", "heic", "png"). */
  ext: string;
  /** Output codec. Defaults to `'avif'` (the 256px grid-thumbnail tier) when
   * omitted; the 1280px VLM describe/OCR preview tier (`previewer.ts`)
   * passes `'jpeg'` since every describe provider hardcodes `image/jpeg` as
   * the media type it sends upstream. */
  format?: 'avif' | 'jpeg';
}

/** Decode `filePath` in full (format/dimensions/orientation/colourspace +
 * a full pixel decode) and report whether it's a genuine, complete AVIF
 * matching this pipeline's encode conventions. See `thumbs/avif-checks.ts`
 * for the actual check semantics — this request just carries the two
 * parameters that predicate needs across the IPC boundary (#2257: the
 * validation decode used to run inline in the API parent process). */
export interface ImgValidateRequest {
  type: 'validate';
  id: number;
  filePath: string;
  expectedLongEdgePx: number;
}

export type ImgDecodeRequest = ImgRenderRequest | ImgValidateRequest;

export interface ImgRenderResponse {
  type: 'render';
  id: number;
  ok: boolean;
  error?: string;
}

export interface ImgValidateResponse {
  type: 'validate';
  id: number;
  ok: boolean;
  reason?: string;
}

export type ImgDecodeResponse = ImgRenderResponse | ImgValidateResponse;

/**
 * Narrow an IPC payload to a genuine `ImgDecodeRequest`.
 *
 * Lives here, with the wire format it validates, rather than in the child: it is
 * pure and side-effect-free, so it is directly testable without importing the
 * child (which registers a `process.on('message')` listener and loads sharp).
 *
 * Checks `type` against the known variants rather than trusting any object. An
 * unrecognised or absent `type` must be IGNORED, not fall through to whichever
 * dispatch branch happens to be last — before this was explicit, a malformed
 * message reached the validate path and attempted a decode with undefined
 * fields, producing noisy failures and real work for a request nobody made.
 */
export function coerceRequest(raw: unknown): ImgDecodeRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const type = (raw as { type?: unknown }).type;
  if (type !== 'render' && type !== 'validate') return null;
  return raw as ImgDecodeRequest;
}
