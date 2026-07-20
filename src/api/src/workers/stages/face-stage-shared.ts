/**
 * Shared helpers for the `face-detect` and `face-embed` stages.
 *
 * Both stages read the same cached thumbnail (content-addressed, resolved
 * from the asset's primary `fileinfo` entry) and share the same skip
 * vocabulary for the "thumb missing / undecodable / unresolvable" cases.
 * Factored out so the two stage files stay small and can't drift on the
 * resolve-and-read contract.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { ImageDoc } from '../run-stage.ts';
import { resolveThumbPathForAsset } from '../../fs/xmp.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import { assetPrimaryFileInfo } from '../../indexer/images.repo.ts';
import { isUndecodableFilename } from '../../indexer/media-types.ts';

/** The thumbnail stage hasn't run yet, or the cached file was deleted. */
export const THUMB_MISSING_REASON = 'thumb-missing';

/** Cached thumbnail exists on disk but `sharp`/libvips can't decode it
 * (e.g. "VipsJpeg: Invalid SOS parameters"). Non-retryable — regenerating
 * the thumb would produce the same bytes. Skip-passes so the stage version
 * advances and we stop hammering bad inputs. */
export const THUMB_UNDECODABLE_REASON = 'thumb-undecodable';

/** Result of `loadThumbBytes`: either the decoded bytes, or a skip reason
 * that the caller hands straight back to the runtime as `{ skip }`. */
export type ThumbLoad = { bytes: Uint8Array } | { skip: string };

/**
 * Resolve the asset's content-addressed thumbnail path and read its bytes.
 *
 * Let `loadLibraryRoots()` errors propagate — a transient DB hiccup would
 * otherwise yield an empty libs map, which would make
 * `resolveThumbPathForAsset` return null and trip the no-resolvable-location
 * skip below. That skip writes `version = targetVersion` (see run-stage.ts),
 * permanently marking the stage done. By throwing, the runner's retry/backoff
 * path handles the transient case. Reserve `skip` for the genuine case:
 * libraries loaded fine, but the asset has no `fileinfo[0]` or its library is
 * unregistered.
 */
export async function loadThumbBytes(image: ImageDoc): Promise<ThumbLoad> {
  // Metadata-only stub images (eip/braw/afphoto/ai) and audio (mp3/wav/m4a/aac)
  // have no still frame for face detection/embedding. The thumb last-resort
  // path copies the source bytes verbatim, so the cached "thumb" for one of
  // these is the raw non-image container — not a JPEG. Handing those bytes to
  // the face pool throws "The object can not be cloned" on the IPC
  // postMessage, which dead-letters the asset after maxAttempts. Skip
  // terminally (skip advances the stage version), mirroring the describe /
  // preview / exif stages. Single source of truth — see
  // indexer/media-types.ts.
  //
  // Video is no longer in this set (#1649) — its thumb is now a real
  // poster-frame AVIF, so faces in a clip's opening second are detected and
  // clustered like any still's. Without a host ffmpeg no thumb is written at
  // all and the `THUMB_MISSING_REASON` branch below skips, so the face pool
  // still never sees container bytes.
  const primary = assetPrimaryFileInfo(image);
  if (primary && isUndecodableFilename(primary.filename)) {
    return { skip: 'stub-file' };
  }

  const libs = await loadLibraryRoots();
  const thumbPath = resolveThumbPathForAsset(image as never, libs);
  if (!thumbPath) {
    return { skip: 'no-resolvable-location' };
  }
  if (!existsSync(thumbPath)) {
    return { skip: `${THUMB_MISSING_REASON}: ${thumbPath}` };
  }
  return { bytes: new Uint8Array(await readFile(thumbPath)) };
}
