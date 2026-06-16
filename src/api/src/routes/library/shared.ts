/**
 * Shared utilities for the M1 library routes.
 */

import * as path from 'node:path';
import { stat } from 'node:fs/promises';
import { RAW_EXTENSIONS, SHARP_EXTENSIONS } from '../../fs/browse.ts';

/** Union of all image extensions surfaced by library routes. */
export const IMAGE_EXTENSIONS_SET = new Set<string>([...RAW_EXTENSIONS, ...SHARP_EXTENSIONS]);

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
};

export function mimeForExt(ext: string): string {
  return MIME_BY_EXT[ext.toLowerCase()] ?? 'application/octet-stream';
}

/** Immutable cache control for content-keyed responses. */
export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

/**
 * Safe stat — returns null on any error.
 */
export async function safeStat(
  p: string,
): Promise<Awaited<ReturnType<typeof stat>> | null> {
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
 */
export async function streamFile(
  absPath: string,
  contentType: string,
  extraHeaders?: Record<string, string>,
): Promise<Response | null> {
  const st = await safeStat(absPath);
  if (!st || !st.isFile()) return null;
  const { Readable } = await import('node:stream');
  const { createReadStream } = await import('node:fs');
  const nodeStream = createReadStream(absPath);
  const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;
  return new Response(webStream, {
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
 * Get the asset record for a specific (library_id, path, filename) tuple.
 * Uses the `fileinfo_lib_path_name` compound index.
 */
import { assetsCollection } from '../../db/client.ts';
import type { ObjectId } from 'mongodb';

export async function findAssetByAddress(
  libraryId: ObjectId,
  relPath: string,
  filename: string,
) {
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
