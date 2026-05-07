// src/api/src/routes/fs-thumbs.ts
//
// GET /api/fs/thumb?path=<abs-path-to-raw>&size=512
//   Returns an `image/jpeg` thumbnail for a RAW file at `path`. Caches the
//   result on disk under `<dir>/.maple/thumbs/<basename>_<size>.jpg`. Stale
//   thumbs (older than the RAW) are regenerated.
//
// Lives in a separate file from `fs.ts` so the directory-listing endpoint
// (parallel work) and the thumb endpoint can be edited independently.
//
// Auth: this Elysia plugin must be `.use()`d AFTER `requireAuth` in
// `index.ts` so callers must present a valid bearer.
//
// Jail: same `MAPLE_ROOTS` policy as `routes/fs.ts` — paths are realpath-
// resolved and rejected if they fall outside any allowed root.

import { Elysia, t } from "elysia";
import { stat, readFile, realpath, mkdir } from "node:fs/promises";
import * as path from "node:path";
import { browseRoots, isUnderRoot, RAW_EXTENSIONS } from "../fs/browse.ts";
import { resolveThumbPath } from "../fs/xmp.ts";
import { ffiPool } from "../ffi/ffi-pool.ts";
import { renderImageThumbToFile, SHARP_EXTENSIONS } from "../thumbs/render.ts";

const DEFAULT_SIZE_PX = 512;
const MIN_SIZE_PX = 16;
const MAX_SIZE_PX = 4096;

export const fsThumbsRoutes = new Elysia({ prefix: "/api/fs" }).get(
  "/thumb",
  async ({ query, set }) => {
    const reqPath = query.path;
    const sizeStr = query.size ?? String(DEFAULT_SIZE_PX);
    const sizePx = Number.parseInt(sizeStr, 10);

    if (
      !Number.isFinite(sizePx) ||
      sizePx < MIN_SIZE_PX ||
      sizePx > MAX_SIZE_PX
    ) {
      set.status = 400;
      return {
        error: `size must be an integer in [${MIN_SIZE_PX}, ${MAX_SIZE_PX}]`,
      };
    }

    if (!path.isAbsolute(reqPath)) {
      set.status = 400;
      return { error: "path must be absolute" };
    }

    // Resolve symlinks so the jail check matches the parent realpath form
    // (mirrors `listDirContents` behaviour on macOS where /var → /private/var).
    let real: string;
    try {
      real = await realpath(reqPath);
    } catch (err) {
      set.status = 404;
      return {
        error: `Cannot access "${reqPath}": ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const roots = await browseRoots();
    if (!roots.some((r) => isUnderRoot(real, r))) {
      set.status = 403;
      return {
        error: `Path "${real}" is outside MAPLE_ROOTS [${roots.join(", ")}]`,
      };
    }

    // Extension gate — RAW formats go through the FFI pipeline; common
    // bitmap formats (JPG/HEIC/PNG/WEBP/TIFF/AVIF) go through sharp.
    // Anything else 415s so the FFI never blocks on a 50 GB Word doc.
    const dot = real.lastIndexOf(".");
    const ext = dot >= 0 ? real.slice(dot + 1).toLowerCase() : "";
    const isRaw = RAW_EXTENSIONS.has(ext);
    const isSharp = SHARP_EXTENSIONS.has(ext);
    if (!isRaw && !isSharp) {
      set.status = 415;
      return { error: `Unsupported file extension: "${ext}"` };
    }

    // Stat the RAW. Used both for staleness check and for the ETag.
    let rawStat: Awaited<ReturnType<typeof stat>>;
    try {
      rawStat = await stat(real);
    } catch (err) {
      set.status = 404;
      return {
        error: `Cannot stat "${real}": ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!rawStat.isFile()) {
      set.status = 400;
      return { error: `"${real}" is not a regular file` };
    }

    // One thumb per RAW (matches Apple ThumbnailDiskCache + web
    // MapleCacheService). The `size` query param controls the RENDER
    // target — re-rendering at a different size overwrites the same
    // cache entry. Stale-check is mtime-based, so a size change that
    // happens after the cache file was written will look fresh until
    // the RAW itself is touched. For browse-grid use, 512px is the
    // pinned target so this is effectively cosmetic.
    const thumbPath = resolveThumbPath(real);

    const rawMtimeMs = rawStat.mtimeMs;
    const etag = `"${Math.floor(rawMtimeMs)}"`;

    // If-None-Match handling — return 304 when the client already has the
    // freshest thumb. (Optional but cheap.)
    // Note: Elysia query/header access uses Web standard request shape,
    // but we don't have direct access here without `request` — keep this
    // simple and just always serve bytes. Frontend cache will use the
    // Cache-Control: max-age path.

    let thumbStat: Awaited<ReturnType<typeof stat>> | null = null;
    try {
      thumbStat = await stat(thumbPath);
    } catch {
      thumbStat = null;
    }

    const fresh = thumbStat !== null && thumbStat.mtimeMs >= rawMtimeMs;

    if (fresh) {
      try {
        const bytes = await readFile(thumbPath);
        set.headers["Content-Type"] = "image/jpeg";
        set.headers["Cache-Control"] = "private, max-age=3600";
        set.headers["ETag"] = etag;
        set.headers["X-Thumb-Cache"] = "hit";
        return bytes;
      } catch (err) {
        // Fall through to regen if read fails (e.g. file disappeared
        // between stat and readFile).
        console.warn(
          `[fs-thumbs] read of cached thumb at "${thumbPath}" failed; regenerating:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Ensure the cache dir exists before handing the path to either
    // renderer. Both write atomically (.tmp + rename) so the parent dir
    // must already be writable.
    try {
      await mkdir(path.dirname(thumbPath), { recursive: true });
    } catch (err) {
      set.status = 500;
      return {
        error: `Cannot create thumb cache dir: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (isSharp) {
      try {
        await renderImageThumbToFile(real, thumbPath, sizePx, ext);
      } catch (err) {
        set.status = 500;
        return {
          error: `sharp render failed for ${ext}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    } else {
      // RAW formats: native libraw via the FFI worker pool.
      const pool = ffiPool();
      if (!pool.available()) {
        set.status = 503;
        return {
          error:
            "Thumbnail FFI not built — run scripts/build-raw-ffi.sh to build native/libraw_ffi.* first",
        };
      }
      let ok = false;
      try {
        ok = await pool.renderThumbnailJpegToFile(real, thumbPath, sizePx, 82);
      } catch (err) {
        set.status = 500;
        return {
          error: `FFI worker error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (!ok) {
        set.status = 500;
        return { error: "Thumbnail render failed (see server log)" };
      }
    }

    // Read the freshly written file back to serve. Cheap (thumbs <100 KB).
    let bytes: Buffer;
    try {
      bytes = await readFile(thumbPath);
    } catch (err) {
      set.status = 500;
      return {
        error: `Read of just-written thumb failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Bun's `Response` body type narrowing — pass the raw bytes via the
    // shared ArrayBuffer slice, which it accepts cleanly.
    const ab = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    return new Response(ab, {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "private, max-age=3600",
        ETag: etag,
        "X-Thumb-Cache": "miss",
      },
    });
  },
  {
    query: t.Object({
      path: t.String({ minLength: 1 }),
      size: t.Optional(t.String()),
    }),
  },
);
