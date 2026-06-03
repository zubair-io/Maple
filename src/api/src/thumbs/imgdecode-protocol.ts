/**
 * Wire protocol shared by the imgdecode child process (`imgdecode.child.ts`)
 * and its pool manager (`imgdecode-pool.ts`).
 *
 * Only small values cross the IPC boundary: a request carries paths + ints;
 * a response carries `ok`/`error`. The heavy buffers (decoded input, resized
 * JPEG) stay inside the child — the child writes the JPEG straight to `outPath`
 * on disk and never ships pixel data over IPC.
 */

/** Render a non-RAW image to a resized JPEG file on disk. */
export interface ImgRenderRequest {
  type: 'render';
  id: number;
  srcPath: string;
  outPath: string;
  maxPx: number;
  quality: number;
  /** Lowercase extension without leading dot (e.g. "jpeg", "heic", "png"). */
  ext: string;
}

export type ImgDecodeRequest = ImgRenderRequest;

export interface ImgRenderResponse {
  type: 'render';
  id: number;
  ok: boolean;
  error?: string;
}

export type ImgDecodeResponse = ImgRenderResponse;
