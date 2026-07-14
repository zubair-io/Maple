// src/api/src/routes/fs-previews.ts
//
// GET /api/fs/preview?path=<abs-path-to-image>
//   Returns the display-resolution (1280 px long-edge) `image/avif` preview
//   for the image at `path` — the path-addressed sibling of `/api/fs/thumb`
//   for clients that browse by absolute path (the Apple `CloudSource` /
//   `CloudThumbClient` fs-walk flow). `/api/fs/thumb` cannot serve this tier:
//   it keeps ONE cache file per RAW with an mtime-only freshness check, so a
//   `size=2048` request just returns the cached 512 px grid thumb.
//
//   Cache: `.maple/previews/` next to the image. When the indexer has an
//   asset row for this file, the path-keyed `<filename>.1280.avif` written
//   by the background `preview` stage is used — shared artifact, no
//   duplicate render (no `maple_id` needed, unlike thumbs — see
//   `cachePathForAsset`'s doc). Un-indexed files (no DB row yet, or DB
//   unreachable) fall back to the legacy basename-keyed
//   `<basename_no_ext>_1280.avif` and are generated on demand via the same
//   `generatePreview` the stage uses (which also owns the mtime staleness
//   check).
//
// Auth: this Elysia plugin must be `.use()`d AFTER `requireAuth` in
// `index.ts` so callers must present a valid bearer.
//
// Jail: same `MAPLE_ROOTS` policy as `/api/fs/thumb`, via the shared
// `resolveJailedFile` preamble in fs-jail.ts.

import { Elysia, t } from "elysia";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { ObjectId } from "mongodb";
import { isUnderRoot } from "../fs/browse.ts";
import { cachePathFor, cachePathForAsset } from "../fs/xmp.ts";
import { loadLibraryRoots } from "../indexer/libraries.cache.ts";
import { generatePreview, PREVIEW_CACHE_SUFFIX } from "../indexer/previewer.ts";
import { isDbConnected } from "../db/client.ts";
import {
  findAssetByAddress,
  developedPreviewResponse,
} from "./library/shared.ts";
import {
  resolveJailedFile,
  sourceETag,
  notModifiedResponse,
} from "./fs-jail.ts";
import { child as childLogger } from "../log.ts";

const log = childLogger("fs-previews");

const CACHE_CONTROL = "private, max-age=3600";

/**
 * Split `real` into (libraryIdHex, relDir, filename) against the registered
 * library roots. Returns null when `real` is not under any registered
 * library (e.g. a MAPLE_ROOTS browse path that isn't an indexed library).
 * Pure over the roots map — exported for unit tests.
 */
export function libraryAddressFor(
  real: string,
  roots: ReadonlyMap<string, string>,
): { libraryIdHex: string; relDir: string; filename: string } | null {
  for (const [libraryIdHex, root] of roots) {
    const r = root.replace(/\/$/, "") || "/";
    if (!isUnderRoot(real, r)) continue;
    const rel = r === "/" ? real.slice(1) : real.slice(r.length + 1);
    const dir = path.dirname(rel);
    return {
      libraryIdHex,
      relDir: dir === "." ? "" : dir,
      filename: path.basename(rel),
    };
  }
  return null;
}

/**
 * Resolve the on-disk preview cache path for `real`. Prefers the indexer's
 * path-keyed `<filename>.1280.avif` (needs only an asset row with `fileinfo`,
 * not `maple_id` — see `cachePathForAsset`'s doc); falls back to the legacy
 * basename-keyed path when there's no asset row at all yet. The DB lookup is
 * best-effort — any failure (lookup error, DB down) degrades to the legacy
 * path rather than failing the request.
 */
async function resolvePreviewCachePath(real: string): Promise<string> {
  const legacy = () => cachePathFor(real, "previews", PREVIEW_CACHE_SUFFIX);
  // `lookupAssetByReal` is a no-op when Mongo isn't connected — attempting a
  // lookup while it's down would eat the driver's 5 s server-selection timeout
  // on EVERY request; the legacy basename path serves immediately instead
  // (Copilot review, PR #1907).
  try {
    const asset = await lookupAssetByReal(real);
    if (asset) {
      const libs = await loadLibraryRoots();
      const pathKeyed = cachePathForAsset(
        {
          maple_id: asset.maple_id as string | undefined,
          fileinfo: asset.fileinfo as never,
        },
        libs,
        "previews",
        PREVIEW_CACHE_SUFFIX,
      );
      if (pathKeyed) return pathKeyed;
    }
  } catch (err) {
    log.debug(
      { real, err: err instanceof Error ? err.message : err },
      "asset lookup failed; using legacy basename-keyed preview path",
    );
  }
  return legacy();
}

/** Look up the indexed asset for a symlink-resolved path, or null (un-indexed
 * / DB down / no matching library). Shared by the developed-preview branch and
 * `resolvePreviewCachePath`. */
async function lookupAssetByReal(real: string) {
  if (!isDbConnected()) return null;
  const libs = await loadLibraryRoots();
  const addr = libraryAddressFor(real, libs);
  if (!addr) return null;
  return findAssetByAddress(
    new ObjectId(addr.libraryIdHex),
    addr.relDir,
    addr.filename,
  );
}

export const fsPreviewsRoutes = new Elysia({ prefix: "/api/fs" }).get(
  "/preview",
  async ({ query, headers, set }) => {
    const resolved = await resolveJailedFile(query.path);
    if (!resolved.ok) {
      set.status = resolved.status;
      return { error: resolved.error };
    }
    const { real, stat: srcStat } = resolved;

    // Prefer the developed preview for edited assets; fall back to embedded.
    // The ETag folds in `sidecar_ver` (the RAW's mtime doesn't change on edit,
    // so the source ETag alone would be stale across edits).
    const asset = await lookupAssetByReal(real).catch(() => null);
    if (asset) {
      const libs = await loadLibraryRoots();
      const ver = (asset.sidecar_ver as number | undefined) ?? 0;
      const devEtag = `"${Math.floor(Number(srcStat.mtimeMs))}-${Number(srcStat.size)}-dev${ver}"`;
      const developed = await developedPreviewResponse(
        asset,
        libs,
        devEtag,
        CACHE_CONTROL,
        headers["if-none-match"],
      );
      if (developed) return developed;
    }

    const etag = sourceETag(srcStat);
    const cached304 = notModifiedResponse(
      headers["if-none-match"],
      etag,
      CACHE_CONTROL,
    );
    if (cached304) return cached304;

    const previewPath = await resolvePreviewCachePath(real);

    // `generatePreview` owns mkdir, the mtime staleness check (fresh cache →
    // fast return), and the RAW-FFI / sharp / PSD render dispatch. It logs
    // failures instead of throwing; a missing output file below is the
    // failure signal.
    await generatePreview(real, previewPath);

    let bytes: Buffer;
    try {
      bytes = await readFile(previewPath);
    } catch (err) {
      log.warn(
        { real, previewPath, err: err instanceof Error ? err.message : err },
        "preview generation produced no readable file",
      );
      set.status = 500;
      return { error: "Preview generation failed (see server log)" };
    }

    // `Buffer` extends `Uint8Array`, which Bun's `Response` accepts directly
    // — no ArrayBuffer copy needed (Jules review, PR #1907). The cast is
    // type-level only: TS's DOM `BodyInit` excludes Buffer's ArrayBufferLike
    // backing, but the bytes are passed through zero-copy at runtime.
    return new Response(bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "image/avif",
        "Cache-Control": CACHE_CONTROL,
        ETag: etag,
      },
    });
  },
  {
    query: t.Object({
      path: t.String({ minLength: 1 }),
    }),
  },
);
