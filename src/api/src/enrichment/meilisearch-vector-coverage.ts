import type { ObjectId } from 'mongodb';
import { assetsCollection } from '../db/client.ts';

export const LIVE_ASSET_FILTER = {
  deleted_at: { $in: [null] },
  fileinfo: {
    $elemMatch: {
      deleted_at: { $in: [null] },
      missing_since: { $in: [null] },
    },
  },
} as const;

export async function markAssetsVectorized(
  assetIds: ObjectId[],
  fingerprint: string | null | undefined,
): Promise<void> {
  if (!fingerprint || assetIds.length === 0) return;
  await (
    await assetsCollection()
  ).updateMany({ _id: { $in: assetIds } }, { $set: { semantic_vector_fingerprint: fingerprint } });
}

/**
 * The `v<N>` document-shape prefix of a fingerprint, or `null` for an
 * unprefixed legacy value.
 *
 * Coverage carries forward only within one shape. A settings PATCH makes
 * Meilisearch re-embed the documents ALREADY IN ITS INDEX — which is why a
 * pure model/url/template-wording change carries forward safely. But when the
 * document shape changes, the template dereferences fields those indexed
 * documents do not carry yet, so the re-embed happens against missing data.
 * Counting that as coverage would show the operator 100% while every vector
 * was built without a transcript (#2384).
 */
export function documentShapeOf(fingerprint: string | null | undefined): string | null {
  if (!fingerprint) return null;
  const colon = fingerprint.indexOf(':');
  if (colon <= 0 || fingerprint[0] !== 'v') return null;
  return fingerprint.slice(0, colon);
}

/** A completed embedder-settings task re-embeds documents already confirmed
 * in Meilisearch. Carry only those markers forward, and only WITHIN one
 * document shape (see `documentShapeOf`); unmarked Mongo rows stay uncovered
 * until their stage/backfill task succeeds. */
export async function advanceKnownVectorCoverage(
  fingerprint: string | null | undefined,
): Promise<void> {
  if (!fingerprint) return;
  const shape = documentShapeOf(fingerprint);
  if (shape === null) return;
  await (
    await assetsCollection()
  ).updateMany(
    {
      ...LIVE_ASSET_FILTER,
      // Only rows whose stored fingerprint has the SAME document shape. A
      // shape change matches nothing, leaving every row uncovered — which is
      // what surfaces "re-embed needed" on Settings → Workers and what the
      // backfill route then works through.
      semantic_vector_fingerprint: { $regex: `^${shape}:` },
    } as never,
    { $set: { semantic_vector_fingerprint: fingerprint } },
  );
}
