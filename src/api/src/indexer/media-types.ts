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

/** Stable coarse media class used by the Maple-owned asset-search contract. */
/** Coarse media class of an asset, denormalised onto `AssetDoc.media_kind`
 * (#3492) so video/audio-scoped stages and migrations can claim and count by
 * an indexed equality instead of a filename regex that no multikey index can
 * filter. Derived from the primary filename's extension. */
export type MediaKind = 'image' | 'video' | 'audio';

export function classifyMediaType(filename: string): MediaKind {
  if (isVideoFilename(filename)) return 'video';
  if (isAudioFilename(filename)) return 'audio';
  return 'image';
}

/** `media_kind` for an asset with several locations: `video` if ANY is a
 * video file (a Live Photo backup pairs `still.HEIC` with `clip.MOV` on one
 * row), else `audio` if any is audio, else `image`. Pipeline twin:
 * `mediaKindExpression` in `db/media-kind.ts`. */
export function mediaKindOfFilenames(filenames: readonly string[]): MediaKind {
  const kinds = new Set(filenames.map(classifyMediaType));
  return kinds.has('video') ? 'video' : kinds.has('audio') ? 'audio' : 'image';
}

/**
 * True when `filename` is a format for which NO still frame can ever be
 * produced — a stub image (no decoder exists) or audio (no visual content at
 * all). This is the single place that defines "give up on this asset's
 * thumbnail/preview/describe/face pass," so every stage and route guard should
 * consult this rather than composing the checks itself.
 *
 * Video is deliberately NOT in this set (#1649). Video containers hold real
 * frames; whether Maple can extract one is a host-capability question — is
 * there a runnable `ffmpeg`? — not a property of the format. Answering it
 * requires spawning a process, so it can't live in this synchronous
 * filename-only predicate. Callers that need it ask
 * `ffmpegBinary()` / `extractVideoPosterJpeg()` in `thumbs/video-poster.ts`.
 *
 * Named `isUndecodable…` rather than the older `isNoPreviewFilename` precisely
 * so that video's departure from the set is a compile error at every call
 * site rather than a silent behaviour change: each one had to decide whether
 * it meant "no frame exists" (this predicate) or "no frame exists *yet*" (the
 * ffmpeg capability check).
 */
export function isUndecodableFilename(filename: string): boolean {
  return isStubImageFilename(filename) || isAudioFilename(filename);
}

// ---------------------------------------------------------------------------
// Per-format extension allowlists (lowercase, NO leading dot — the shape the
// `/api/fs` browse listing and the thumb/preview renderers key on). Moved
// here from `fs/browse.ts` (#1988) so the renderers can import them from a
// leaf module: `fs/browse.ts` lazily imports `workers/discover`, which
// reaches `indexer/thumbnailer.ts` / `indexer/previewer.ts` through the
// stage manifest, and those importing `fs/browse.ts` back closed a 4-cycle.
// `fs/browse.ts` re-exports every set below for its existing importers.
// ---------------------------------------------------------------------------

/** RAW file extensions handled by the libraw FFI pipeline (lowercase, no dot).
 * Used by `/api/fs/raw` (byte stream into WASM decode) and the thumb endpoint
 * to choose between the libraw FFI and the sharp/heic-convert path. */
export const RAW_EXTENSIONS = new Set<string>([
  'cr2',
  'cr3',
  'nef',
  'arw',
  'dng',
  'raf',
  'orf',
  'rw2',
  'pef',
  'srw',
  'x3f',
  '3fr',
  'mef',
  'erf',
  'mrw',
  'raw',
  'fff',
]);

/** Non-RAW bitmap extensions decoded via sharp / heic-convert (lowercase, no
 * dot). Lives here next to RAW_EXTENSIONS so the lightweight allowlist can be
 * imported without pulling in the thumbnail renderer (and its `sharp` /
 * `heic-convert` deps). `thumbs/render.ts` re-exports it for back-compat. */
export const SHARP_EXTENSIONS = new Set<string>([
  'jpg',
  'jpeg',
  'png',
  'webp',
  'gif',
  'tif',
  'tiff',
  'heic',
  'heif',
  'avif',
]);

/** Photoshop PSD/PSB and Radiance HDR (lowercase, no dot). Not RAW (no
 * libraw FFI support) and not sharp-native (sharp can't decode these bytes
 * on its own) — they get a first-pass decode via `ag-psd` / `hdr` into a
 * flattened RGBA8 raster before sharp resizes + JPEG-encodes it. See
 * `thumbs/psd-hdr-decode.ts`. Kept as its own set, parallel to
 * `SHARP_EXTENSIONS`, rather than folded into it, since sharp cannot open
 * these formats without that decode step. */
export const PSD_HDR_EXTENSIONS = new Set<string>(['psd', 'psb', 'hdr']);

/** Strip the leading dot off a dotted extension set, yielding the no-dot
 * shape the browse listing keys on. Derived rather than re-listed so the
 * dotted (`isStubImageFilename` / `isAudioFilename`) and no-dot forms can
 * never disagree on which formats are stubs. */
function withoutLeadingDot(exts: ReadonlySet<string>): Set<string> {
  return new Set([...exts].map((ext) => ext.slice(1)));
}

/** `STUB_IMAGE_EXTS` in no-dot form (see #1835): metadata-only stubs —
 * indexed for filename/size/date, never thumbnailed/decoded. */
export const STUB_IMAGE_EXTENSIONS = withoutLeadingDot(STUB_IMAGE_EXTS);

/** `AUDIO_EXTS` in no-dot form (see #1835): metadata-only stubs, same as
 * `STUB_IMAGE_EXTENSIONS`. */
export const AUDIO_EXTENSIONS = withoutLeadingDot(AUDIO_EXTS);

/** `^.*\.(mov|mp4|…)$` source for one extension set — case-insensitivity is
 * applied by the caller (`$regexMatch` `options: 'i'`). */
function extensionRegexSource(exts: ReadonlySet<string>): string {
  return `\\.(${[...exts].map((e) => e.slice(1)).join('|')})$`;
}

/** Aggregation expression computing `media_kind` from the `fileinfo`
 * filenames — the pipeline twin of `mediaKindOfFilenames`. An asset is a
 * `video` when ANY of its locations is a video file (a Live Photo backup
 * carries `still.HEIC` + `clip.MOV` on one row, and the video-scoped stages
 * and migrations must still see it), else `audio` when any is audio, else
 * `image`. */
export function mediaKindExpression(): Record<string, unknown> {
  const anyMatches = (exts: ReadonlySet<string>) => ({
    $anyElementTrue: {
      $map: {
        input: { $ifNull: ['$fileinfo.filename', []] },
        as: 'f',
        in: {
          $regexMatch: {
            input: { $ifNull: ['$$f', ''] },
            regex: extensionRegexSource(exts),
            options: 'i',
          },
        },
      },
    },
  });
  return {
    $cond: [anyMatches(VIDEO_EXTS), 'video', { $cond: [anyMatches(AUDIO_EXTS), 'audio', 'image'] }],
  };
}
