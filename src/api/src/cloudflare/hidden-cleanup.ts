/**
 * Deletes a newly-hidden asset's thumbnail from the R2 mirror (#1757).
 *
 * `workers/stages/thumb.ts` already refuses to UPLOAD a thumbnail for an
 * asset that's hidden at generation time — but an asset can also become
 * hidden AFTER its thumbnail already made it to R2 (a manual hide via the
 * Batch Metadata Editor, or the describe stage's AI nudity detector firing
 * on a re-run). Without active cleanup, that thumbnail would stay
 * indefinitely fetchable via the Cloudflare Worker by anyone holding a
 * valid Maple bearer token — the Worker only checks token validity, not
 * per-asset visibility, so R2 residency alone determines exposure.
 *
 * Called from every write path that can flip `AssetDoc.hidden` to `true`:
 * the describe stage's primary-asset hide and burst-sibling propagation
 * (`workers/stages/describe.ts`), and the sidecar-metadata-index stage's
 * override projection (`workers/stages/sidecar-metadata-index.ts`, the
 * landing spot for a manual toggle via the Batch Metadata Editor). Callers
 * are responsible for only invoking this on a FALSE→TRUE transition (i.e.
 * skip when the asset was already hidden) — this module doesn't re-check
 * prior state itself, since callers already have it in hand from computing
 * the transition in the first place.
 *
 * Best-effort: never throws. A cleanup that doesn't land leaves the object
 * in R2 and `cf_thumb_synced_at` set — a subsequent manual R2 audit or a
 * future retry mechanism is the backstop; there's no separate bookkeeping
 * here for a failed delete (mirroring the live-upload hook's own
 * best-effort contract in `workers/stages/thumb.ts`).
 */

import type { ObjectId } from 'mongodb';
import { getDb } from '../db/client.ts';
import { assetPrimaryFileInfo } from '../indexer/images.repo.ts';
import { loadLibraryIdToSlug } from '../indexer/libraries.cache.ts';
import { child as childLogger } from '../log.ts';
import type { FileInfo } from '../db/schema.ts';
import {
  hasCloudflareCredentials,
  loadCloudflareConfig,
  resolveCloudflareConfig,
} from './cloudflare-config.repo.ts';
import { deleteThumbFromR2, type ResolvedCloudflareConfig } from './r2-client.ts';
import { thumbR2Key } from './thumb-key.ts';

const log = childLogger('cloudflare:hidden-cleanup');

/** The subset of an asset doc this module needs — deliberately narrow so
 * callers can pass either a full `ImageDoc`/`AssetDoc` or a lighter
 * in-memory projection (e.g. a burst sibling) without a cast. */
export interface HidableAsset {
  _id: ObjectId;
  fileinfo?: FileInfo[];
  cf_thumb_synced_at?: string | null;
}

async function deleteOne(
  asset: HidableAsset,
  config: ResolvedCloudflareConfig,
  idToSlug: ReadonlyMap<string, string>,
): Promise<void> {
  // Nothing was ever uploaded — skip the R2 round-trip entirely.
  if (!asset.cf_thumb_synced_at) return;
  const primary = assetPrimaryFileInfo(asset);
  if (!primary) return;
  const slug = idToSlug.get(primary.library_id.toHexString());
  if (!slug) return;

  const key = thumbR2Key({ slug, relDir: primary.path, filename: primary.filename });
  try {
    await deleteThumbFromR2(config, key);
    const db = await getDb();
    await db
      .collection('assets')
      .updateOne({ _id: asset._id }, { $set: { cf_thumb_synced_at: null } });
  } catch (err) {
    log.warn(
      { assetId: asset._id.toHexString(), key, err: err instanceof Error ? err.message : err },
      'failed to delete R2 thumbnail for newly-hidden asset — it remains cached until a manual cleanup',
    );
  }
}

/** Delete one newly-hidden asset's thumbnail from R2, if one was ever
 * uploaded. A no-op (not an error) when Cloudflare account/bucket/key
 * credentials aren't saved — without them there's nothing to delete
 * *from*. Unlike the upload gate, this deliberately does NOT require
 * `enabled: true`: an operator can turn uploads off while old thumbnails —
 * potentially now including a newly-hidden one — still sit in R2. */
export async function cleanupR2ThumbForHiddenAsset(asset: HidableAsset): Promise<void> {
  const dbConfig = await loadCloudflareConfig();
  const config = resolveCloudflareConfig(dbConfig);
  if (!hasCloudflareCredentials(config)) return;
  const idToSlug = await loadLibraryIdToSlug();
  await deleteOne(asset, config, idToSlug);
}

/** Bulk variant for burst-sibling propagation — resolves the library-slug
 * map once and fans the deletes out concurrently instead of one
 * `loadLibraryIdToSlug()` call per sibling. */
export async function cleanupR2ThumbsForHiddenAssets(assets: HidableAsset[]): Promise<void> {
  if (assets.length === 0) return;
  const dbConfig = await loadCloudflareConfig();
  const config = resolveCloudflareConfig(dbConfig);
  if (!hasCloudflareCredentials(config)) return;
  const idToSlug = await loadLibraryIdToSlug();
  await Promise.all(assets.map((asset) => deleteOne(asset, config, idToSlug)));
}
