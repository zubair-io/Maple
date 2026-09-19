/**
 * Which assets are covered by the current embedder generation, and how that
 * coverage is carried forward.
 *
 * Storage is `db/sqlite/repos/assets.meilisearch.ts`. The Mongo-era
 * `LIVE_ASSET_FILTER` — a `deleted_at` check plus an `$elemMatch` over
 * `fileinfo` — is gone, because "live" is one predicate on the assets table
 * (`LIVE_ASSET_PREDICATE`) that the repository spells verbatim so its partial
 * indexes apply. {@link countLiveAssets} and
 * {@link countLiveAssetsWithFingerprint} are what the status surface asks for
 * instead of composing that filter itself.
 */

import {
  advanceVectorFingerprint,
  countLiveAssetRows,
  countLiveAssetRowsWithFingerprint,
  markAssetRowsVectorized,
} from '../db/sqlite/repos/assets.meilisearch.ts';

/** How many live assets the library holds — vector coverage's denominator. */
export async function countLiveAssets(): Promise<number> {
  return countLiveAssetRows();
}

/** How many live assets carry this exact fingerprint — coverage's numerator. */
export async function countLiveAssetsWithFingerprint(fingerprint: string | null): Promise<number> {
  if (!fingerprint) return 0;
  return countLiveAssetRowsWithFingerprint(fingerprint);
}

export async function markAssetsVectorized(
  assetIds: readonly string[],
  fingerprint: string | null | undefined,
): Promise<void> {
  if (!fingerprint || assetIds.length === 0) return;
  await markAssetRowsVectorized(assetIds, fingerprint);
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
 * document shape (see `documentShapeOf`); unmarked rows stay uncovered
 * until their stage/backfill task succeeds. */
export async function advanceKnownVectorCoverage(
  fingerprint: string | null | undefined,
): Promise<void> {
  if (!fingerprint) return;
  const shape = documentShapeOf(fingerprint);
  if (shape === null) return;
  // Only rows whose stored fingerprint has the SAME document shape. A shape
  // change matches nothing, leaving every row uncovered — which is what
  // surfaces "re-embed needed" on Settings → Workers and what the backfill
  // route then works through.
  await advanceVectorFingerprint(`${shape}:`, fingerprint);
}
