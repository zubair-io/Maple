// Message protocol for the dedicated embedded-RAW-preview-extraction Web
// Worker (#2010). Mirrors `addressing/maple-id-fallback.types.ts`'s shape —
// a plain request/response pair keyed by a caller-assigned numeric `id`, so
// the service can dispatch concurrent extractions against one worker.

/** Request: extract `raw`'s embedded preview, downsample to `maxLongEdge`
 * on the long edge, JPEG-encode at `quality` (0 = the WASM binding's own
 * default). `raw` is a transferred `ArrayBuffer` — the worker never copies
 * it beyond what `Uint8Array` wrapping requires. */
export interface ExtractPreviewRequest {
  id: number;
  type: 'extract-preview';
  raw: ArrayBuffer;
  ext: string;
  maxLongEdge: number;
  quality: number;
}

export interface ExtractPreviewSuccess {
  id: number;
  type: 'extract-preview-success';
  width: number;
  height: number;
  /** JPEG bytes, transferred back (not copied) to the main thread. */
  jpeg: ArrayBuffer;
}

export interface ExtractPreviewError {
  id: number;
  type: 'extract-preview-error';
  message: string;
}

export type ExtractPreviewResponse = ExtractPreviewSuccess | ExtractPreviewError;
