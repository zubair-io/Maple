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

import type { Collection, ObjectId } from 'mongodb';
import { assetsCollection } from '../db/client.ts';
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
import type { AssetDoc } from '../db/schema.ts';

const log = childLogger('cloudflare:hidden-cleanup');

/** Bounds a single R2 delete's wall-clock — this module is awaited from
 * worker-stage handlers, so an unbounded `fetch` on an R2-side hang would
 * stall the stage's concurrency slot indefinitely. Same value the
 * live-upload hook used for its own bounded PUT. */
const CF_DELETE_TIMEOUT_MS = 5_000;

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
  assets: Collection<AssetDoc>,
): Promise<void> {
  // Deliberately UNCONDITIONAL on `asset.cf_thumb_synced_at` — that field on
  // the passed-in `asset` is a snapshot from whenever the calling stage
  // claimed its batch, which can be stale relative to the database: a
  // concurrently-running upload (the live-upload hook, or another poll tick)
  // can set the real `cf_thumb_synced_at` after this snapshot was taken but
  // before this hide transition is processed, and skipping on stale-null
  // would leave that just-uploaded thumbnail stuck in R2 forever (the
  // per-asset stage version is already marked done by then). Attempting the
  // delete unconditionally costs one extra R2 round-trip for assets that
  // truly were never uploaded — `deleteThumbFromR2` already treats a 404
  // there as success, so that case is harmless.
  const primary = assetPrimaryFileInfo(asset);
  if (!primary) return;
  const slug = idToSlug.get(primary.library_id.toHexString());
  if (!slug) return;

  const key = thumbR2Key({ slug, relDir: primary.path, filename: primary.filename });
  try {
    await deleteThumbFromR2(config, key, AbortSignal.timeout(CF_DELETE_TIMEOUT_MS));
    await assets.updateOne({ _id: asset._id }, { $set: { cf_thumb_synced_at: null } });
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
 * potentially now including a newly-hidden one — still sit in R2.
 *
 * The whole body is wrapped, not just the R2 call inside `deleteOne`: this
 * function's callers (the describe / sidecar-metadata-index stage handlers)
 * `await` it unwrapped, trusting the "never throws" contract above — a
 * transient failure resolving config or the library-slug map (both real
 * Mongo reads) must not propagate and fail the calling stage run. */
export async function cleanupR2ThumbForHiddenAsset(asset: HidableAsset): Promise<void> {
  try {
    const dbConfig = await loadCloudflareConfig();
    const config = resolveCloudflareConfig(dbConfig);
    if (!hasCloudflareCredentials(config)) return;
    const idToSlug = await loadLibraryIdToSlug();
    const assets = await assetsCollection();
    await deleteOne(asset, config, idToSlug, assets);
  } catch (err) {
    log.warn(
      { assetId: asset._id.toHexString(), err: err instanceof Error ? err.message : err },
      'failed to resolve config/library map for R2 cleanup — thumbnail remains cached until a manual cleanup',
    );
  }
}

/** Bulk variant for burst-sibling propagation — resolves the library-slug
 * map once and fans the deletes out concurrently instead of one
 * `loadLibraryIdToSlug()` call per sibling. Same non-throwing contract and
 * rationale as `cleanupR2ThumbForHiddenAsset` above. */
export async function cleanupR2ThumbsForHiddenAssets(hidden: HidableAsset[]): Promise<void> {
  if (hidden.length === 0) return;
  try {
    const dbConfig = await loadCloudflareConfig();
    const config = resolveCloudflareConfig(dbConfig);
    if (!hasCloudflareCredentials(config)) return;
    const idToSlug = await loadLibraryIdToSlug();
    const assets = await assetsCollection();
    await Promise.all(hidden.map((asset) => deleteOne(asset, config, idToSlug, assets)));
  } catch (err) {
    log.warn(
      { count: hidden.length, err: err instanceof Error ? err.message : err },
      'failed to resolve config/library map for bulk R2 cleanup — thumbnails remain cached until a manual cleanup',
    );
  }
}
