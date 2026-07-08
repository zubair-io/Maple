/**
 * Shared utilities for the M1 library routes.
 */

import { stat } from 'node:fs/promises';
import { RAW_EXTENSIONS, SHARP_EXTENSIONS, PSD_HDR_EXTENSIONS } from '../../fs/browse.ts';

/** Union of all image extensions surfaced by library routes. */
export const IMAGE_EXTENSIONS_SET = new Set<string>([
  ...RAW_EXTENSIONS,
  ...SHARP_EXTENSIONS,
  ...PSD_HDR_EXTENSIONS,
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
};

export function mimeForExt(ext: string): string {
  return MIME_BY_EXT[ext.toLowerCase()] ?? 'application/octet-stream';
}

/** Immutable cache control for content-keyed responses. */
export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

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
