/**
 * `/api/service/*` — read-only photo and people access for external integrations, authenticated
 * by a scoped service key (`auth/service-api-keys.ts`) instead of a user session.
 *
 *   GET  /api/service/people                     people:read
 *   POST /api/service/photos/search              assets:search
 *   GET  /api/service/photos/:assetId            assets:read
 *   GET  /api/service/photos/:assetId/thumb      assets:read
 *   GET  /api/service/photos/:assetId/preview    assets:read
 *
 * Everything is limited to the user who minted the key: their live, visible still photos, with
 * hidden, excluded and merged-away people never shown. A photo outside that set answers 404
 * whether or not it exists. The contract is documented in `docs/server-api.md`.
 */

import { Elysia, type Context } from 'elysia';
import type { ServiceApiIdentity } from '../../auth/service-api-keys.ts';
import { personIdsToDrop } from '../../db/repos/people.visibility.ts';
import { listServicePeople } from '../../db/repos/service-people.repo.ts';
import { countPhotos, hydratePhotos } from '../../db/repos/service-photos.repo.ts';
import { assetIdsPredicate, ownerPhotoWhere } from '../../db/repos/service-photos.where.ts';
import { consumeServiceSearchRateLimit } from '../../enrichment/service-search-rate-limit.ts';
import { child as childLogger } from '../../log.ts';
import { authorize, isServiceError, notFound, serviceError } from './auth.ts';
import { serveDerivative, type DerivativeKind } from './derivatives.ts';
import { parseSearchBody } from './search-body.ts';
import { searchPhotos } from './search.ts';

const log = childLogger('service-photos');
const ASSET_ID = /^[a-f0-9]{24}$/;

const INVALID_JSON = Symbol('invalid-json');

async function readJson(request: Request): Promise<unknown> {
  try {
    return JSON.parse(await request.text());
  } catch {
    return INVALID_JSON;
  }
}

async function ownerScope(identity: ServiceApiIdentity) {
  return ownerPhotoWhere(identity.ownerId, await personIdsToDrop(undefined));
}

/** One photo by id: a search can serve a stack's JPEG on its own, so it stays addressable. */
async function photoScope(identity: ServiceApiIdentity) {
  return { ...(await ownerScope(identity)), foldStacks: false };
}

async function isVisiblePhoto(identity: ServiceApiIdentity, assetId: string): Promise<boolean> {
  if (!ASSET_ID.test(assetId)) return false;
  return (await countPhotos(await photoScope(identity), assetIdsPredicate([assetId]))) === 1;
}

async function derivative(
  kind: DerivativeKind,
  assetId: string,
  request: Request,
  set: Context['set'],
) {
  const identity = await authorize(request, 'assets:read', set);
  if (isServiceError(identity)) return identity;
  if (!(await isVisiblePhoto(identity, assetId))) return notFound(set);
  return serveDerivative(kind, assetId, request);
}

export const servicePhotosRoutes = new Elysia({
  name: 'servicePhotosRoutes',
  prefix: '/api/service',
})
  .get('/people', async ({ request, set }) => {
    const identity = await authorize(request, 'people:read', set);
    if (isServiceError(identity)) return identity;
    return { people: await listServicePeople(await ownerScope(identity)) };
  })
  .post(
    '/photos/search',
    async ({ request, set }) => {
      const startedAt = performance.now();
      const identity = await authorize(request, 'assets:search', set);
      if (isServiceError(identity)) return identity;
      const body = await readJson(request);
      if (body === INVALID_JSON) {
        return serviceError(set, 400, 'invalid_request', 'The request body must be valid JSON.');
      }
      const parsed = parseSearchBody(body);
      if (!parsed.ok) return serviceError(set, 400, 'invalid_request', parsed.message);
      const rate = await consumeServiceSearchRateLimit(identity.keyId);
      if (!rate.allowed) {
        set.headers['retry-after'] = String(rate.retryAfterSeconds);
        return serviceError(set, 429, 'rate_limit_exceeded', 'Too many searches; retry later.');
      }
      const outcome = await searchPhotos(identity, parsed.request);
      if (outcome === 'invalid_cursor') {
        return serviceError(
          set,
          400,
          'invalid_cursor',
          'The cursor does not belong to this search.',
        );
      }
      log.info(
        {
          keyId: identity.keyId,
          total: outcome.total,
          returned: outcome.photos.length,
          durationMs: Math.round(performance.now() - startedAt),
        },
        'service photo search',
      );
      return outcome;
    },
    // Parsed by hand, after authentication, so an unauthenticated caller never learns how the
    // body was judged.
    { parse: 'none' },
  )
  .get('/photos/:assetId', async ({ params, request, set }) => {
    const identity = await authorize(request, 'assets:read', set);
    if (isServiceError(identity)) return identity;
    if (!ASSET_ID.test(params.assetId)) return notFound(set);
    const [photo] = await hydratePhotos(await photoScope(identity), [params.assetId]);
    return photo ?? notFound(set);
  })
  .get('/photos/:assetId/thumb', ({ params, request, set }) =>
    derivative('thumb', params.assetId, request, set),
  )
  .get('/photos/:assetId/preview', ({ params, request, set }) =>
    derivative('preview', params.assetId, request, set),
  );
