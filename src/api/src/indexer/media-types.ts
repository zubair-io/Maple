/**
 * Media-type classification shared across the indexer + enrichment stages.
 *
 * The single source of truth for "is this asset a video container?". Lives
 * here (not inlined in each stage) so the describe stage, the preview stage,
 * and the EXIF stage all agree on the extension list and can't drift —
 * adding a new container in one place must not leave another shipping the
 * raw bytes to a VLM.
 *
 * Why this matters: assets can enter the library carrying a non-still
 * extension (the backup-ingest route has no extension allowlist, and a
 * library root may hold mixed media). A video has no frame for the
 * still-image enrichment chain to caption, and handing its bytes to the
 * vision model wastes an inference slot at best and OOMs / 500s the Ollama
 * server at worst. Stages consult `isVideoFilename` and skip.
 */

import * as path from 'node:path';

/**
 * Video container extensions (lowercase, leading dot). Mirrors the video
 * bucket of `NO_EXIF_EXTS` in `exif.ts`, which composes its set from this
 * one so the two never drift.
 */
export const VIDEO_EXTS: ReadonlySet<string> = new Set([
  '.mov',
  '.mp4',
  '.m4v',
  '.avi',
  '.mkv',
  '.webm',
  '.mts',
  '.m2ts',
  '.3gp',
  '.mxf',
  '.3g2',
  '.flv',
  '.vob',
  '.mpg',
  '.wmv',
  '.f4v',
]);

/**
 * True when `filename` (or any path ending in one) is a recognised video
 * container. Case-insensitive on the extension — `IMG_3087.MOV` and
 * `clip.mov` both match.
 */
export function isVideoFilename(filename: string): boolean {
  return VIDEO_EXTS.has(path.extname(filename).toLowerCase());
}
