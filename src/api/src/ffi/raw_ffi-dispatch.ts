/**
 * FFI child request dispatch — the per-type arms behind `raw_ffi.child.ts`.
 *
 * Split from the child entry so the dispatch can be unit-tested: importing
 * the child registers a `process.on('message')` listener and installs the
 * child hardening (nice + parent watch), neither of which belongs in a test.
 * This module has no import-time side effects; the lens-profile binding it
 * reaches for opens the dylib lazily, on first use, inside the arms that
 * need it.
 */

import type { RawFfi } from './raw_ffi.ts';
import type { FfiRejectedResponse, FfiRequest, FfiResponse } from './raw_ffi-protocol.ts';
import { readFile } from '../fs/mirrored.ts';
import { clearLensProfiles, registerLensProfile } from '../lens-profiles/native.ts';
import { restoreLensProfile } from '../lens-profiles/restore.ts';

/**
 * Dispatch one IPC request against the loaded native binding. One arm per
 * `FfiRequest` variant — every arm is guarded by its own `type` check and the
 * tail is a default arm, never an implicit fallback: the histogram arm used
 * to be unlabeled, so a request of any unrecognised type was rendered as a
 * histogram and answered with `type: 'histogram'`, which the caller's
 * response matcher then ignored (its promise hung forever — see
 * `ffi-pool.ts`). The TypeScript `never` check on the default arm makes a
 * new protocol variant without a matching arm a compile error as well.
 *
 * `ffi` is injected (rather than read from the module) so the arms can be
 * driven by a fake binding in tests without the dylib.
 */
// One arm per FFI message type; the arm count is inherent to the protocol.
// fallow-ignore-next-line complexity
export async function handleFfiRequest(
  ffi: RawFfi | null,
  req: FfiRequest,
): Promise<FfiResponse | FfiRejectedResponse> {
  if (!ffi) {
    return {
      type: req.type,
      id: req.id,
      ok: false,
      error: 'raw-ffi dylib not loaded in child',
    };
  }

  if (req.type === 'exportRecipe') {
    // The export snapshot carries its sidecar inline; restore the profile it
    // selects exactly as the develop/histogram paths below do, so a queued
    // export renders the same optical correction the editor showed.
    await restoreLensProfile(req.rawPath, req.xmp || null);
    const error =
      ffi.exportRecipeToFile?.(req.rawPath, req.xmp, req.recipeJson, req.filmPath, req.outPath) ??
      (ffi.exportRecipeToFile ? null : 'Rebuild raw-ffi: recipe encoder unavailable');
    return {
      type: req.type,
      id: req.id,
      ok: !error,
      error: error ?? undefined,
    };
  }
  if (req.type === 'asShot') {
    const baseline = ffi.asShotWhiteBalance(req.rawPath);
    return baseline
      ? { type: 'asShot', id: req.id, ok: true, baseline }
      : {
          type: 'asShot',
          id: req.id,
          ok: false,
          error: 'Cannot decode camera as-shot white balance',
        };
  }

  if (req.type === 'registerLensProfile') {
    clearLensProfiles();
    const inventory = registerLensProfile(await readFile(req.profilePath));
    return { type: req.type, id: req.id, ok: true, inventory };
  }
  if (req.type === 'renderDevelop' || req.type === 'histogram') {
    const xml = req.xmpPath ? await readFile(req.xmpPath, 'utf8') : null;
    await restoreLensProfile(req.rawPath, xml);
  }

  if (req.type === 'renderThumb') {
    const ok = ffi.renderThumbnailAvifToFile(req.rawPath, req.outPath, req.maxPx, req.quality);
    return {
      type: 'renderThumb',
      id: req.id,
      ok,
      error: ok ? undefined : 'render-failed (see child stderr)',
    };
  }

  if (req.type === 'renderPreviewJpeg') {
    const ok = ffi.renderThumbnailPreviewJpegToFile(
      req.rawPath,
      req.outPath,
      req.maxPx,
      req.quality,
    );
    return {
      type: 'renderPreviewJpeg',
      id: req.id,
      ok,
      error: ok ? undefined : 'render-failed (see child stderr)',
    };
  }

  if (req.type === 'renderDevelop') {
    // Full develop with the sidecar applied → JPEG to disk. Like renderThumb,
    // the heavy pixel buffer never crosses the FFI/IPC boundary — Rust writes
    // the file and we return only ok/error.
    const ok = ffi.renderDevelopJpegToFile(
      req.rawPath,
      req.xmpPath ?? null,
      req.outPath,
      req.maxPx,
      req.quality,
    );
    return {
      type: 'renderDevelop',
      id: req.id,
      ok,
      error: ok ? undefined : 'render-failed (see child stderr)',
    };
  }

  if (req.type === 'histogram') {
    // render-with-xmp + bin entirely in Rust; only the 3×256 counts (~3 KB)
    // come back across the FFI boundary into a JS-owned buffer (no pixel
    // buffer ever crosses), then across IPC. See `maple_histogram_file`.
    const bins = ffi.computeHistogramBins(req.rawPath, req.xmpPath ?? null);
    if (!bins) {
      return {
        type: 'histogram',
        id: req.id,
        ok: false,
        error: 'render-failed (see child stderr)',
      };
    }
    return { type: 'histogram', id: req.id, ok: true, bins };
  }

  // Default arm. `req` is `never` here at compile time; at runtime it is a
  // payload whose `type` passed no arm above (the wire guard in
  // `coerceFfiRequest` normally stops these earlier).
  const unhandled: never = req;
  const { type, id } = unhandled as { type: string; id: number };
  return { type, id, ok: false, error: `unknown request type '${type}'` };
}
