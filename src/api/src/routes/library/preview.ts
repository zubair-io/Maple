/**
 * GET /api/preview/:slug/*
 *
 * Returns a long-edge 1280 AVIF preview for an indexed image.
 * ETag: "<maple_id>_1280", Cache-Control: public, max-age=31536000, immutable.
 * Honors If-None-Match for 304 responses. ETag stays `maple_id`-based (an
 * opaque validator, not the cache key) even though the file itself is now
 * path-keyed — see `cachePathForAsset`'s doc in `fs/xmp.ts`.
 *
 * Uses `cachePathForAsset(asset, libs, 'previews', PREVIEW_CACHE_SUFFIX)` —
 * the same path as the existing preview stage — so the cache is shared
 * between the background stage and on-demand generation from this route.
 */

import { Elysia, t } from "elysia";
import { resolveAddress } from "../../library/address.ts";
import { child as childLogger } from "../../log.ts";
import { ifNoneMatchEqual } from "../../runtime/http-etag.ts";
import { cachePathForAsset } from "../../fs/xmp.ts";
import { loadLibraryRoots } from "../../indexer/libraries.cache.ts";
import {
  generatePreview,
  PREVIEW_CACHE_SUFFIX,
} from "../../indexer/previewer.ts";
import {
  safeStat,
  safeReadBytes,
  IMMUTABLE_CACHE,
  findAssetByAddress,
  parseWildcardSegments,
  developedPreviewResponse,
} from "./shared.ts";

const log = childLogger("routes/library/preview");

export const previewRoutes = new Elysia().get(
  "/preview/:slug/*",
  // Pre-existing M1-route complexity (wildcard parse, address resolve,
  // indexing-202, ETag/304, on-demand generate + serve). This PR adds only a
  // thin developed-preview branch (one `developedPreviewResponse` helper call).
  // fallow-ignore-next-line complexity
  async ({ params, headers, set }) => {
    const slug = params.slug;
    const wildcard = (params as Record<string, string>)["*"] ?? "";
    const segments = parseWildcardSegments(wildcard);

    const allSegs = segments;
    const filename = allSegs[allSegs.length - 1] ?? "";
    if (!filename) {
      set.status = 400;
      return { error: "Filename is required" };
    }
    const dirSegs = allSegs.slice(0, -1);
    const relDir = dirSegs.join("/");
    const fileRelPath = dirSegs.length > 0 ? `${relDir}/${filename}` : filename;

    let resolved: Awaited<ReturnType<typeof resolveAddress>>;
    try {
      resolved = await resolveAddress(slug, fileRelPath);
    } catch (err) {
      const e = err as { status?: number; message?: string };
      set.status = e.status ?? 500;
      return { error: e.message ?? "Internal error" };
    }

    const { libraryId, absPath } = resolved;

    const asset = await findAssetByAddress(libraryId, relDir, filename);

    if (!asset || !asset.maple_id) {
      const diskSt = await safeStat(absPath);
      if (!diskSt) {
        set.status = 404;
        return { error: "File not found" };
      }
      set.status = 202;
      set.headers["Retry-After"] = "2";
      return {
        status: "indexing",
        message: "Image not yet indexed; retry shortly",
      };
    }

    const ifNoneMatch = headers["if-none-match"];
    const libs = await loadLibraryRoots();

    // Developed preview for edited assets (#1950): when the `display-preview`
    // stage has rendered `<maple_id>_dev_<sidecar_ver>.jpg`, serve that — it
    // reflects the sidecar's edits, unlike the embedded 1280 preview below.
    // ETag folds in `sidecar_ver` so a new edit busts client caches. Null →
    // unedited or not-yet-rendered; fall through to the embedded preview.
    const sidecarVer = (asset.sidecar_ver as number | undefined) ?? 0;
    const developed = await developedPreviewResponse(
      asset,
      libs,
      `"${asset.maple_id}_dev_${sidecarVer}"`,
      IMMUTABLE_CACHE,
      ifNoneMatch,
    );
    if (developed) return developed;

    const etag = `"${asset.maple_id}_1280"`;
    if (
      ifNoneMatchEqual(
        typeof ifNoneMatch === "string" ? ifNoneMatch : undefined,
        etag,
      )
    ) {
      return new Response(null, {
        status: 304,
        headers: { ETag: etag, "Cache-Control": IMMUTABLE_CACHE },
      });
    }

    const previewPath = cachePathForAsset(
      { maple_id: asset.maple_id as string, fileinfo: asset.fileinfo as never },
      libs,
      "previews",
      PREVIEW_CACHE_SUFFIX,
    );
    if (!previewPath) {
      set.status = 404;
      return { error: "Cannot resolve preview path for this asset" };
    }

    const previewSt = await safeStat(previewPath);
    if (!previewSt) {
      try {
        await generatePreview(absPath, previewPath);
      } catch (err) {
        log.warn(
          {
            absPath,
            previewPath,
            err: err instanceof Error ? err.message : err,
          },
          "on-demand preview generation failed",
        );
        set.status = 500;
        return { error: "Preview generation failed" };
      }
    }

    const bytes = await safeReadBytes(previewPath);
    if (!bytes) {
      set.status = 404;
      return { error: "Preview file unreadable" };
    }

    return new Response(bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "image/avif",
        ETag: etag,
        "Cache-Control": IMMUTABLE_CACHE,
      },
    });
  },
  {
    params: t.Object({
      slug: t.String({ minLength: 1 }),
      "*": t.Optional(t.String()),
    }),
  },
);
