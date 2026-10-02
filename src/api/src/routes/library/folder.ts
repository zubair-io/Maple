/** Root and nested unified folder listings. Web address fields are retained;
 * filesystem metadata, sidecars and cursor pages unblock native consumers (#4001). */
import { Elysia, t } from 'elysia';
import { parseAddressPath, resolveAddress } from '../../library/address.ts';
import { listUnifiedFolder } from '../../library/folder-listing.ts';
import { parseWildcardSegments, wildcardSlugParams } from './shared.ts';
import { seedRoot } from '../../workers/discover/frontier.repo.ts';
import { readCheckpoint } from '../../db/repos/indexer-checkpoints.repo.ts';
import { requireFileAccessBeforeHandle } from '../../auth/middleware.ts';
import { computeBodyETag, ifNoneMatchEqual } from '../../runtime/http-etag.ts';
import { child as childLogger } from '../../log.ts';

const log = childLogger('routes/library/folder');
const listingQuery = t.Object({ cursor: t.Optional(t.String()), limit: t.Optional(t.String()) });
const jsonError = (status: number, message: string): Response =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

type FolderListing = Awaited<ReturnType<typeof listUnifiedFolder>>;
type FolderAddress = Awaited<ReturnType<typeof resolveAddress>>;

function pageLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed)) {
    throw Object.assign(new Error('limit must be an integer'), { status: 400 });
  }
  return parsed;
}
async function enqueueDiscover(listing: FolderListing, resolved: FolderAddress) {
  if (!listing.images.some((image) => !image.indexed)) return;
  // The worker owns hashing, pacing and inherited folder-hidden state. The
  // request only records durable work; it never hashes a directory or RAW.
  try {
    const checkpoint = await readCheckpoint(resolved.libraryId.toHexString());
    await seedRoot(resolved.libraryId, resolved.libraryRoot, checkpoint?.sweepGen ?? 1);
  } catch (error) {
    log.warn({ absPath: resolved.absPath, error: String(error) }, 'discover enqueue failed');
  }
}
function listingResponse(listing: FolderListing, started: number, ifNoneMatch: string | undefined) {
  const body = JSON.stringify(listing);
  const etag = computeBodyETag(body);
  const headers = {
    ETag: etag,
    'Content-Type': 'application/json',
    'Cache-Control': 'private, max-age=0, must-revalidate',
    'Server-Timing': `total;dur=${Math.round(performance.now() - started)}`,
  };
  return ifNoneMatchEqual(ifNoneMatch, etag)
    ? new Response(null, { status: 304, headers })
    : new Response(body, { status: 200, headers });
}
function listingError(error: unknown): Response {
  const e = error as { status?: number; message?: string };
  const invalidCursor =
    e.message?.startsWith('malformed cursor:') ||
    e.message?.startsWith('cursor offset out of range:');
  const status = invalidCursor || error instanceof URIError ? 400 : (e.status ?? 500);
  if (status === 500) log.error({ error: String(error) }, 'folder listing failed');
  return jsonError(status, e.message ?? 'Internal error');
}
async function buildFolderListing(
  slug: string,
  wildcard: string,
  query: { cursor?: string; limit?: string },
  ifNoneMatch: string | undefined,
): Promise<Response> {
  const started = performance.now();
  try {
    const limit = pageLimit(query.limit);
    const { relPath } = parseAddressPath(slug, parseWildcardSegments(wildcard));
    const resolved = await resolveAddress(slug, relPath);
    const listing = await listUnifiedFolder(slug, relPath, resolved, {
      cursor: query.cursor,
      limit,
    });
    await enqueueDiscover(listing, resolved);
    return listingResponse(listing, started, ifNoneMatch);
  } catch (error) {
    return listingError(error);
  }
}

// Wildcard does not match the bare root route. Both forms share the same
// file-access guard and query contract; pixel routes retain their own gates.
export const folderRoutes = new Elysia()
  .get(
    '/folder/:slug',
    ({ params, query, headers }) =>
      buildFolderListing(params.slug, '', query, headers['if-none-match']),
    {
      beforeHandle: requireFileAccessBeforeHandle,
      params: t.Object({ slug: t.String({ minLength: 1 }) }),
      query: listingQuery,
    },
  )
  .get(
    '/folder/:slug/*',
    ({ params, query, headers }) =>
      buildFolderListing(
        params.slug,
        (params as Record<string, string>)['*'] ?? '',
        query,
        headers['if-none-match'],
      ),
    {
      beforeHandle: requireFileAccessBeforeHandle,
      params: wildcardSlugParams(),
      query: listingQuery,
    },
  );
