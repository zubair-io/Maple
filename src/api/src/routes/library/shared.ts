/**
 * Shared utilities for the M1 library routes.
 */

import { stat } from 'node:fs/promises';
import type { Context } from 'elysia';
import {
  RAW_EXTENSIONS,
  SHARP_EXTENSIONS,
  PSD_HDR_EXTENSIONS,
  STUB_IMAGE_EXTENSIONS,
  AUDIO_EXTENSIONS,
} from '../../fs/browse.ts';

/** Union of all image extensions surfaced by library routes. */
export const IMAGE_EXTENSIONS_SET = new Set<string>([
  ...RAW_EXTENSIONS,
  ...SHARP_EXTENSIONS,
  ...PSD_HDR_EXTENSIONS,
]);

/** Union of the #1835 metadata-only formats (stub images with no decoder,
 * plus audio) — surfaced in folder/image listings and streamable via
 * `/api/image/:slug/*` (original-bytes passthrough), but deliberately kept
 * out of `IMAGE_EXTENSIONS_SET`: that set gates routes that assume
 * *decodable raster bytes* (see `library/image.ts`'s 415 check), and none of
 * these formats are decodable. */
export const STUB_AND_AUDIO_EXTENSIONS_SET = new Set<string>([
  ...STUB_IMAGE_EXTENSIONS,
  ...AUDIO_EXTENSIONS,
]);

/** Map of lowercase extension → MIME type for Content-Type headers. */
const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic',
  heif: 'image/heif',
  cr2: 'image/x-canon-cr2',
  cr3: 'image/x-canon-cr3',
  nef: 'image/x-nikon-nef',
  arw: 'image/x-sony-arw',
  dng: 'image/dng',
  raf: 'image/x-fuji-raf',
  orf: 'image/x-olympus-orf',
  rw2: 'image/x-panasonic-rw2',
  pef: 'image/x-pentax-pef',
  srw: 'image/x-samsung-srw',
  x3f: 'image/x-sigma-x3f',
  '3fr': 'image/x-hasselblad-3fr',
  mef: 'image/x-mamiya-mef',
  erf: 'image/x-epson-erf',
  mrw: 'image/x-minolta-mrw',
  fff: 'image/x-hasselblad-fff',
  avif: 'image/avif',
  psd: 'image/vnd.adobe.photoshop',
  // No registered PSB-specific MIME type exists; PSB is Photoshop's own
  // "Large Document Format" variant of the same 8BPS container, so reuse
  // the PSD type rather than falling back to application/octet-stream.
  psb: 'image/vnd.adobe.photoshop',
  hdr: 'image/vnd.radiance',
  // Audio (#1835) — IANA-registered types.
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  mts: 'video/mp2t',
  m2ts: 'video/mp2t',
  '3gp': 'video/3gpp',
  mxf: 'application/mxf',
  '3g2': 'video/3gpp2',
  flv: 'video/x-flv',
  vob: 'video/mpeg',
  mpg: 'video/mpeg',
  wmv: 'video/x-ms-wmv',
  f4v: 'video/mp4',
  // Metadata-only stub images (#1835) — no registered MIME exists for
  // eip/braw/afphoto; fall back to the generic binary type. `ai` files are
  // normally a PDF/vector container (Illustrator), so `application/postscript`
  // is the closest IANA-registered type rather than octet-stream.
  eip: 'application/octet-stream',
  braw: 'application/octet-stream',
  afphoto: 'application/octet-stream',
  ai: 'application/postscript',
};

export function mimeForExt(ext: string): string {
  return MIME_BY_EXT[ext.toLowerCase()] ?? 'application/octet-stream';
}

/** Immutable cache control for content-keyed responses. */
export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

/**
 * Cache control for the preview tier (#2017). The preview is a pure cache
 * overwritten in place at a stable URL — never content-keyed — so it must NOT
 * be `immutable`; a client that cached it forever would never pick up an edit.
 * `must-revalidate` with `max-age=0` forces a conditional request every time,
 * which the ETag (preview file mtime/size) answers with a cheap 304 when
 * unchanged and fresh bytes immediately after the editor overwrites the file.
 * `private` because previews are per-library user content behind auth.
 */
export const MUTABLE_PREVIEW_CACHE = 'private, max-age=0, must-revalidate';

/**
 * Strong ETag for a preview file: its full-precision mtime + size. An in-place
 * overwrite by the editor changes the bytes (and thus the size and/or the
 * mtime), so the validator busts automatically — no version token in the URL
 * required. Deliberately NOT floored to whole milliseconds (unlike the
 * source-file `sourceETag`): the preview is overwritten in place, so two rapid
 * re-saves of the same byte-size within one millisecond would collide under a
 * floored mtime and wrongly serve a 304 with stale bytes; the sub-ms `mtimeMs`
 * fraction distinguishes them. `Number(...)` normalizes the `BigIntStats`
 * union `stat` can return.
 */
export function previewFileETag(st: Awaited<ReturnType<typeof stat>>): string {
  return `"${Number(st.mtimeMs)}-${Number(st.size)}"`;
}

/**
 * Safe stat — returns null on any error.
 */
export async function safeStat(p: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(p);
  } catch {
    return null;
  }
}

/**
 * Safe file read as a Uint8Array — returns null on any error.
 */
export async function safeReadBytes(p: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await Bun.file(p).arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Read `cachePath`'s bytes and return the standard immutable-cached 200
 * Response, or set a 404 and return the error body. Shared tail of the
 * preview and thumb on-demand routes — once a generated derivative is on
 * disk, both serve it identically (only the `Content-Type` and the
 * not-found message differ). Takes `set` directly (rather than returning a
 * discriminated result for the caller to unwrap) so each call site is a
 * single `return`, not a repeated unwrap-and-forward.
 */
export async function serveCachedBytesOr404(
  set: Context['set'],
  cachePath: string,
  contentType: string,
  etag: string,
  notFoundMessage: string,
  cacheControl: string = IMMUTABLE_CACHE,
): Promise<Response | { error: string }> {
  const bytes = await safeReadBytes(cachePath);
  if (!bytes) {
    set.status = 404;
    return { error: notFoundMessage };
  }
  return new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      ETag: etag,
      'Cache-Control': cacheControl,
    },
  });
}

/**
 * Stream a file as a Response. Returns null if the file cannot be read.
 *
 * The body is a `BunFile` so `Bun.serve` takes its zero-copy file-send path.
 * The previous `Readable.toWeb(createReadStream(...))` bridge delivered bytes
 * with several ms of per-chunk latency that, under HTTP/2 per-stream flow
 * control, capped a single download near ~5–11 MB/s regardless of link speed
 * (#1735). Explicit headers override Bun's auto-detected Content-Type/Length.
 */
export async function streamFile(
  absPath: string,
  contentType: string,
  extraHeaders?: Record<string, string>,
): Promise<Response | null> {
  const st = await safeStat(absPath);
  if (!st || !st.isFile()) return null;
  return new Response(Bun.file(absPath), {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(st.size),
      ...extraHeaders,
    },
  });
}

export type ByteRange = { ok: true; start: number; end: number } | { ok: false };

/** Parse the single byte range used by media players. */
export function parseByteRange(value: string, size: number): ByteRange {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || size <= 0) return { ok: false };
  const [, startText, endText] = match;
  if (!startText && !endText) return { ok: false };

  if (!startText) {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { ok: false };
    return { ok: true, start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(startText);
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) return { ok: false };
  const requestedEnd = endText ? Number(endText) : size - 1;
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) return { ok: false };
  return { ok: true, start, end: Math.min(requestedEnd, size - 1) };
}

/** Serve a regular file with the single-range contract required by media players. */
export function streamFileRange(
  absPath: string,
  contentType: string,
  size: number,
  rangeHeader?: string,
): Response {
  const common = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=0, must-revalidate',
    'Referrer-Policy': 'no-referrer',
  };
  if (!rangeHeader) {
    return new Response(Bun.file(absPath), {
      status: 200,
      headers: { ...common, 'Content-Length': String(size) },
    });
  }
  const range = parseByteRange(rangeHeader, size);
  if (!range.ok) {
    return new Response(null, {
      status: 416,
      headers: { ...common, 'Content-Range': `bytes */${size}` },
    });
  }
  const length = range.end - range.start + 1;
  return new Response(Bun.file(absPath).slice(range.start, range.end + 1), {
    status: 206,
    headers: {
      ...common,
      'Content-Length': String(length),
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
    },
  });
}

/**
 * Extension from a filename (lowercase, no dot).
 */
export function extOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

/**
 * Split an Elysia `*` wildcard into path segments, percent-decoding each.
 * Elysia 1.1 does NOT decode path params, and the web client encodes every
 * segment with `encodeURIComponent` (see MapleAddress.toApiPath), so each
 * segment must be decoded here or filenames with spaces / `#` / unicode never
 * match the decoded `fileinfo.filename` in Mongo. `/` separators are literal
 * and split first; a malformed escape falls back to the raw segment.
 */
export function parseWildcardSegments(wildcard: string): string[] {
  if (!wildcard) return [];
  return wildcard.split('/').map((seg) => {
    try {
      return decodeURIComponent(seg);
    } catch {
      return seg;
    }
  });
}

/**
 * Get the asset record for a specific (library_id, path, filename) tuple.
 * Uses the `fileinfo_lib_path_name` compound index.
 */
import { assetsCollection } from '../../db/client.ts';
import type { ObjectId } from 'mongodb';

export async function findAssetByAddress(libraryId: ObjectId, relPath: string, filename: string) {
  const coll = await assetsCollection();
  return coll.findOne(
    {
      fileinfo: {
        $elemMatch: {
          library_id: libraryId,
          path: relPath,
          filename,
          deleted_at: null,
          missing_since: null,
        },
      },
      deleted_at: null,
    },
    {
      projection: {
        maple_id: 1,
        fileinfo: 1,
      },
    },
  );
}
