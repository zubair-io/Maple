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

import { Elysia, t } from 'elysia';
import { stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { RAW_EXTENSIONS } from '../fs/browse.ts';
import { resolveThumbPath } from '../fs/xmp.ts';
import { ffiPool } from '../ffi/ffi-pool.ts';
import { renderImageThumbToFile } from '../thumbs/imgdecode-pool.ts';
import { applyExifOrientationInPlace } from '../thumbs/apply-orientation.ts';
import { child as childLogger } from '../log.ts';
import { resolveJailedFile, sourceETag, notModifiedResponse } from './fs-jail.ts';

const log = childLogger('fs-thumbs');

const DEFAULT_SIZE_PX = 512;
const MIN_SIZE_PX = 16;
const MAX_SIZE_PX = 4096;

export const fsThumbsRoutes = new Elysia({ prefix: '/api/fs' }).get(
  '/thumb',
  // Pre-existing CRITICAL complexity (RAW/sharp/PSD-HDR dispatch, ETag,
  // cache-freshness, and FFI-vs-imgdecode branches all live in this one
  // route handler). Out of scope to decompose here — this PR only adds
  // one more extension branch (collapsed into `renderViaImgdecode` above
  // to avoid growing it further). Worth splitting into smaller helpers
  // as a dedicated follow-up.
  // fallow-ignore-next-line complexity
  async ({ query, headers, set }) => {
    const reqPath = query.path;
    const sizeStr = query.size ?? String(DEFAULT_SIZE_PX);
    const sizePx = Number.parseInt(sizeStr, 10);

    if (!Number.isFinite(sizePx) || sizePx < MIN_SIZE_PX || sizePx > MAX_SIZE_PX) {
      set.status = 400;
      return {
        error: `size must be an integer in [${MIN_SIZE_PX}, ${MAX_SIZE_PX}]`,
      };
    }

    // Shared absolute-path / realpath-jail / extension-gate / stat preamble
    // (fs-jail.ts — also used by /api/fs/preview).
    const resolved = await resolveJailedFile(reqPath);
    if (!resolved.ok) {
      set.status = resolved.status;
      return { error: resolved.error };
    }
    const { real, ext, stat: rawStat } = resolved;

    // Dispatch — RAW formats go through the FFI pipeline; sharp-native
    // bitmaps (JPG/HEIC/PNG/WEBP/TIFF/AVIF) and PSD/PSB/HDR (first decoded
    // via ag-psd/hdr, then handed to sharp) both go through
    // `renderImageThumbToFile` below — collapsed into one flag so the
    // dispatch reads as a single two-way branch.
    const renderViaImgdecode = !RAW_EXTENSIONS.has(ext);

    // One thumb per RAW (matches Apple ThumbnailDiskCache + web
    // MapleCacheService). The `size` query param controls the RENDER
    // target — re-rendering at a different size overwrites the same
    // cache entry. Stale-check is mtime-based, so a size change that
    // happens after the cache file was written will look fresh until
    // the RAW itself is touched. For browse-grid use, 512px is the
    // pinned target so this is effectively cosmetic.
    const thumbPath = resolveThumbPath(real);

    const rawMtimeMs = rawStat.mtimeMs;
    const etag = sourceETag(rawStat);
    const cacheControl = 'private, max-age=3600';

    // If-None-Match short-circuit. The File Provider extension caches
    // thumb bytes keyed on this ETag; matching ETag returns 304 with an
    // empty body so the extension can reuse its in-memory copy.
    const cached304 = notModifiedResponse(headers['if-none-match'], etag, cacheControl);
    if (cached304) return cached304;

    let thumbStat: Awaited<ReturnType<typeof stat>> | null = null;
    try {
      thumbStat = await stat(thumbPath);
    } catch {
      thumbStat = null;
    }

    // Freshness MUST consider both the RAW mtime and the RAW size.
    // The ETag composes both, so a stale-but-matching-mtime overwrite
    // with a different size produces a fresh ETag — without the size
    // gate here, the cached thumb would be reused and we'd serve
    // stale JPEG bytes under the new ETag. The sidecar .meta file
    // records the (mtimeMs, size) pair that produced the cached thumb.
    let cachedMeta: { mtimeMs: number; size: number } | null = null;
    if (thumbStat !== null) {
      try {
        const raw = await readFile(`${thumbPath}.meta`, 'utf8');
        const parsed = JSON.parse(raw) as { mtimeMs?: number; size?: number };
        if (typeof parsed.mtimeMs === 'number' && typeof parsed.size === 'number') {
          cachedMeta = { mtimeMs: parsed.mtimeMs, size: parsed.size };
        }
      } catch {
        // Missing or unreadable meta — treat as stale and regenerate.
        cachedMeta = null;
      }
    }

    const fresh =
      thumbStat !== null &&
      thumbStat.mtimeMs >= rawMtimeMs &&
      cachedMeta !== null &&
      cachedMeta.mtimeMs === rawMtimeMs &&
      cachedMeta.size === rawStat.size;

    if (fresh) {
      try {
        const bytes = await readFile(thumbPath);
        set.headers['Content-Type'] = 'image/jpeg';
        set.headers['Cache-Control'] = cacheControl;
        set.headers['ETag'] = etag;
        set.headers['X-Thumb-Cache'] = 'hit';
        return bytes;
      } catch (err) {
        // Fall through to regen if read fails (e.g. file disappeared
        // between stat and readFile).
        log.warn(
          { thumbPath, err: err instanceof Error ? err.message : err },
          'read of cached thumb failed; regenerating',
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

    if (renderViaImgdecode) {
      try {
        const result = await renderImageThumbToFile(real, thumbPath, sizePx, 82, ext);
        if (!result.ok) {
          set.status = 500;
          return {
            error: `imgdecode render failed for ${ext}: ${result.error ?? 'unknown error'}`,
          };
        }
      } catch (err) {
        set.status = 500;
        return {
          error: `imgdecode pool error for ${ext}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    } else {
      // RAW formats: native libraw via the FFI worker pool.
      const pool = ffiPool();
      if (!pool.available()) {
        set.status = 503;
        return {
          error:
            'Thumbnail FFI not built — run scripts/build-raw-ffi.sh to build native/libraw_ffi.* first',
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
        return { error: 'Thumbnail render failed (see server log)' };
      }
      try {
        await applyExifOrientationInPlace(thumbPath);
      } catch (err) {
        // Non-fatal: the FFI output is still a valid JPEG, just possibly
        // un-rotated. Better to serve a sideways image than 500 the request.
        log.warn(
          { thumbPath, err: err instanceof Error ? err.message : err },
          'orientation post-process failed; serving un-rotated thumb',
        );
      }
    }

    // Write the sidecar meta so the next request can verify the cache
    // entry corresponds to the current (mtime, size) of the RAW. Best-
    // effort: a failed meta write only forces a regenerate next time.
    try {
      await writeFile(
        `${thumbPath}.meta`,
        JSON.stringify({ mtimeMs: rawMtimeMs, size: rawStat.size }),
      );
    } catch (err) {
      log.warn(
        { thumbPath, err: err instanceof Error ? err.message : err },
        'meta write failed; cache will regenerate on next request',
      );
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
        'Content-Type': 'image/jpeg',
        'Cache-Control': cacheControl,
        ETag: etag,
        'X-Thumb-Cache': 'miss',
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
