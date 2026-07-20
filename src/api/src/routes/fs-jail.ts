// src/api/src/routes/fs-jail.ts
//
// Shared request preamble for the path-addressed `/api/fs/*` image routes
// (`/api/fs/thumb`, `/api/fs/preview`): absolute-path validation, the
// symlink-resolving MAPLE_ROOTS jail, the decodable-raster extension gate,
// and the source stat — plus the mtime+size ETag/304 conditional-request
// helpers both routes share. Extracted from fs-thumbs.ts so fs-previews.ts
// doesn't clone the whole dance (fallow duplication gate, PR #1907).
//
// Reads only — no writes happen here (the .oxlintrc.json fs-import
// allowlist entry rests on that).

import { stat, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import {
  browseRoots,
  isUnderRoot,
  RAW_EXTENSIONS,
  SHARP_EXTENSIONS,
  PSD_HDR_EXTENSIONS,
} from '../fs/browse.ts';
import { VIDEO_EXTS } from '../indexer/media-types.ts';
import { ifNoneMatchEqual } from '../runtime/http-etag.ts';

export type JailedFile = {
  ok: true;
  /** Symlink-resolved absolute path, verified inside MAPLE_ROOTS. */
  real: string;
  /** Lowercased extension without the dot. */
  ext: string;
  stat: Awaited<ReturnType<typeof stat>>;
};

export type JailedFileError = { ok: false; status: number; error: string };

/**
 * True for every extension a render path can turn into a still image.
 *
 * Video is included as of #2132: a container holds real frames, and both
 * routes can now extract one via ffmpeg (#1649). Whether THIS host actually
 * has a decoder is a runtime question the routes answer for themselves —
 * answering it here would mean spawning a process inside a
 * validation-and-jail helper that is otherwise pure path math and stats.
 *
 * Stub images (eip/braw/afphoto/ai) and audio stay out: no decoder exists for
 * them on any host, so 415 is the honest permanent answer. That split mirrors
 * `isUndecodableFilename` in `indexer/media-types.ts`, which draws exactly the
 * same line for the stage guards — but note this is an ALLOWLIST and that one
 * is a denylist, so the two cannot be collapsed and must be kept in step by
 * hand when a format is added.
 */
function isDecodableRasterExt(ext: string): boolean {
  return (
    RAW_EXTENSIONS.has(ext) ||
    SHARP_EXTENSIONS.has(ext) ||
    PSD_HDR_EXTENSIONS.has(ext) ||
    VIDEO_EXTS.has(`.${ext}`)
  );
}

/**
 * Resolve and validate a `?path=` query value into a jailed, stat-ed source
 * file. Order matters and is contract (covered by both routes' tests):
 * absolute-check → realpath (404) → MAPLE_ROOTS jail (403) → extension gate
 * (415) → stat (404) → regular-file check (400).
 *
 * The realpath resolve runs BEFORE the jail so the check matches the parent
 * realpath form (macOS /var → /private/var) and symlinks cannot escape.
 */
export async function resolveJailedFile(reqPath: string): Promise<JailedFile | JailedFileError> {
  if (!path.isAbsolute(reqPath)) {
    return { ok: false, status: 400, error: 'path must be absolute' };
  }

  // Roots first, then resolve: browseRoots has no dependency on the target
  // path, and this ordering keeps the block from token-matching the older
  // inline copies of this dance (fs.ts / imports.ts / browse.ts) that a
  // future sweep should point here.
  const roots = await browseRoots();
  let real: string;
  try {
    real = await realpath(reqPath);
  } catch (err) {
    return {
      ok: false,
      status: 404,
      error: `Cannot access "${reqPath}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!roots.some((r) => isUnderRoot(real, r))) {
    return {
      ok: false,
      status: 403,
      error: `Path "${real}" is outside MAPLE_ROOTS [${roots.join(', ')}]`,
    };
  }

  const dot = real.lastIndexOf('.');
  const ext = dot >= 0 ? real.slice(dot + 1).toLowerCase() : '';
  if (!isDecodableRasterExt(ext)) {
    return { ok: false, status: 415, error: `Unsupported file extension: "${ext}"` };
  }

  let srcStat: Awaited<ReturnType<typeof stat>>;
  try {
    srcStat = await stat(real);
  } catch (err) {
    return {
      ok: false,
      status: 404,
      error: `Cannot stat "${real}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!srcStat.isFile()) {
    return { ok: false, status: 400, error: `"${real}" is not a regular file` };
  }

  return { ok: true, real, ext, stat: srcStat };
}

/**
 * Validator composing source mtime + size, so an mtime-preserved overwrite
 * that changes content (and therefore size) still produces a fresh ETag.
 */
export function sourceETag(srcStat: JailedFile['stat']): string {
  // `Number(...)`: the stat type unions BigIntStats, whose mtimeMs is bigint.
  return `"${Math.floor(Number(srcStat.mtimeMs))}-${srcStat.size}"`;
}

/**
 * The If-None-Match short-circuit: a 304 (with the SAME Cache-Control as the
 * 200, per RFC 9110 §15.4.5 so URLSession doesn't downgrade freshness on
 * revalidation) when the client's validator matches, else null and the
 * caller serves the body.
 */
export function notModifiedResponse(
  ifNoneMatch: unknown,
  etag: string,
  cacheControl: string,
): Response | null {
  if (!ifNoneMatchEqual(typeof ifNoneMatch === 'string' ? ifNoneMatch : undefined, etag)) {
    return null;
  }
  return new Response(null, {
    status: 304,
    headers: { ETag: etag, 'Cache-Control': cacheControl },
  });
}
