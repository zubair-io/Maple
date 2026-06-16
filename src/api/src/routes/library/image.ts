/**
 * GET /api/image/:slug/*
 *
 * Streams the original image file bytes. Content-Type is derived from the
 * file extension. The response is jailed via resolveAddress.
 */

import { Elysia, t } from 'elysia';
import * as path from 'node:path';
import { parseAddressPath, resolveAddress } from '../../library/address.ts';
import { child as childLogger } from '../../log.ts';
import {
  mimeForExt,
  streamFile,
  safeStat,
  extOf,
  IMAGE_EXTENSIONS_SET,
  parseWildcardSegments,
} from './shared.ts';

const log = childLogger('routes/library/image');

export const imageRoutes = new Elysia().get(
  '/image/:slug/*',
  async ({ params, set }) => {
    const slug = params.slug;
    const wildcard = (params as Record<string, string>)['*'] ?? '';
    const segments = parseWildcardSegments(wildcard);
    const { relPath } = parseAddressPath(slug, segments);

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

    if (!IMAGE_EXTENSIONS_SET.has(ext)) {
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
