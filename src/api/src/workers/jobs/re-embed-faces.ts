/**
 * Re-embed migration — recompute face embeddings for every asset whose
 * faces were embedded by an earlier (now-incompatible) model pair.
 *
 * Triggered by `POST /api/admin/re-embed-faces`. Idempotent — running it
 * twice is a no-op once every face is at `CURRENT_EMBEDDING_VERSION`.
 *
 * Selection criterion: any face document where `embedding_version` is
 * either missing OR not equal to `CURRENT_EMBEDDING_VERSION`. A missing
 * field implies the face was written by the pre-versioning code path
 * (v1 = MobileFaceNet, no version stamp); a present-but-different value
 * implies a model upgrade after a previous migration. Both need the
 * same treatment: re-run the recognizer against the source thumbnail,
 * overwrite the embedding + version tag in-place, leave the bbox and
 * landmarks alone.
 *
 * Why we re-embed from the thumbnail (not the original RAW):
 *
 *   - The face *stage* always embeds from the thumbnail (the stage
 *     handler reads `resolveThumbPathForAsset(asset, libraries)`), so
 *     re-embedding from the same source keeps the migration output
 *     bit-identical to what a fresh face-stage run would produce.
 *     Re-embedding from the RAW would shift the geometry (different
 *     aspect, different orientation handling) and the migration's
 *     output would diverge from new-asset output — fragmenting
 *     clusters yet again.
 *
 *   - Thumbnails are cached on disk and cheap to read; the RAW would
 *     need to decode through the FFI core, which is 100-1000× the cost.
 *
 * Why we re-use the stored bbox + landmarks (not re-detect):
 *
 *   - The detector model also changed (SCRFD-500m → SCRFD-10G), so a
 *     fresh detection run would produce slightly different bboxes and
 *     break the operator's existing `person_id` assignments (a face
 *     mapped to "Alice" might not be re-detected, or might be detected
 *     with a slightly different bbox that the assignment lookup can't
 *     match). The product invariant is: re-embed must NOT scramble the
 *     operator's manual assignments. Bumping the face stage's
 *     `targetVersion` is the separate "re-detect" path; it's
 *     intentionally a different operation.
 *
 *   - The bbox + landmarks from SCRFD-500m are perfectly serviceable
 *     inputs to the new alignment + recognizer. The recognizer cares
 *     about the *crop content*, not how it was selected.
 *
 *   - When the stored landmarks are absent (legacy face docs from
 *     before the detector emitted them), the alignment path falls back
 *     to a bbox-derived synthetic template and logs a warning. The
 *     embedding will be worse than a fresh-detection face, but it'll
 *     still be in the new embedding space.
 *
 * Streaming + bulk semantics:
 *
 *   - We cursor through assets that match the predicate so the working
 *     set stays bounded regardless of library size. The cursor projects
 *     just the fields the loop reads (`_id`, `maple_id`, `fileinfo`,
 *     `faces` — `resolveThumbPathForAsset` needs `maple_id` +
 *     `fileinfo[0]` to compute the content-addressed thumb path) and
 *     runs with `batchSize(50)` so memory is predictable on
 *     million-asset libraries.
 *   - For each asset, we re-embed every face that needs it, then issue
 *     ONE updateOne per asset that ONLY rewrites the embedding +
 *     embedding_version fields on the affected face indexes — never
 *     the whole faces array. This is load-bearing: an operator can
 *     call `assignFaceToPerson` or `hideFace` mid-migration, and a
 *     full-array rewrite would clobber their edits with our stale
 *     in-memory copy. Per-field updates with explicit field paths
 *     (`faces.<i>.embedding`, `faces.<i>.embedding_version`) leave
 *     `person_id`/`bbox`/`hidden`/`confidence` untouched.
 *
 * Cancellation: honours an `AbortSignal` so the route can wire it to
 * the client's connection close. Returns the partial counts on cancel.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { ObjectId } from 'mongodb';
import { assetsCollection } from '../../db/client.ts';
import type { AssetDoc, AssetFaceDoc } from '../../db/schema.ts';
import { resolveThumbPathForAsset } from '../../fs/xmp.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import {
  defaultFaceDetector,
  ThumbDecodeError,
  type FaceDetector,
} from '../../enrichment/face-detector.ts';
import {
  CURRENT_EMBEDDING_VERSION,
  LEGACY_EMBEDDING_VERSION,
} from '../../enrichment/face-models.ts';
import { child as childLogger } from '../../log.ts';

const log = childLogger('workers:re-embed-faces');

export interface ReEmbedFacesOptions {
  /** Cooperative cancellation. The job checks the signal between assets
   * so a long-running migration can be aborted by the route when the
   * client disconnects. */
  signal?: AbortSignal;
  /** Inject a fake detector for tests. Defaults to the singleton ONNX
   * detector. */
  detector?: FaceDetector;
  /** Cap the number of assets *visited* (matched by the predicate) in
   * one call — counts both successful updates and skipped assets. Stops
   * the cursor once `scannedAssets >= limit`. Defaults to no cap.
   * Useful for staged rollouts where the operator wants to see the
   * migration's effect on a sample without committing to the full pass. */
  limit?: number;
}

export interface ReEmbedFacesResult {
  /** Number of asset docs the cursor yielded — i.e. that matched the
   * selection predicate. An upper bound on every other counter. */
  scannedAssets: number;
  /** Number of assets that we successfully updated (i.e. at least one
   * face on the doc was re-embedded and persisted). Strictly less than
   * or equal to `scannedAssets`. */
  updatedAssets: number;
  /** Number of assets we couldn't progress on at all (thumb missing,
   * thumb unreadable, asset doc malformed). They stay in the predicate
   * so the next migration run will retry them. Subset of `scannedAssets`
   * disjoint from `updatedAssets`. */
  skippedAssets: number;
  /** Number of individual faces re-embedded. */
  reEmbeddedFaces: number;
  /** Faces that needed re-embedding but couldn't be processed (e.g.
   * thumbnail missing on disk, recognizer errored). They retain their
   * old embedding_version so the next migration run picks them up. */
  skippedFaces: number;
  /** Whether the run finished naturally or aborted via the signal. */
  aborted: boolean;
}

/** Walk every asset whose faces need re-embedding and rewrite them in
 * place. Idempotent — repeat calls on a fully-migrated DB return zeros.
 *
 * The match predicate uses `$or` with two clauses:
 *
 *   - `faces.embedding_version` doesn't exist
 *   - `faces.embedding_version` !== `CURRENT_EMBEDDING_VERSION`
 *
 * Together they capture every face produced by an older pipeline. The
 * cursor is projected to just the fields we read in the loop body
 * (`_id`, `abs_path`, `faces`) and batched at 50 docs so memory stays
 * predictable on large libraries. */
export async function reEmbedFaces(options: ReEmbedFacesOptions = {}): Promise<ReEmbedFacesResult> {
  const detector = options.detector ?? defaultFaceDetector();
  const signal = options.signal;
  const assets = await assetsCollection();
  const libraries = await loadLibraryRoots();

  let scannedAssets = 0;
  let updatedAssets = 0;
  let skippedAssets = 0;
  let reEmbeddedFaces = 0;
  let skippedFaces = 0;

  // Predicate: at least one face needs migrating. We can't use `$elemMatch`
  // on the existence check alone because absent fields are filtered out
  // of the per-element view, but the {field: {$exists: false}} sub-clause
  // inside $elemMatch works in Mongo 4+. Using two top-level conditions
  // joined by $or keeps the planner happy and is easy to reason about.
  //
  // Projection trims the doc to just what the loop reads — without it
  // every asset's full document (including arbitrary-sized `xmp`/`ocr`
  // payloads) crosses the wire. batchSize bounds the driver's prefetch
  // so a 1M-asset library doesn't balloon memory on a slow recognizer.
  const cursor = assets
    .find(
      {
        $or: [
          // Faces array exists AND has at least one entry without embedding_version.
          { faces: { $elemMatch: { embedding_version: { $exists: false } } } },
          // Faces array exists AND has at least one entry with a stale version.
          {
            faces: {
              $elemMatch: {
                embedding_version: {
                  $exists: true,
                  $ne: CURRENT_EMBEDDING_VERSION,
                },
              },
            },
          },
        ],
      },
      { projection: { _id: 1, maple_id: 1, fileinfo: 1, faces: 1 } },
    )
    .batchSize(50);

  for await (const raw of cursor) {
    if (signal?.aborted) {
      return {
        scannedAssets,
        updatedAssets,
        skippedAssets,
        reEmbeddedFaces,
        skippedFaces,
        aborted: true,
      };
    }
    scannedAssets += 1;
    const doc = raw as unknown as AssetDoc & { _id: ObjectId };
    const faces = doc.faces ?? [];
    if (faces.length === 0) continue;

    const thumbPath = resolveThumbPathForAsset(doc, libraries);
    if (!thumbPath) {
      // Asset lacks the maple_id/fileinfo[0] needed to compute a thumb
      // path, or its library_id isn't registered. The face stage skips
      // such assets the same way; this migration follows suit.
      log.warn(
        { _id: doc._id },
        'no resolvable thumb path; skipping (asset missing maple_id or library not registered)',
      );
      skippedFaces += faces.length;
      skippedAssets += 1;
      continue;
    }
    if (!existsSync(thumbPath)) {
      // Thumb missing — can't re-embed without it. The face stage's
      // dependency on thumb means this should be rare (only happens
      // when the thumb cache was manually purged), but we log + skip
      // rather than block the rest of the migration.
      log.warn(
        { _id: doc._id, thumbPath },
        "thumb missing; can't re-embed faces (will retry next run)",
      );
      // Count every stale face on this asset as skipped so the operator
      // sees the migration didn't progress on it.
      skippedFaces += faces.filter(needsReEmbed).length;
      skippedAssets += 1;
      continue;
    }

    let thumbBytes: Uint8Array;
    try {
      thumbBytes = new Uint8Array(await readFile(thumbPath));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ _id: doc._id, thumbPath, err: msg }, 'thumb read failed');
      skippedFaces += faces.filter(needsReEmbed).length;
      skippedAssets += 1;
      continue;
    }

    // Per-face $set patch so concurrent assignFaceToPerson / hideFace
    // edits aren't clobbered by writing back the whole faces array.
    // Mongo doesn't allow updating the same field path twice in a
    // single $set, but each face index is its own path so this is safe.
    const patch: Record<string, unknown> = {};
    let assetTouched = false;
    for (let i = 0; i < faces.length; i++) {
      const face = faces[i]!;
      if (!needsReEmbed(face)) continue;
      // Build a DetectedFace-shaped object for embedFace. Landmarks may
      // be missing on legacy docs — that's handled inside embedFace via
      // the synthetic-template fallback.
      const detection = {
        bbox: face.bbox,
        confidence: face.confidence,
        landmarks: extractLandmarks(face),
      };
      try {
        const embedding = await detector.embedFace(thumbBytes, detection);
        patch[`faces.${i}.embedding`] = Array.from(embedding);
        patch[`faces.${i}.embedding_version`] = CURRENT_EMBEDDING_VERSION;
        reEmbeddedFaces += 1;
        assetTouched = true;
      } catch (err) {
        // Permanent decode errors are non-retryable, transient ones we
        // log so the next run picks them up. Either way we don't touch
        // the face — it stays at its old embedding_version and the next
        // migration run sees it again.
        if (err instanceof ThumbDecodeError) {
          log.warn({ _id: doc._id, err: err.message }, "thumb undecodable; can't re-embed face");
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn({ _id: doc._id, err: msg }, 're-embed failed for face; keeping old embedding');
        }
        skippedFaces += 1;
      }
    }

    if (assetTouched) {
      updatedAssets += 1;
      // Per-field $set — leaves every other field (person_id, hidden,
      // bbox, confidence, plus any face we didn't touch) intact, so a
      // concurrent assignFaceToPerson() call running mid-migration is
      // preserved. The mongo updateOne is atomic per document, so even
      // a perfectly-timed concurrent edit either lands fully before
      // ours or fully after; what's lost is never a partial overwrite.
      await assets.updateOne({ _id: doc._id }, { $set: patch });
    }

    if (options.limit !== undefined && scannedAssets >= options.limit) {
      log.info({ limit: options.limit }, 're-embed-faces hit limit; stopping');
      break;
    }
  }

  log.info(
    {
      scannedAssets,
      updatedAssets,
      skippedAssets,
      reEmbeddedFaces,
      skippedFaces,
    },
    're-embed-faces finished',
  );
  return {
    scannedAssets,
    updatedAssets,
    skippedAssets,
    reEmbeddedFaces,
    skippedFaces,
    aborted: false,
  };
}

/** True iff this face's embedding is from a pipeline version older than
 * the current one. Missing field counts as "legacy" (the v1 pipeline
 * predates the field, so absent == `LEGACY_EMBEDDING_VERSION`). */
export function needsReEmbed(face: AssetFaceDoc): boolean {
  const v = face.embedding_version ?? LEGACY_EMBEDDING_VERSION;
  return v !== CURRENT_EMBEDDING_VERSION;
}

/** Recover the 5-point landmarks from an AssetFaceDoc. The current schema
 * doesn't carry landmarks on the face doc, so legacy docs always return
 * an empty array; the alignment path then falls back to the bbox-derived
 * synthetic template (with a logged quality warning).
 *
 * Future work: write landmarks back into the face doc so the next
 * re-embed migration has them. That's an additive schema change and a
 * separate ticket. */
function extractLandmarks(_face: AssetFaceDoc): Array<{ x: number; y: number }> {
  return [];
}
