// src/api/src/routes/fs-thumbs.ts
//
// GET /api/fs/thumb?path=<abs-path-to-raw>
//   Returns an `image/avif` thumbnail for the image at `path`, rendered at the
//   fixed `THUMB_LONG_EDGE_PX` tier. Caches the result on disk under
//   `<dir>/.maple/thumbs/<sha256_prefix16(basename)>.avif`.
//
//   There is deliberately NO `size` param (#2220). One cache file per source
//   means any other requested size would be served whatever was written first
//   — which is exactly what the old `size` param did, silently. The
//   display-resolution tier is `/api/fs/preview` (`PREVIEW_LONG_EDGE_PX`).
//
// Lives in a separate file from `fs.ts` so the directory-listing endpoint
// (parallel work) and the thumb endpoint can be edited independently.
//
// Auth: this Elysia plugin must be `.use()`d AFTER `requireAuth` in
// `index.ts` so callers must present a valid bearer.
//
// Cache HIT is ONE filesystem operation (#2258): `readFile(thumbPath)`,
// computed from a non-realpath'd, string-math-only resolve of `?path=`. See
// `tryServeCachedThumb` below for the full reasoning. The fast path DOES
// apply the same decodable-extension allowlist as the miss path (imported
// from `fs-jail.ts`, not duplicated — PR #2275 review, finding 3), since
// that's pure string math too; what it skips is the symlink-resolving
// MAPLE_ROOTS jail and the render dispatch, which live on the MISS path
// (`resolveJailedFile`) and only run when no cached thumb was found there.
//
// The miss path re-checks the cache ONE more time, against the
// realpath-resolved key, before rendering: a LEAF symlink (`/dir/link.jpg` ->
// `/dir/real.jpg`) has a different basename than its target, so the two
// resolutions can hash to different thumb paths for the same underlying
// file. See `tryServeCachedThumb`'s doc comment for why that matters.
//
// Freshness: there is no source-mtime staleness check on a cache hit. The
// architecture forbids mutating originals (root CLAUDE.md principle 1 — all
// edits go to XMP sidecars), so a thumb, once written, never needs to be
// invalidated by a source change; invalidation instead happens at
// O(changes) in the `discover` watcher, `derivative-audit` reconciliation,
// and `generateThumb`'s own write-time mtime guard (`indexer/thumbnailer.ts`)
// — not on every read here.

import { Elysia, t } from 'elysia';
import { readFile, mkdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { RAW_EXTENSIONS, browseRoots, isUnderRoot } from '../fs/browse.ts';
import { resolveThumbPath } from '../fs/xmp.ts';
import { ffiPool } from '../ffi/ffi-pool.ts';
import { VIDEO_EXTS } from '../indexer/media-types.ts';
import { renderImageThumbToFileViaPool } from '../thumbs/imgdecode-pool.ts';
import { applyExifOrientationInPlace } from '../thumbs/apply-orientation.ts';
import { THUMB_AVIF_QUALITY, THUMB_LONG_EDGE_PX } from '../thumbs/render.ts';
import { ffmpegBinary, extractVideoPosterJpeg } from '../thumbs/video-poster.ts';
import { child as childLogger } from '../log.ts';
import {
  resolveJailedFile,
  notModifiedResponse,
  isDecodableRasterExt,
  lowerExt,
} from './fs-jail.ts';
import { computeBodyETag } from '../runtime/http-etag.ts';

const log = childLogger('fs-thumbs');

// Unchanged from before #2258: one hour, revalidating. Not `immutable` — this
// route serves a source-keyed URL (`?path=…`) with no revision token, so the
// URL stays stable across a re-render; an `immutable` response against that
// URL would risk pinning stale bytes in a client's HTTP cache for a year.
const CACHE_CONTROL = 'private, max-age=3600';

/**
 * Build the 200 response for a thumb's bytes — shared by the cache-hit fast
 * path and the miss/render path so the two agree on headers by construction
 * rather than by copy-paste (fallow duplication gate).
 */
function serveThumbBytes(bytes: Buffer, etag: string, cacheStatus: 'hit' | 'miss'): Response {
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new Response(ab, {
    status: 200,
    headers: {
      'Content-Type': 'image/avif',
      'Cache-Control': CACHE_CONTROL,
      ETag: etag,
      'X-Thumb-Cache': cacheStatus,
    },
  });
}

/**
 * Fast path for a cache hit (#2258): ONE filesystem operation
 * (`readFile(thumbPath)`) to serve ~3 KB, replacing what used to cost five —
 * `realpath(reqPath)`, `stat(source)`, `stat(thumbPath)`, and
 * `readFile(thumb + '.meta')` in addition to the payload read itself.
 * Measured ~194ms down to ~12ms on an SMB-mounted library, where each op is
 * a network round trip.
 *
 * Containment is `path.resolve` + a prefix check — pure string math, zero
 * I/O — NOT the symlink-resolving `realpath` jail `resolveJailedFile` runs.
 * That's safe specifically because a HIT never reads `reqPath` itself: it
 * reads the deterministic `<dir>/.maple/thumbs/<sha256(basename)>.avif`
 * shape derived from it, a path a caller cannot steer to arbitrary bytes —
 * at most it can cause an already-rendered thumb (never arbitrary source
 * content) to be served from a path a real `realpath` resolve would have
 * rejected. Symlink resolution and the full jail stay on the miss path,
 * which DOES read arbitrary source bytes and so keeps every check unchanged.
 *
 * Called TWICE per request in general — this is deliberate, not a
 * duplicated call site. First against the raw, non-realpath'd `?path=`
 * (the fast path, above); if that misses, the miss path resolves symlinks
 * via `resolveJailedFile` and calls this again against `real` BEFORE
 * rendering. The two calls can derive DIFFERENT `resolveThumbPath()` keys
 * for the exact same file: a LEAF symlink (`/dir/link.jpg` -> `/dir/real.jpg`)
 * has a different basename than its target, and the hash is over the
 * basename. Without the second call, a request through such a symlink would
 * never see its own prior render (written under `real.jpg`'s key while this
 * one keeps checking `link.jpg`'s key) and would re-decode from source on
 * EVERY request — 100% miss rate, unbounded CPU, a DoS vector via a single
 * symlinked filename. Directory-component symlinks don't have this problem:
 * the basename is unchanged, so both calls hash identically. A normal
 * (non-symlinked, or symlinked-only-in-a-parent-directory) request still
 * resolves on the FIRST call, so this costs nothing on the common path.
 *
 * Also applies `isDecodableRasterExt` against `reqPath` itself — the SAME
 * allowlist `resolveJailedFile` applies against `real`, imported rather than
 * re-derived so the two cannot drift (PR #2275 review, finding 3: without
 * this, `?path=/dir/note.txt` would 200 with cached bytes whenever
 * `.maple/thumbs/<sha256(note.txt)>.avif` happened to exist, contradicting
 * the route's documented 415 contract for non-raster extensions).
 * Deliberately gated on the REQUESTED name, not a realpath-resolved one: a
 * leaf symlink can have a different extension than its target
 * (`link.txt` -> `photo.jpg`), and a caller asking for a `.txt` URL should
 * get 415 regardless of what that name happens to point to — the miss path
 * below still applies its own, authoritative post-realpath check before any
 * render, so a `.txt`-named symlink to a real image is still decided there,
 * unaffected by this fast-path gate.
 *
 * Returns null (never throws) on any miss — not absolute, outside
 * MAPLE_ROOTS, unsupported extension, or no file at `thumbPath` — so the
 * caller falls through to the existing miss path, which re-validates
 * properly and produces the correct 400/403/415/404/500.
 */
async function tryServeCachedThumb(
  reqPath: string,
  ifNoneMatch: unknown,
): Promise<Response | null> {
  if (!path.isAbsolute(reqPath)) return null;

  const roots = await browseRoots();
  const resolved = path.resolve(reqPath);
  if (!roots.some((r) => isUnderRoot(resolved, r))) return null;
  if (!isDecodableRasterExt(lowerExt(resolved))) return null;

  const thumbPath = resolveThumbPath(resolved);
  // `O_NOFOLLOW` so a symlink AT the thumb path is refused rather than
  // followed (PR #2275 review, finding 3's second half). Otherwise anything
  // able to write inside `.maple/thumbs/` — a real concern for an untrusted or
  // shared library mount — could point `<hash>.avif` at any readable file and
  // have this route serve its bytes under `Content-Type: image/avif`.
  //
  // It is a flag on the open this function already performs, so it costs no
  // extra syscall and the one-operation-per-hit property is unchanged; an
  // `lstat` guard would have cost a second round trip, which on the SMB mount
  // this whole change exists for is ~12 ms.
  //
  // Only the FINAL component is protected — directory components are still
  // followed, which is deliberate: `.maple/` legitimately lives under
  // symlinked library roots. `ELOOP` (and any other open error) falls through
  // to the miss path, which re-renders the thumb from source and overwrites
  // whatever was there, so a planted symlink self-heals rather than wedging.
  let bytes: Buffer;
  try {
    const handle = await open(thumbPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch {
    return null; // No cached thumb (or a symlink) — fall through to the miss path.
  }

  // ETag from the bytes already in hand — free, no `stat(source)` round
  // trip. The 304 short-circuit necessarily happens AFTER this read: the
  // validator can't be known before the bytes are (acceptable at one op and
  // ~3 KB — it still saves the transfer, the expensive half for the File
  // Provider that keys its cache on this header).
  const etag = computeBodyETag(bytes);
  const cached304 = notModifiedResponse(ifNoneMatch, etag, CACHE_CONTROL);
  if (cached304) return cached304;

  return serveThumbBytes(bytes, etag, 'hit');
}

/**
 * Render a video's poster frame to `thumbPath` at `sizePx` (#2132).
 *
 * Two hops — ffmpeg to an intermediate JPEG, then the shared imgdecode pool —
 * for the same reason `indexer/thumbnailer.ts` does it: the resize and AVIF
 * encode stay byte-for-byte the bitmap path rather than a second encoder that
 * could drift from it.
 *
 * A module-level helper rather than another inline branch in the route
 * handler, which already carries pre-existing CRITICAL complexity (see its
 * note below).
 */
async function renderVideoPosterThumb(
  real: string,
  thumbPath: string,
  sizePx: number,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  // 503 rather than 500 when the host simply has no decoder: it mirrors the
  // "FFI not built" branch below, and tells the operator this is a missing
  // dependency they can install, not a corrupt file.
  if (!(await ffmpegBinary())) {
    return {
      ok: false,
      status: 503,
      error: 'Video posters need ffmpeg on the server — install it and retry (no restart needed)',
    };
  }

  const posterPath = `${thumbPath}.poster.${process.pid}.${randomBytes(8).toString('hex')}.jpg`;
  try {
    if (!(await extractVideoPosterJpeg(real, posterPath))) {
      return {
        ok: false,
        status: 500,
        error: 'Could not extract a poster frame from this video',
      };
    }
    const result = await renderImageThumbToFileViaPool(
      posterPath,
      thumbPath,
      sizePx,
      THUMB_AVIF_QUALITY,
      'jpg',
    );
    return result.ok
      ? { ok: true }
      : {
          ok: false,
          status: 500,
          error: `imgdecode render failed: ${result.error ?? 'unknown'}`,
        };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: `Video poster render failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    // The intermediate is never served; drop it on every path including success.
    try {
      await unlink(posterPath);
    } catch {
      /* extraction failed before writing, or already gone */
    }
  }
}

export const fsThumbsRoutes = new Elysia({ prefix: '/api/fs' }).get(
  '/thumb',
  // Pre-existing CRITICAL complexity (RAW/sharp/PSD-HDR dispatch, ETag, and
  // FFI-vs-imgdecode branches all live in this one route handler). Out of
  // scope to decompose here — this PR moves the cache-hit decision into
  // `tryServeCachedThumb` above (which shrinks this handler rather than
  // growing it) but otherwise leaves the render dispatch as-is. Worth
  // splitting further as a dedicated follow-up.
  // fallow-ignore-next-line complexity
  async ({ query, headers, set }) => {
    const reqPath = query.path;
    const sizePx = THUMB_LONG_EDGE_PX;
    const ifNoneMatch = headers['if-none-match'];

    // ONE-op cache hit (#2258) — see `tryServeCachedThumb`'s doc comment.
    // Everything below only runs on a miss.
    const hit = await tryServeCachedThumb(reqPath, ifNoneMatch);
    if (hit) return hit;

    // Shared absolute-path / realpath-jail / extension-gate / stat preamble
    // (fs-jail.ts — also used by /api/fs/preview). Unchanged: this is the
    // miss path, which DOES need to read arbitrary source bytes and so keeps
    // the full symlink-resolving jail.
    const resolved = await resolveJailedFile(reqPath);
    if (!resolved.ok) {
      set.status = resolved.status;
      return { error: resolved.error };
    }
    const { real, ext } = resolved;

    // Re-check the cache against the REALPATH-resolved key before
    // rendering. See `tryServeCachedThumb`'s doc comment: a leaf symlink
    // makes the fast-path key (above, derived from the raw `?path=`) and
    // this route's render key (derived from `real`) disagree, so a miss on
    // the raw path does NOT mean there's nothing cached for this file.
    const realHit = await tryServeCachedThumb(real, ifNoneMatch);
    if (realHit) return realHit;

    // Dispatch — RAW formats go through the FFI pipeline; sharp-native
    // bitmaps (JPG/HEIC/PNG/WEBP/TIFF/AVIF) and PSD/PSB/HDR (first decoded
    // via ag-psd/hdr, then handed to sharp) both go through
    // `renderImageThumbToFileViaPool` below — collapsed into one flag so the
    // dispatch reads as a single two-way branch.
    // Video (#2132) is a third case: ffmpeg extracts a poster frame, which
    // then goes through the same imgdecode hop as any bitmap.
    const isVideo = VIDEO_EXTS.has(`.${ext}`);
    const renderViaImgdecode = !isVideo && !RAW_EXTENSIONS.has(ext);

    // One thumb per source file (matches Apple ThumbnailDiskCache + web
    // MapleCacheService), rendered at the single fixed `THUMB_LONG_EDGE_PX`
    // tier. Reaching here means BOTH cache checks missed — the fast path
    // above (raw `?path=` key) and the realpath-resolved recheck just above
    // (`real`'s key, the SAME key this line computes) — so the render below
    // always proceeds unconditionally. No separate staleness check is
    // needed beyond those two lookups: see the module doc for why a cached
    // thumb is never considered stale once found.
    const thumbPath = resolveThumbPath(real);

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

    if (isVideo) {
      const poster = await renderVideoPosterThumb(real, thumbPath, sizePx);
      if (!poster.ok) {
        set.status = poster.status;
        return { error: poster.error };
      }
    } else if (renderViaImgdecode) {
      try {
        const result = await renderImageThumbToFileViaPool(
          real,
          thumbPath,
          sizePx,
          THUMB_AVIF_QUALITY,
          ext,
        );
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
        ok = await pool.renderThumbnailAvifToFile(real, thumbPath, sizePx, THUMB_AVIF_QUALITY);
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
        // Non-fatal: the FFI output is still a valid AVIF, just possibly
        // un-rotated. Better to serve a sideways image than 500 the request.
        log.warn(
          { thumbPath, err: err instanceof Error ? err.message : err },
          'orientation post-process failed; serving un-rotated thumb',
        );
      }
    }

    // Read the freshly written file back to serve. Cheap (thumbs <100 KB).
    // ETag is derived from these bytes (free — no `stat(source)` round
    // trip), same as the cache-hit path, so the two agree on the scheme.
    let bytes: Buffer;
    try {
      bytes = await readFile(thumbPath);
    } catch (err) {
      set.status = 500;
      return {
        error: `Read of just-written thumb failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const etag = computeBodyETag(bytes);
    const cached304 = notModifiedResponse(ifNoneMatch, etag, CACHE_CONTROL);
    if (cached304) return cached304;

    return serveThumbBytes(bytes, etag, 'miss');
  },
  {
    // No `size`: the tier is fixed. Elysia drops query params absent from the
    // schema, so already-deployed clients still sending `?size=512` keep
    // working and get the same bytes they were getting before.
    query: t.Object({
      path: t.String({ minLength: 1 }),
    }),
  },
);
