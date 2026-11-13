/**
 * GET/HEAD /api/motion/:slug/* — the clip embedded in an Android Motion Photo
 * (#5447), served as a byte range of the original still.
 *
 * The `motion-photo` stage records where the clip sits; nothing is extracted
 * to disk and the original is only ever read. Range offsets are relative to
 * the clip, so a media element treats it as a standalone video. HEAD answers
 * whether the still at an address has a playable clip without sending it.
 *
 * Token-authenticated like `/api/video/:slug/*`, because native media elements
 * cannot attach an Authorization header.
 */
import { Elysia, t, type Context } from 'elysia';
import * as path from 'node:path';
import { findMotionClipAtAddress } from '../db/repos/assets.address.ts';
import { clipStillInPlace } from '../indexer/motion-photo/detect.ts';
import { resolveAddress } from '../library/address.ts';
import { parseWildcardSegments, streamFileSlice, wildcardSlugParams } from './library/shared.ts';
import { authorized } from './video.ts';

interface MotionRequest {
  params: { slug: string } & Record<string, string>;
  query: { token?: string };
  headers: Record<string, string | undefined>;
  set: Context['set'];
}

async function motionClip({ params, query, headers, set }: MotionRequest) {
  if ((await authorized(query.token)) === null) {
    set.status = 401;
    return { error: 'Invalid or expired access token' };
  }
  const segments = parseWildcardSegments(params['*'] ?? '');
  const filename = segments.at(-1);
  if (filename === undefined) {
    set.status = 404;
    return { error: 'File not found' };
  }
  let resolved: Awaited<ReturnType<typeof resolveAddress>>;
  try {
    resolved = await resolveAddress(params.slug, segments.join('/'));
  } catch (error) {
    const failure = error as { status?: number; message?: string };
    set.status = failure.status ?? 500;
    return { error: failure.message ?? 'Internal error' };
  }
  const clip = await findMotionClipAtAddress(
    resolved.libraryId,
    segments.slice(0, -1).join('/'),
    filename,
  );
  if (!clip || !(await clipStillInPlace(resolved.absPath, clip, clip.sourceSize))) {
    set.status = 404;
    return {
      error: `${path.basename(resolved.absPath)} has no embedded motion clip`,
    };
  }
  return streamFileSlice(resolved.absPath, clip.mime, clip, headers.range);
}

const routeSchema = {
  params: wildcardSlugParams(),
  query: t.Object({ token: t.Optional(t.String()) }),
};

export const motionRoutes = new Elysia({ prefix: '/api' })
  .get('/motion/:slug/*', (context) => motionClip(context as MotionRequest), routeSchema)
  .head('/motion/:slug/*', (context) => motionClip(context as MotionRequest), routeSchema);
