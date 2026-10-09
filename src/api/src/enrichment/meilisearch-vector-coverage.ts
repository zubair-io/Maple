/**
 * Which assets are covered by the current embedder generation, and how that
 * coverage is carried forward.
 *
 * Storage is `db/repos/assets.meilisearch.ts`. The Mongo-era
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
  promoteVectorFingerprint,
} from '../db/repos/assets.meilisearch.ts';
import type { MeilisearchClient } from './meilisearch-client.ts';

type CoverageClient = Pick<MeilisearchClient, 'semanticFingerprint' | 'embedderInSync'>;

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
 * until their stage/backfill task succeeds. A pending marker is never a
 * target: it is not a fingerprint. */
export async function advanceKnownVectorCoverage(
  fingerprint: string | null | undefined,
): Promise<void> {
  if (!fingerprint || isPendingMarker(fingerprint)) return;
  const shape = documentShapeOf(fingerprint);
  if (shape === null) return;
  // Only rows whose stored fingerprint has the SAME document shape. A shape
  // change matches nothing, leaving every row uncovered — which is what
  // surfaces "re-embed needed" on Settings → Workers and what the backfill
  // route then works through. Same-shape pending markers match too.
  await advanceVectorFingerprint(`${shape}:`, fingerprint);
}

const PENDING = 'pending';

function isPendingMarker(marker: string): boolean {
  return marker.endsWith(`:${PENDING}`);
}

function pendingMarker(fingerprint: string | null): string | null {
  const shape = documentShapeOf(fingerprint);
  return shape === null ? null : `${shape}:${PENDING}`;
}

/**
 * The Settings fingerprint, but only once `ensureIndex` has confirmed the live
 * index embedder matches it (#4432). `null` while it drifts, while a settings
 * task is still running, and for a freshly (re)configured client that has not
 * been checked yet.
 */
export function confirmedFingerprint(client: CoverageClient): string | null {
  return client.embedderInSync?.() === true ? (client.semanticFingerprint?.() ?? null) : null;
}

/**
 * What a document write records in `semantic_vector_fingerprint` (#4432).
 * Confirmed in sync: the Settings fingerprint. Otherwise Meilisearch may be
 * embedding with a different url/model, so the row gets `v<shape>:pending`:
 * it is not counted as covered, and the next confirmed-in-sync check
 * advances it (`advancePendingVectorCoverage`). Whenever the live embedder
 * matches Settings, every document in the index carries that embedder's
 * vectors — a settings task that fails leaves the old embedder live, so the
 * rows stay pending until a later check confirms a match.
 */
export function coverageMarker(client: CoverageClient): string | null {
  return confirmedFingerprint(client) ?? pendingMarker(client.semanticFingerprint?.() ?? null);
}

/** Promote rows written while the embedder was unconfirmed. Indexed exact
 * match, cheap enough for every readiness pass. */
export async function advancePendingVectorCoverage(fingerprint: string | null): Promise<void> {
  const pending = pendingMarker(fingerprint);
  if (fingerprint === null || pending === null) return;
  await promoteVectorFingerprint(pending, fingerprint);
}

/** Health-check, sync index settings, then carry coverage forward when the
 * live embedder is confirmed to match. Resolves `false` when unreachable. */
export async function syncIndexAndCoverage(
  client: CoverageClient & Pick<MeilisearchClient, 'health' | 'ensureIndex'>,
): Promise<boolean> {
  if (!(await client.health())) return false;
  await client.ensureIndex();
  await advanceKnownVectorCoverage(confirmedFingerprint(client));
  return true;
}
