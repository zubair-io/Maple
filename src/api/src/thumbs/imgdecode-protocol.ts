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

export type ImgDecodeRequest = ImgRenderRequest;

export interface ImgRenderResponse {
  type: 'render';
  id: number;
  ok: boolean;
  error?: string;
}

export type ImgDecodeResponse = ImgRenderResponse;
