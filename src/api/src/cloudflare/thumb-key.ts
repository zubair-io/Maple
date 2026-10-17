/**
 * R2 object key derivation for content-addressed thumbnails.
 *
 * The Cloudflare Worker that fronts `GET /api/thumb/:slug/*` has no
 * database access, so it must be able to compute the exact same object
 * key straight from the incoming request URL (`slug` + wildcard segments)
 * with zero lookups. That forces the key to be PATH-based, not
 * `maple_id`-based: `thumbs/<slug>/<relDir>/<filename>`, mirroring the
 * route's own URL shape byte-for-byte. A re-render simply overwrites the
 * object at the same key — there is no separate invalidation step.
 *
 * This function is the single source of truth for that scheme on the API
 * side (called from the indexer's thumb-stage hook and, later, the
 * backfill job). The Worker re-implements the same derivation
 * independently in its own TypeScript project (`src/cloudflare/src/r2.ts`)
 * since the two are separate deploy units with no shared import — keep
 * the two in sync by hand if this scheme ever changes.
 *
 * The trailing `/v25` is a frozen literal, not a pipeline version (#4793):
 * it is the suffix every object already in the bucket was uploaded under, so
 * keeping it leaves the whole edge cache addressable with no mass re-upload.
 * It must never change with `PIPELINE_OUTPUT_VERSION`.
 */

/** Suffix of every current R2 thumbnail key. `0` addresses the bare key
 * objects were uploaded under before the suffix existed. */
export const FROZEN_R2_KEY_VERSION = 25;

/** Segments that make up a thumbnail's address, as already resolved by the
 * `/api/thumb/:slug/*` route (see `routes/library/thumb.ts`): the library
 * slug, the relative directory under the library root (`""` for a file at
 * the root), and the bare filename. */
export interface ThumbAddress {
  slug: string;
  relDir: string;
  filename: string;
}

/** Produce the R2 object key for a thumbnail address. Percent-encodes each
 * path segment individually so filenames containing `/`-unsafe characters
 * (spaces, unicode) round-trip identically whether derived here or by the
 * Worker from `new URL(request.url).pathname`. */
export function thumbR2Key(
  { slug, relDir, filename }: ThumbAddress,
  version = FROZEN_R2_KEY_VERSION,
): string {
  const segments = [slug, ...relDir.split('/').filter(Boolean), filename];
  const base = `thumbs/${segments.map(encodeURIComponent).join('/')}`;
  return version === 0 ? base : `${base}/v${version}`;
}
