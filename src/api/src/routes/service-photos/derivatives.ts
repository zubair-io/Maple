/**
 * Thumbnail and preview bytes for `GET /api/service/photos/:assetId/{thumb,preview}`.
 *
 * The photo's primary file is addressed the way the app addresses it (`/thumb/:slug/*`,
 * `/preview/:slug/*`) and the request is handed to those same route handlers in process, so the
 * service API shares their on-demand generation, deduplication, freshness checks and on-disk
 * cache instead of copying them. Only the response is adapted: errors take the service shape and
 * the cache headers are pinned private.
 */

import { Elysia } from 'elysia';
import { primaryPhotoAddress } from '../../db/repos/service-photos.repo.ts';
import { previewRoutes } from '../library/preview.ts';
import { thumbRoutes } from '../library/thumb.ts';
import type { ServiceError } from './auth.ts';

export type DerivativeKind = 'thumb' | 'preview';

const derivativeApp = new Elysia().use(thumbRoutes).use(previewRoutes);

const PASSED_HEADERS = ['content-type', 'etag', 'content-length'] as const;
const SERVICE_IMAGE_CACHE = 'private, max-age=0, must-revalidate';

const ERROR_CODES: Record<number, string> = {
  404: 'not_found',
  415: 'unsupported_media',
  422: 'undecodable',
  503: 'derivative_unavailable',
};

function errorResponse(status: number, body: ServiceError): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function passThrough(response: Response): Response {
  const headers = new Headers({ 'cache-control': SERVICE_IMAGE_CACHE });
  for (const name of PASSED_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new Response(response.status === 304 ? null : response.body, {
    status: response.status,
    headers,
  });
}

async function failure(response: Response): Promise<Response> {
  const detail = (await response.json().catch(() => null)) as { error?: unknown } | null;
  const status = response.status === 202 ? 503 : response.status;
  const message =
    typeof detail?.error === 'string' ? detail.error : 'The image could not be produced.';
  return errorResponse(status, { error: ERROR_CODES[status] ?? 'derivative_failed', message });
}

function adapt(response: Response): Promise<Response> | Response {
  return response.status === 200 || response.status === 304
    ? passThrough(response)
    : failure(response);
}

/** The derivative of a photo the caller has already been allowed to see. */
export async function serveDerivative(
  kind: DerivativeKind,
  assetId: string,
  request: Request,
): Promise<Response> {
  const address = await primaryPhotoAddress(assetId);
  if (address === null) {
    return errorResponse(404, { error: 'not_found', message: 'No such photo.' });
  }
  const relPath = [...address.path.split('/').filter((part) => part !== ''), address.filename]
    .map(encodeURIComponent)
    .join('/');
  const ifNoneMatch = request.headers.get('if-none-match');
  const inner = new Request(
    `http://maple.internal/${kind}/${encodeURIComponent(address.slug)}/${relPath}`,
    {
      headers: ifNoneMatch === null ? {} : { 'if-none-match': ifNoneMatch },
      signal: request.signal,
    },
  );
  return adapt(await derivativeApp.handle(inner));
}
