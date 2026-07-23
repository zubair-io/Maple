/**
 * Token-authenticated video streaming routes.
 *
 * Native media elements cannot attach Authorization headers, so these routes
 * follow /api/events and accept the same short-lived access token in ?token=.
 */
import { Elysia, t } from 'elysia';
import * as path from 'node:path';
import { verifyAccessToken } from '../auth/tokens.ts';
import { resolveAddress } from '../library/address.ts';
import { VIDEO_EXTS } from '../indexer/media-types.ts';
import { resolveJailedFile } from './fs-jail.ts';
import {
  extOf,
  mimeForExt,
  parseWildcardSegments,
  safeStat,
  streamFileRange,
} from './library/shared.ts';

function jwtSecret(): string {
  const secret = process.env.MAPLE_JWT_SECRET;
  if (!secret || secret.length < 16) throw new Error('MAPLE_JWT_SECRET unset or too short');
  return secret;
}

async function authorized(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  try {
    await verifyAccessToken(token, jwtSecret());
    return true;
  } catch {
    return false;
  }
}

function videoExtension(ext: string): boolean {
  return VIDEO_EXTS.has(`.${ext.toLowerCase()}`);
}

export const videoRoutes = new Elysia({ prefix: '/api' })
  .get(
    '/video/fs',
    async ({ query, headers, set }) => {
      if (!(await authorized(query.token))) {
        set.status = 401;
        return { error: 'Invalid or expired access token' };
      }
      if (!query.path) {
        set.status = 400;
        return { error: 'path is required' };
      }
      const jailed = await resolveJailedFile(query.path);
      if (!jailed.ok) {
        set.status = jailed.status;
        return { error: jailed.error };
      }
      if (!videoExtension(jailed.ext)) {
        set.status = 415;
        return { error: `Unsupported video extension: "${jailed.ext}"` };
      }
      return streamFileRange(
        jailed.real,
        mimeForExt(jailed.ext),
        Number(jailed.stat.size),
        headers.range,
      );
    },
    {
      query: t.Object({
        // Optional at schema level so authentication runs before validation;
        // the route-inventory probe must receive 401 without a token.
        path: t.Optional(t.String({ minLength: 1 })),
        token: t.Optional(t.String()),
      }),
    },
  )
  .get(
    '/video/:slug/*',
    async ({ params, query, headers, set }) => {
      if (!(await authorized(query.token))) {
        set.status = 401;
        return { error: 'Invalid or expired access token' };
      }
      const wildcard = (params as Record<string, string>)['*'] ?? '';
      let resolved: Awaited<ReturnType<typeof resolveAddress>>;
      try {
        resolved = await resolveAddress(params.slug, parseWildcardSegments(wildcard).join('/'));
      } catch (error) {
        const e = error as { status?: number; message?: string };
        set.status = e.status ?? 500;
        return { error: e.message ?? 'Internal error' };
      }
      const ext = extOf(path.basename(resolved.absPath));
      if (!videoExtension(ext)) {
        set.status = 415;
        return { error: `Unsupported video extension: "${ext}"` };
      }
      const st = await safeStat(resolved.absPath);
      if (!st?.isFile()) {
        set.status = 404;
        return { error: 'File not found' };
      }
      return streamFileRange(resolved.absPath, mimeForExt(ext), Number(st.size), headers.range);
    },
    {
      params: t.Object({
        slug: t.String({ minLength: 1 }),
        '*': t.Optional(t.String()),
      }),
      query: t.Object({ token: t.Optional(t.String()) }),
    },
  );
