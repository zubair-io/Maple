/**
 * GET /api/image/:slug/*
 *
 * Streams the original image file bytes. Content-Type is derived from the
 * file extension. The response is jailed via resolveAddress.
 */

import { Elysia, t } from 'elysia';
import * as path from 'node:path';
import { resolveAddress } from '../../library/address.ts';
import {
  mimeForExt,
  streamFile,
  safeStat,
  extOf,
  IMAGE_EXTENSIONS_SET,
  STUB_AND_AUDIO_EXTENSIONS_SET,
  parseWildcardSegments,
} from './shared.ts';

export const imageRoutes = new Elysia().get(
  '/image/:slug/*',
  async ({ params, set }) => {
    const slug = params.slug;
    const wildcard = (params as Record<string, string>)['*'] ?? '';
    const segments = parseWildcardSegments(wildcard);
    const relPath = segments.join('/');

    let resolved: Awaited<ReturnType<typeof resolveAddress>>;
    try {
      resolved = await resolveAddress(slug, relPath);
    } catch (err) {
      const e = err as { status?: number; message?: string };
      set.status = e.status ?? 500;
      return { error: e.message ?? 'Internal error' };
    }

    const { absPath } = resolved;
    const filename = path.basename(absPath);
    const ext = extOf(filename);

    // Metadata-only stub images (eip/braw/afphoto/ai) and audio (#1835) have
    // no decoder, but this route just streams original bytes through — a
    // legitimate operation for downloading a stub file or playing back
    // audio, so it's allowed here even though these extensions aren't in
    // IMAGE_EXTENSIONS_SET (which gates routes that assume decodable raster
    // bytes).
    if (!IMAGE_EXTENSIONS_SET.has(ext) && !STUB_AND_AUDIO_EXTENSIONS_SET.has(ext)) {
      set.status = 415;
      return { error: `Unsupported file extension: "${ext}"` };
    }

    const st = await safeStat(absPath);
    if (!st || !st.isFile()) {
      set.status = 404;
      return { error: 'File not found' };
    }

    const contentType = mimeForExt(ext);
    const resp = await streamFile(absPath, contentType);
    if (!resp) {
      set.status = 404;
      return { error: 'File not found' };
    }
    return resp;
  },
  {
    params: t.Object({
      slug: t.String({ minLength: 1 }),
      '*': t.Optional(t.String()),
    }),
  },
);
