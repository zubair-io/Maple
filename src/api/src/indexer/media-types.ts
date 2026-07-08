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

/**
 * Image-like formats with no realistic decode path today (see epic #1831 /
 * ticket #1835): eip (Phase One — no rawler support), braw (Blackmagic RAW —
 * proprietary SDK-gated, no open decoder), afphoto (Affinity Photo — no
 * public spec), ai (Illustrator — a PDF/vector container, not a raster
 * image). These are indexer-eligible metadata-only stubs: filename/size/date
 * are indexed, but there is no thumbnail, preview, EXIF, or describe/face
 * work to attempt.
 */
export const STUB_IMAGE_EXTS: ReadonlySet<string> = new Set(['.eip', '.braw', '.afphoto', '.ai']);

/**
 * True when `filename` is a recognised no-decoder-available stub image
 * format. Case-insensitive on the extension.
 */
export function isStubImageFilename(filename: string): boolean {
  return STUB_IMAGE_EXTS.has(path.extname(filename).toLowerCase());
}

/**
 * Audio formats — a wholly new asset category for Maple (see epic #1831 /
 * ticket #1835). Indexed as metadata-only stubs: no thumbnail, no
 * EXIF/preview/describe/face work, but visible in search/library listings
 * with filename/size/date.
 */
export const AUDIO_EXTS: ReadonlySet<string> = new Set(['.mp3', '.wav', '.m4a', '.aac']);

/**
 * True when `filename` is a recognised audio format. Case-insensitive on the
 * extension.
 */
export function isAudioFilename(filename: string): boolean {
  return AUDIO_EXTS.has(path.extname(filename).toLowerCase());
}

/**
 * True when `filename` is any format that gets no real preview attempt at
 * all — video, stub image, or audio. This is the single place that defines
 * "does this asset get a real thumbnail/preview/EXIF/describe/face pass," so
 * every stage and route guard should consult this rather than composing the
 * three checks itself.
 */
export function isNoPreviewFilename(filename: string): boolean {
  return isVideoFilename(filename) || isStubImageFilename(filename) || isAudioFilename(filename);
}
