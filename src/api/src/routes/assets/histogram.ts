/**
 * GET /api/assets/:id/histogram
 *
 * Returns a 3-channel 256-bin RGB histogram for the asset's currently-
 * applied XMP. The response is JSON `{ r: number[256], g: number[256],
 * b: number[256] }` so the web (SVG/Canvas) and Apple (SwiftUI.Canvas)
 * inspectors can render the curves themselves — the server is the
 * histogram's source of truth, not the renderer.
 *
 * Closes #633.
 *
 * Pipeline:
 *   1. Resolve `id` → AssetCoreInfo (Mongo ObjectId hex).
 *   2. Resolve RAW abs-path + (optional) XMP sidecar.
 *   3. Compute the cache key as the tuple `<raw_mtime_ms>-<xmp_mtime_ms_or_none>`
 *      so a re-edit invalidates without a flush. The histogram lives at
 *      `<lib>/<rel>/.maple/previews/<filename>.histogram.json` (composed via
 *      `cachePathForAsset(.., 'previews', 'histogram.json')`); the JSON
 *      includes the key in a `key` field, so a stale on-disk file is
 *      detected by reading it back without re-rendering.
 *   4. Cache miss → ffiPool().computeHistogram(raw, xmp).
 *   5. Persist + serve.
 *
 * Cache + ETag:
 *   - ETag is the (raw_mtime, sidecar_mtime) tuple as `"<raw>-<xmp>"`.
 *   - Sidecar missing on disk → `<xmp>` is the literal string `none`.
 *   - 304 on `If-None-Match` match, no body read.
 *   - Cache-Control is `private, max-age=300` (NOT `immutable` — the
 *     sidecar may be re-edited at any time and the same URL must
 *     re-fetch after the mtime advances).
 *
 * Degradation: if the dylib isn't loaded (CI without libraw_ffi), the
 * route returns 503 so callers can fall back to the placeholder block
 * rather than spinning forever.
 */

import { Elysia } from 'elysia';
import { stat, readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { findCoreInfoById, parseAssetId } from '../../db/assets.repo.ts';
import { assetAbsPath } from '../../indexer/images.repo.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import { safeWriteAllowed } from '../../fs/root.ts';
import { xmpSidecarPath, cachePathForAsset } from '../../fs/xmp.ts';
import { ifNoneMatchEqual } from '../../runtime/http-etag.ts';
import { ffiPool } from '../../ffi/ffi-pool.ts';
import type { HistogramBins } from '../../thumbs/histogram.ts';
import { assetsLog } from './_shared.ts';

const CACHE_CONTROL = 'private, max-age=300';

interface CachedHistogram {
  /** Cache key — `<raw_mtime_ms>-<xmp_mtime_ms_or_none>`. Match before trust. */
  key: string;
  bins: HistogramBins;
}

function buildCacheKey(rawMtimeMs: number, xmpMtimeMs: number | null): string {
  return `${Math.floor(rawMtimeMs)}-${xmpMtimeMs === null ? 'none' : Math.floor(xmpMtimeMs)}`;
}

function etagFor(key: string): string {
  return `"${key}"`;
}

/**
 * Try to read a cached histogram from disk. Returns null on any I/O,
 * parse, or key-mismatch problem — the caller falls back to recompute.
 */
async function readCached(jsonPath: string, expectedKey: string): Promise<HistogramBins | null> {
  try {
    const raw = await readFile(jsonPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<CachedHistogram>;
    if (parsed?.key !== expectedKey) return null;
    if (
      !parsed.bins ||
      !Array.isArray(parsed.bins.r) ||
      !Array.isArray(parsed.bins.g) ||
      !Array.isArray(parsed.bins.b)
    ) {
      return null;
    }
    if (
      parsed.bins.r.length !== 256 ||
      parsed.bins.g.length !== 256 ||
      parsed.bins.b.length !== 256
    ) {
      return null;
    }
    return { r: parsed.bins.r, g: parsed.bins.g, b: parsed.bins.b };
  } catch {
    return null;
  }
}

/** Atomic JSON write (`.tmp` + rename). Best-effort — write failures
 *  log + swallow; the histogram is recomputable. */
async function writeCached(jsonPath: string, payload: CachedHistogram): Promise<void> {
  try {
    const allowed = await safeWriteAllowed(jsonPath);
    if (!allowed.ok) {
      assetsLog.warn(
        { jsonPath, error: allowed.error },
        'histogram cache outside MAPLE_ROOTS — skipping persist',
      );
      return;
    }
    await mkdir(path.dirname(jsonPath), { recursive: true });
    const tmp = `${jsonPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(payload), 'utf-8');
    await rename(tmp, jsonPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assetsLog.warn({ jsonPath, msg }, 'histogram cache write failed (non-fatal)');
  }
}

export const histogramRoutes = new Elysia().get(
  '/:id/histogram',
  async ({ params, headers, set }) => {
    const id = parseAssetId(params.id);
    if (!id) {
      set.status = 400;
      return { error: 'Invalid asset id' };
    }

    const info = await findCoreInfoById(id);
    if (!info) {
      set.status = 404;
      return { error: 'Asset not found' };
    }

    const libs = await loadLibraryRoots();
    const rawPath = assetAbsPath(info, libs);
    if (!rawPath) {
      set.status = 404;
      return { error: 'Asset has no resolvable location' };
    }

    let rawStat;
    try {
      rawStat = await stat(rawPath);
    } catch {
      set.status = 404;
      return { error: 'RAW file missing on disk' };
    }

    // Resolve the sidecar's mtime (if any) so a re-edit advances the key.
    const xmpPath = xmpSidecarPath(rawPath);
    let xmpMtimeMs: number | null = null;
    try {
      const s = await stat(xmpPath);
      xmpMtimeMs = s.mtimeMs;
    } catch {
      xmpMtimeMs = null;
    }

    const key = buildCacheKey(rawStat.mtimeMs, xmpMtimeMs);
    const etag = etagFor(key);

    // 304 short-circuit — never read the cache JSON or touch the dylib.
    const ifNoneMatch = headers['if-none-match'];
    if (ifNoneMatchEqual(typeof ifNoneMatch === 'string' ? ifNoneMatch : undefined, etag)) {
      return new Response(null, {
        status: 304,
        headers: { ETag: etag, 'Cache-Control': CACHE_CONTROL },
      });
    }

    // Disk-cache lookup. `cachePathForAsset(.., 'previews', 'histogram.json')`
    // composes `<lib>/<rel>/.maple/previews/<filename>.histogram.json` — no
    // `maple_id` needed (previews are path-keyed, see `cachePathForAsset`'s
    // doc), just an asset row with `fileinfo`.
    const jsonPath = cachePathForAsset(
      { maple_id: info.maple_id ?? undefined, fileinfo: info.fileinfo },
      libs,
      'previews',
      'histogram.json',
    );

    if (jsonPath) {
      const cached = await readCached(jsonPath, key);
      if (cached) {
        set.headers['ETag'] = etag;
        set.headers['Cache-Control'] = CACHE_CONTROL;
        set.headers['Content-Type'] = 'application/json';
        return cached;
      }
    }

    // Cache miss — compute via the worker. Dylib-missing → 503.
    let bins: HistogramBins;
    try {
      bins = await ffiPool().computeHistogram(rawPath, xmpMtimeMs === null ? null : xmpPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/dylib not available/.test(msg)) {
        assetsLog.warn({ rawPath }, 'libraw_ffi dylib not available — returning 503');
        set.status = 503;
        return { error: 'Histogram rendering unavailable' };
      }
      assetsLog.error({ rawPath, msg }, 'histogram compute failed');
      set.status = 500;
      return { error: 'Histogram compute failed' };
    }

    // Cheap structural sanity — guards against an unexpected worker
    // response shape (e.g. a future protocol change). Loud-fails the
    // request rather than poisoning the disk cache.
    if (bins.r.length !== 256 || bins.g.length !== 256 || bins.b.length !== 256) {
      assetsLog.error({}, 'worker returned malformed bins');
      set.status = 500;
      return { error: 'Histogram validation failed' };
    }

    // Persist (best-effort). Doesn't block the response.
    if (jsonPath) {
      void writeCached(jsonPath, { key, bins });
    }

    set.headers['ETag'] = etag;
    set.headers['Cache-Control'] = CACHE_CONTROL;
    set.headers['Content-Type'] = 'application/json';
    return bins;
  },
);
