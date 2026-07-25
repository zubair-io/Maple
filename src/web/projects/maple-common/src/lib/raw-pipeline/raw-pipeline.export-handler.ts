/// <reference lib="webworker" />
// Worker-side edited-image export (#943).
//
// Lives in its own file rather than in `raw-pipeline.worker.ts` to keep that
// file inside the size budget.

import { export_bytes } from './pkg/raw_wasm';
import type { ExportError, ExportRequest, ExportSuccess } from './raw-pipeline.types';

/**
 * How much of the encoded file to copy out of the WASM heap at a time.
 *
 * The whole point of chunking is that neither side ever holds a second copy of
 * a large file: the encoded bytes live in the WASM heap, each slice is copied
 * into a short-lived `Uint8Array`, and the `Blob` constructor moves it into
 * browser-managed storage that can spill to disk. 8 MiB is large enough that a
 * ~600 MB 16-bit TIFF costs a manageable number of round trips and small
 * enough that peak JS-heap occupancy stays negligible.
 */
const CHUNK_BYTES = 8 * 1024 * 1024;

/** Convert the wasm-side `max_long_edge` sentinel: 0 means native resolution. */
function longEdgeCap(maxSidePixels: number | undefined): number {
  return maxSidePixels && maxSidePixels > 0 ? Math.floor(maxSidePixels) : 0;
}

/**
 * Render + encode an export, then reply with the file as a `Blob`.
 *
 * The WASM handle is freed in a `finally` so a mid-drain failure can't strand
 * hundreds of megabytes in the WASM heap for the life of the worker.
 */
export async function handleExport(req: ExportRequest): Promise<void> {
  const { options } = req;
  try {
    const handle = export_bytes(
      new Uint8Array(req.bytes),
      req.ext,
      req.xmp,
      options.format,
      options.quality,
      options.colorSpace,
      longEdgeCap(options.maxSidePixels),
    );

    try {
      const total = handle.byteLength;
      const parts: BlobPart[] = [];
      for (let offset = 0; offset < total; offset += CHUNK_BYTES) {
        parts.push(handle.chunk(offset, CHUNK_BYTES));
      }
      const response: ExportSuccess = {
        id: req.id,
        type: 'export-success',
        width: handle.width,
        height: handle.height,
        extension: handle.extension,
        blob: new Blob(parts, { type: handle.mimeType }),
      };
      postMessage(response);
    } finally {
      handle.free();
    }
  } catch (err) {
    const response: ExportError = {
      id: req.id,
      type: 'export-error',
      message: err instanceof Error ? err.message : String(err),
    };
    postMessage(response);
  }
}
