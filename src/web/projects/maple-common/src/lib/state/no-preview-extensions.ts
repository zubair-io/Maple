// No-preview extension detection — the single source of truth for which file
// extensions never get a real thumbnail/preview, so the grid can show a
// generic "no preview available" badge instead of a blank gradient tile.
//
// Mirrors the server-side classification in
// `src/api/src/indexer/media-types.ts` (VIDEO_EXTS / STUB_IMAGE_EXTS /
// AUDIO_EXTS, ticket #1835 / epic #1831), but kept as an independent,
// dependency-free copy here — same rationale as `raw-extensions.ts`: any
// layer (in particular `asset-thumb.component`) should be able to import
// this without pulling in a service graph, and the web client has no
// business importing server-side indexer modules across the process
// boundary. Keep the three sets in sync with `media-types.ts` by hand when
// either side adds a new no-preview extension.

/** Video container extensions (lowercase, no dot). Client-side video
 * detection is computed from the filename rather than `Asset.isVideo` —
 * that field is only populated in Self-Hosted fs-walk browse mode, not the
 * content-addressed Hosted library path, so a filename-based check is the
 * one that works uniformly across both. */
const VIDEO_EXTENSIONS = new Set([
  'mov',
  'mp4',
  'm4v',
  'avi',
  'mkv',
  'webm',
  'mts',
  'm2ts',
  '3gp',
  'mxf',
  '3g2',
  'flv',
  'vob',
  'mpg',
  'wmv',
  'f4v',
]);

/** Image-like formats with no realistic decode path (Phase One EIP,
 * Blackmagic RAW, Affinity Photo, Illustrator). Indexed as metadata-only
 * stubs — filename/size/date show up in the grid, but there's never a
 * thumbnail to load. */
const STUB_IMAGE_EXTENSIONS = new Set(['eip', 'braw', 'afphoto', 'ai']);

/** Audio formats. Indexed as metadata-only stubs alongside the stub image
 * formats — same "never a thumbnail" story. */
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'aac']);

/**
 * Returns the uppercased extension (no dot) when `filename` is a recognised
 * no-preview format (video, stub image, or audio) — for rendering a
 * generic text-pill badge in the grid tile. Returns `null` for anything
 * else (including normal photos still mid-load), so the caller can
 * distinguish "no preview will ever exist" from "thumbnail hasn't loaded
 * yet."
 */
export function noPreviewBadgeLabel(filename: string): string | null {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const isNoPreview =
    VIDEO_EXTENSIONS.has(ext) || STUB_IMAGE_EXTENSIONS.has(ext) || AUDIO_EXTENSIONS.has(ext);
  return isNoPreview ? ext.toUpperCase() : null;
}
