/**
 * Decode-based validation for AVIF cache derivatives (thumbs + previews).
 *
 * `indexer/thumbnailer.ts` and `indexer/previewer.ts` both write through
 * `ffiPool().renderThumbnailAvifToFile` (Rust) or `renderImageThumbToFileViaPool`
 * (sharp, via the isolated `imgdecode` child) to encode a resized AVIF. Both
 * of those encoders already write atomically (temp file + rename) internally,
 * so a crash or `ENOSPC` mid-write can't leave a half-written file at the
 * final cache path. What neither encoder validates is the CONTENT of what it
 * successfully wrote: a completed-but-corrupt encode (a codec edge case, a
 * resize bug, a source silently mis-decoded) can still finish writing and get
 * renamed into place looking like a good cache entry.
 *
 * `validateAvifOutput` closes that gap with a real decode — dispatched to the
 * isolated `imgdecode` child via `validateAvifViaPool` (#2257). It used to run
 * `sharp(filePath)` directly in THIS (the API parent) process, which added a
 * full pixel decode to every concurrent request while the thumb/preview
 * stages were running (~300ms measured on an SMB-backed library) and, worse,
 * ran a decode of a freshly-written, possibly-malformed file — exactly the
 * input most likely to trip a libheif/libvips crash — inside the HTTP server
 * (see `imgdecode-pool.ts`'s "Why off-PROCESS" module doc). The actual check
 * semantics (format/dimensions/orientation/colourspace/full-decode) now live
 * in `thumbs/avif-checks.ts`, imported only by the child
 * (`imgdecode.child.ts`) — this file stays importable from the parent
 * without pulling sharp (and libvips/libheif) into its address space.
 *
 * `publishValidatedAvif` is the write-side half: given bytes already encoded
 * to a private temp path, it validates them and only then renames into the
 * real cache path — the same write-to-temp-then-rename idiom as
 * `fs/xmp.ts`'s `writeXmpWithPrecondition`, gated on decode success rather
 * than only on the write itself succeeding. On failure (a failed check, OR a
 * dispatch failure — the child failed to spawn, or crashed mid-decode) it
 * removes the temp file, so nothing invalid — and nothing merely unverified —
 * is ever left where a reader expects a good cache entry.
 */

import * as fs from 'node:fs/promises';
import type { Logger } from 'pino';
import { validateAvifViaPool } from './imgdecode-pool.ts';
import type { AvifValidationResult } from './avif-checks.ts';

// Re-exported (not redefined) so the parent-side public surface keeps this
// name: `AvifValidationResult` is the one shape both the child's pure
// predicate (`avif-checks.ts#checkAvifOutput`) and this dispatcher return —
// a second, separately-declared copy here would be an ambiguous duplicate
// export of the same name across two modules for no reason. Type-only, so
// this does NOT create the sharp-in-the-parent import this file's module doc
// warns against, and no cycle: `avif-checks.ts` has no import of anything
// that leads back here.
export type { AvifValidationResult };

export type AvifTier = 'preview' | 'thumb';

export interface AvifValidationContext {
  /** Absolute path of the SOURCE asset this derivative was generated from. */
  assetPath: string;
  tier: AvifTier;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Decode `filePath` via the isolated imgdecode child and confirm it's a
 * genuine, complete, correctly-sized AVIF matching this pipeline's encode
 * conventions — see `thumbs/avif-checks.ts#checkAvifOutput` for the actual
 * check semantics (format/dimensions/orientation/colourspace/full-decode,
 * cheapest-first).
 *
 * A dispatch failure — the child failed to spawn, or crashed while decoding
 * this specific (possibly poison) file — is caught here and reported as a
 * validation failure rather than thrown, so callers (`publishValidatedAvif`)
 * uniformly discard the temp file and never publish on either kind of
 * failure. This mirrors how `indexer/thumbnailer.ts#renderBitmapThumbToFile`
 * treats a `renderImageThumbToFileViaPool` rejection: caught, logged, and
 * turned into "this attempt failed," never allowed to propagate as an
 * unhandled rejection out of the stage.
 */
export async function validateAvifOutput(
  filePath: string,
  expectedLongEdgePx: number,
): Promise<AvifValidationResult> {
  try {
    const result = await validateAvifViaPool(filePath, expectedLongEdgePx);
    return result.ok
      ? { ok: true }
      : { ok: false, reason: result.reason ?? 'validation failed with no reason reported' };
  } catch (e) {
    return { ok: false, reason: `validation dispatch failed: ${errMessage(e)}` };
  }
}

/**
 * Validate `tmpPath` (an AVIF the caller just encoded to a private temp
 * path) and, only if it passes, atomically publish it to `finalPath` via
 * rename. On any failure — validation or the rename itself — `tmpPath` is
 * removed so nothing invalid is ever left at `finalPath`, and the failure is
 * logged with `context` (asset, tier, which check failed) for triage.
 */
export async function publishValidatedAvif(
  tmpPath: string,
  finalPath: string,
  expectedLongEdgePx: number,
  log: Logger,
  context: AvifValidationContext,
): Promise<boolean> {
  const validation = await validateAvifOutput(tmpPath, expectedLongEdgePx);
  if (!validation.ok) {
    await unlinkQuiet(tmpPath);
    log.warn(
      { assetPath: context.assetPath, tier: context.tier, finalPath, reason: validation.reason },
      'avif validation failed — discarding',
    );
    return false;
  }

  try {
    await fs.rename(tmpPath, finalPath);
    return true;
  } catch (e) {
    await unlinkQuiet(tmpPath);
    log.warn(
      { assetPath: context.assetPath, tier: context.tier, finalPath, err: errMessage(e) },
      'avif publish rename failed',
    );
    return false;
  }
}

/**
 * Shared by `previewer.ts`/`thumbnailer.ts` after every render branch
 * (RAW-FFI, sharp bitmap, or thumbnailer's last-resort copy fallback) has
 * attempted to write `tmpPath`: if the render itself failed, discard
 * `tmpPath`; if it succeeded, hand off to `publishValidatedAvif`. Returns
 * whether a good AVIF now exists at `finalPath`.
 */
export async function finalizeAvifRender(
  renderOk: boolean,
  tmpPath: string,
  finalPath: string,
  expectedLongEdgePx: number,
  log: Logger,
  context: AvifValidationContext,
): Promise<boolean> {
  if (!renderOk) {
    await unlinkQuiet(tmpPath);
    return false;
  }
  return publishValidatedAvif(tmpPath, finalPath, expectedLongEdgePx, log, context);
}

async function unlinkQuiet(p: string): Promise<void> {
  try {
    await fs.unlink(p);
  } catch {
    // best-effort — nothing to clean up, or already gone.
  }
}
