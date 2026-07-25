/**
 * XMP sidecar read/write and .maple/ thumbnail cache management.
 *
 * Atomic writes: write to .tmp file, then rename (POSIX rename is atomic).
 * .maple/ directories are created lazily under each library folder.
 */

import * as path from 'node:path';
// Mirror-aware drop-in: durable writes/moves replicate to the library's
// configured backup root(s). Same `fs/promises` surface — see `mirrored.ts`.
import * as fs from './mirrored.ts';
import { createHash, randomBytes } from 'node:crypto';
import { safeWriteAllowed } from './root.ts';
import type { OpResult } from './root.ts';
import type { AssetDoc } from '../db/schema.ts';
import { assetPrimaryFileInfo } from '../indexer/images.repo.ts';
import { isVideoFilename } from '../indexer/media-types.ts';

/**
 * First 16 hex chars of sha256(text) — the cache-key stem used for
 * `.maple/thumbs/<key>.avif`. Matches the web (Hosted) maple-cache
 * convention at `src/web/.../maple-cache/sha.ts` so thumbs written by
 * the API are readable by the browser-FS-Access cache (and vice versa
 * once Apple migrates to a filename-keyed hash too).
 */
export function sha256Prefix16(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Resolve the expected XMP sidecar path for a given raw/image/video file.
 *
 * Images use the classic stem-swap convention (`IMG_1.ARW` → `IMG_1.xmp`).
 * Videos KEEP their extension and append `.xmp` (`clip.mov` → `clip.mov.xmp`),
 * the industry-standard full-name convention. This is load-bearing for Apple
 * Live Photos, which store the still and the motion clip as two independent
 * same-stem assets (`IMG_1234.HEIC` + `IMG_1234.MOV`). Under stem-swap both
 * would resolve to `IMG_1234.xmp` and clobber each other; full-name for the
 * video gives it its own `IMG_1234.MOV.xmp` and leaves the photo's sidecar
 * untouched. Existing photo sidecars are NOT migrated — only video naming
 * changes.
 */
export function xmpSidecarPath(rawAbsPath: string): string {
  if (isVideoFilename(rawAbsPath)) return rawAbsPath + '.xmp';
  const ext = path.extname(rawAbsPath);
  return rawAbsPath.slice(0, -ext.length) + '.xmp';
}

/** Read XMP sidecar. Returns ok:false if the sidecar does not exist. */
export async function readXmp(rawAbsPath: string): Promise<OpResult<string>> {
  const sidecar = xmpSidecarPath(rawAbsPath);
  try {
    const content = await fs.readFile(sidecar, 'utf-8');
    return { ok: true, data: content };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `No XMP sidecar at "${sidecar}": ${msg}` };
  }
}

/**
 * Atomically write (or overwrite) an XMP sidecar.
 *
 * Steps:
 *   1. Check path is under an allowed root.
 *   2. Write to <sidecar>.tmp.
 *   3. fsync the temp file.
 *   4. rename() into place.
 */
export async function writeXmpAtomic(rawAbsPath: string, xmlContent: string): Promise<OpResult> {
  const sidecar = xmpSidecarPath(rawAbsPath);
  const tmp = `${sidecar}.tmp.${process.pid}.${randomBytes(8).toString('hex')}`;

  const allowed = await safeWriteAllowed(sidecar);
  if (!allowed.ok) return { ok: false, error: allowed.error };

  try {
    // Ensure directory exists (it should, but be defensive).
    await fs.mkdir(path.dirname(sidecar), { recursive: true });

    const fh = await fs.open(tmp, 'w');
    try {
      await fh.writeFile(xmlContent, 'utf-8');
      await fh.datasync();
    } finally {
      await fh.close();
    }

    await fs.rename(tmp, sidecar);
    return { ok: true };
  } catch (err) {
    // Clean up temp file on error.
    try {
      await fs.unlink(tmp);
    } catch {}
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `XMP write failed: ${msg}` };
  }
}

/**
 * Ensure a .maple/ directory exists under the folder containing rawAbsPath.
 * Returns the .maple/ path.
 */
export async function ensureMapleDir(folderAbsPath: string): Promise<string> {
  const dir = path.join(folderAbsPath, '.maple');
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Resolve the thumbnail cache path for a given RAW file.
 *
 * Convention (aligned with the desktop apps + web Hosted variant):
 *   <folder>/.maple/thumbs/<sha256_prefix16(basename)>.avif
 *
 * - Single thumb per RAW file at the fixed `THUMB_LONG_EDGE_PX` tier; callers
 *   cannot request another size (#2220), so the mtime stale-check (raw ≥ thumb)
 *   suffices. Matches web `MapleCacheService` / Apple `ThumbnailDiskCache`.
 * - Hash input is the basename (filename with extension) so `.maple/`
 *   travels with the photos: copy the folder elsewhere and the same
 *   thumb hash still resolves. Hashing the absolute path would make
 *   the cache non-portable.
 */
export function resolveThumbPath(rawAbsPath: string): string {
  const folder = path.dirname(rawAbsPath);
  const basename = path.basename(rawAbsPath);
  const key = sha256Prefix16(basename);
  return path.join(folder, '.maple', 'thumbs', `${key}.avif`);
}

/** Trailing args of the `cachePathFor*` resolvers — which derived artefact
 * (`thumbs` = thumbnail, `previews` = display-resolution render) plus, for
 * previews only, its `suffix`. One tuple rather than a `kind` + optional
 * `suffix` pair so the requirement is expressed in a single signature. */
type CacheKindArgs = ['thumbs'] | ['previews', string];

/**
 * Resolve the on-disk cache path for an asset's derived artefact.
 *
 * Thumbs use the unified per-file convention from `resolveThumbPath`; previews
 * are keyed off the source's own filename plus a `suffix`:
 *
 *   thumbs:   <folder>/.maple/thumbs/<sha256_prefix16(basename)>.avif
 *   previews: <folder>/.maple/previews/<basename>.<suffix>
 *
 * The canonical preview is a single, unversioned `<basename>.avif` overwritten
 * in place (#2017), NOT size- or version-keyed; `suffix` only distinguishes
 * co-located artefacts of a different kind (the `histogram.json` sidecar). It
 * MUST use this `<basename-with-its-own-extension>.<suffix>` form (not
 * `<basename-no-ext>_<suffix>`): `cleanPreviewsCacheForLocation` and
 * `cache-gc.ts`'s previews sweep both match a live filename as a literal
 * `.`-terminated prefix, so a legacy (unindexed-fallback) preview generated
 * here needs the identical prefix an indexed one would have, or it is invisible
 * to both cleanup paths and leaks on disk forever (jules review, PR #2006).
 *
 * `suffix` is REQUIRED for `previews` (#2220): the old `'full.jpg'` default was
 * a tier nothing writes any more, reachable only by mistake and silently.
 * (`'full.jpg'` stays in `preview-cache-cleanup.ts`'s `KNOWN_EXACT_SUFFIXES` —
 * older files must stay reclaimable.) Ignored for `thumbs`: one fixed tier.
 */
export function cachePathFor(assetAbsPath: string, ...[kind, suffix]: CacheKindArgs): string {
  if (kind === 'thumbs') {
    return resolveThumbPath(assetAbsPath);
  }
  const folder = path.dirname(assetAbsPath);
  const filename = path.basename(assetAbsPath);
  return path.join(folder, '.maple', 'previews', `${filename}.${suffix}`);
}

/**
 * Resolve an asset's primary on-disk location down to (library root,
 * platform-correct directory segments, filename) — the shared prelude every
 * `.maple/` cache-path resolver below needs. `fileinfo.path` is stored
 * POSIX-separated (`/`); we split on `/` and re-join via `path.join` so the
 * result is platform-correct on Windows hosts (a no-op on the Linux/macOS
 * production target).
 *
 * Returns `null` when `fileinfo[]` is empty/absent (legacy row not yet
 * backfilled) or the primary entry's `library_id` isn't in the `libraries`
 * map (e.g. the library was unregistered).
 */
function resolvePrimaryLocation(
  asset: Pick<AssetDoc, 'fileinfo'>,
  libraries: ReadonlyMap<string, string>,
): { root: string; segments: string[]; filename: string } | null {
  const primary = assetPrimaryFileInfo(asset);
  if (!primary) return null;
  const root = libraries.get(primary.library_id.toHexString());
  if (!root) return null;
  const segments = primary.path === '' ? [] : primary.path.split('/');
  return { root, segments, filename: primary.filename };
}

/**
 * Resolve the thumbnail cache path for an indexed asset — the DB-side entry
 * point to the SAME path-keyed location `resolveThumbPath` computes for a bare
 * absolute path. Composes the asset's primary on-disk location into an absolute
 * path, then defers entirely to `resolveThumbPath`:
 *
 *   <library_root>/<fileinfo[0].path>/.maple/thumbs/<sha256_prefix16(filename)>.avif
 *
 * Deliberately path-keyed, NOT `maple_id`-keyed: Maple is a UI over a local
 * filesystem, so a cache entry must resolve from a path alone — no DB lookup,
 * no hash — and stay readable when the folder is copied elsewhere. Content
 * addressing bought almost nothing back (the artefact lands in ONE folder, so
 * copies elsewhere shared nothing) and cost a Mongo round-trip per read. This
 * is why the `thumb` stage and `/api/fs/thumb` now agree on a filename.
 * Trade-off: a rename orphans the thumb for one re-render; cache-gc reclaims it.
 *
 * Returns `null` when `fileinfo[]` is empty/absent or the primary entry's
 * `library_id` isn't in the `libraries` map (an unregistered library).
 */
export function resolveThumbPathForAsset(
  asset: Pick<AssetDoc, 'fileinfo'>,
  libraries: ReadonlyMap<string, string>,
): string | null {
  const loc = resolvePrimaryLocation(asset, libraries);
  if (!loc) return null;
  return resolveThumbPath(path.join(loc.root, ...loc.segments, loc.filename));
}

/**
 * Resolve a thumbnail or preview cache path for an asset. Composes:
 *
 *   thumbs:   <library_root>/<fileinfo[0].path>/.maple/thumbs/<sha256_prefix16(filename)>.avif
 *   previews: <library_root>/<fileinfo[0].path>/.maple/previews/<fileinfo[0].filename>.<suffix>
 *
 * BOTH tiers are keyed off the source's own filename — no EXIF read, no hash of
 * the bytes, and no DB lookup needed to resolve either one. The cost is that
 * neither survives a rename/move: a moved file's stale artefact is cleaned up
 * by the missing-reaper/dedupe cache-removal hook, with cache-gc's sweep as a
 * backstop. See `resolveThumbPathForAsset` for why thumbs are path-keyed rather
 * than content-addressed.
 *
 * `suffix` semantics (including why it is REQUIRED for `previews`) and the
 * `null` semantics are as documented on `cachePathFor` and
 * `resolveThumbPathForAsset` respectively.
 */
export function cachePathForAsset(
  asset: Pick<AssetDoc, 'fileinfo'>,
  libraries: ReadonlyMap<string, string>,
  ...[kind, suffix]: CacheKindArgs
): string | null {
  if (kind === 'thumbs') {
    return resolveThumbPathForAsset(asset, libraries);
  }
  const loc = resolvePrimaryLocation(asset, libraries);
  if (!loc) return null;
  return path.join(loc.root, ...loc.segments, '.maple', 'previews', `${loc.filename}.${suffix}`);
}

/**
 * Write a thumbnail buffer to the .maple/ cache (atomic).
 * Creates the directory if needed.
 */
export async function writeThumb(
  rawAbsPath: string,
  avifBytes: Buffer | Uint8Array,
): Promise<OpResult> {
  const thumbPath = resolveThumbPath(rawAbsPath);
  const thumbDir = path.dirname(thumbPath);

  const allowed = await safeWriteAllowed(thumbPath);
  if (!allowed.ok) return { ok: false, error: allowed.error };

  try {
    await fs.mkdir(thumbDir, { recursive: true });
    const tmp = `${thumbPath}.tmp.${process.pid}.${randomBytes(8).toString('hex')}`;
    const fh = await fs.open(tmp, 'w');
    try {
      await fh.writeFile(avifBytes);
      await fh.datasync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, thumbPath);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Thumb write failed: ${msg}` };
  }
}

/**
 * Result of an XMP write that may produce a conflict copy.
 * - `ok`: normal atomic write succeeded; `mtime` is the new file's mtime.
 * - `conflict`: mtime precondition failed; the incoming bytes were written
 *   to a conflict-copy file alongside the original. The original is
 *   untouched.
 * - `error`: any other failure (path jail, disk full, etc.).
 */
export type XmpWriteOutcome =
  | { kind: 'ok'; mtime: Date }
  | { kind: 'conflict'; conflictPath: string; conflictMtime: Date }
  | { kind: 'error'; error: string };

/** Sanitize a device name for use in a conflict-copy filename. */
function sanitizeDeviceName(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return 'Unknown device';
  return trimmed.replace(/[/\\:*?"<>|]/g, '-').slice(0, 64);
}

/** Compose the conflict-copy path for a given RAW + device name. */
export function conflictCopyPath(rawAbsPath: string, deviceName: string): string {
  const ext = path.extname(rawAbsPath);
  const base = rawAbsPath.slice(0, -ext.length);
  return `${base} (conflict from ${sanitizeDeviceName(deviceName)}).xmp`;
}

/**
 * Find an unused conflict-copy path for this device. Starts with the
 * unsuffixed form (`<base> (conflict from <device>).xmp`); on collision
 * appends ` (2)`, ` (3)`, ... before the extension. Bounded to 1000
 * attempts — if every variant exists, returns the highest path it tried
 * and lets the caller race for it.
 *
 * The check-then-use is racy (TOCTOU). Acceptable: even when two writers
 * both pick `(N)`, the worst case is ONE collision, not unbounded silent
 * loss. Compare against the prior behaviour where every concurrent
 * mismatch on the same device clobbered the same file.
 */
export async function pickFreeConflictPath(
  rawAbsPath: string,
  deviceName: string,
): Promise<string> {
  const base = conflictCopyPath(rawAbsPath, deviceName);
  try {
    await fs.stat(base);
  } catch {
    return base; // No collision.
  }
  // base ends in ".xmp" — strip and append " (N).xmp".
  const stem = base.slice(0, -'.xmp'.length);
  for (let n = 2; n <= 1000; n++) {
    const candidate = `${stem} (${n}).xmp`;
    try {
      await fs.stat(candidate);
    } catch {
      return candidate;
    }
  }
  return `${stem} (1000).xmp`;
}

/**
 * Atomic XMP write with an optional mtime precondition.
 *
 * When `ifMtimeMatchesEpoch` is provided and the on-disk file's mtime in
 * seconds differs, the bytes are written to a conflict-copy file instead
 * of the canonical sidecar. The canonical sidecar is untouched in that case.
 *
 * mtime granularity is one second. XMP saves happen at human cadence
 * (one save per editor flush) so this is sufficient.
 */
export async function writeXmpWithPrecondition(
  rawAbsPath: string,
  xmlContent: string,
  ifMtimeMatchesEpoch: number | null,
  deviceName: string,
): Promise<XmpWriteOutcome> {
  const sidecar = xmpSidecarPath(rawAbsPath);

  if (ifMtimeMatchesEpoch !== null) {
    let onDiskEpoch: number | null = null;
    try {
      const st = await fs.stat(sidecar);
      onDiskEpoch = Math.floor(st.mtimeMs / 1000);
    } catch {
      onDiskEpoch = null;
    }
    if (onDiskEpoch !== ifMtimeMatchesEpoch) {
      const conflictPath = await pickFreeConflictPath(rawAbsPath, deviceName);
      const allowed = await safeWriteAllowed(conflictPath);
      if (!allowed.ok) return { kind: 'error', error: allowed.error ?? 'Path not allowed' };
      const tmp = `${conflictPath}.tmp.${process.pid}.${randomBytes(8).toString('hex')}`;
      try {
        await fs.mkdir(path.dirname(conflictPath), { recursive: true });
        const fh = await fs.open(tmp, 'w');
        try {
          await fh.writeFile(xmlContent, 'utf-8');
          await fh.datasync();
        } finally {
          await fh.close();
        }
        await fs.rename(tmp, conflictPath);
        const st = await fs.stat(conflictPath);
        return { kind: 'conflict', conflictPath, conflictMtime: st.mtime };
      } catch (err) {
        try {
          await fs.unlink(tmp);
        } catch {}
        const msg = err instanceof Error ? err.message : String(err);
        return { kind: 'error', error: `Conflict-copy write failed: ${msg}` };
      }
    }
  }

  const result = await writeXmpAtomic(rawAbsPath, xmlContent);
  if (!result.ok) return { kind: 'error', error: result.error ?? 'XMP write failed' };
  try {
    const st = await fs.stat(sidecar);
    return { kind: 'ok', mtime: st.mtime };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: 'error', error: `stat after write failed: ${msg}` };
  }
}

/**
 * Delete an XMP sidecar. Idempotent — succeeds whether or not the file
 * existed. Never touches the paired RAW.
 */
export async function deleteXmpSidecar(rawAbsPath: string): Promise<OpResult> {
  const sidecar = xmpSidecarPath(rawAbsPath);
  const allowed = await safeWriteAllowed(sidecar);
  if (!allowed.ok) return { ok: false, error: allowed.error };
  try {
    await fs.unlink(sidecar);
    return { ok: true };
  } catch (err: unknown) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: string }).code === 'ENOENT'
    ) {
      return { ok: true };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `XMP delete failed: ${msg}` };
  }
}

/**
 * Resolve a conflict-copy sidecar's absolute path for a given asset.
 *
 * Validates that `conflictBasename` (without `.xmp` extension) matches the
 * conflict-suffix pattern for the asset's RAW filename, with optional
 * numbered variant. This prevents path-traversal: a malicious or buggy
 * caller can't address arbitrary sidecars on disk.
 *
 *   rawAbsPath = "/photos/IMG_1.ARW"
 *   conflictBasename = "IMG_1 (conflict from MacBook)"
 *   → "/photos/IMG_1 (conflict from MacBook).xmp"
 *
 *   rawAbsPath = "/photos/IMG_1.ARW"
 *   conflictBasename = "IMG_1 (conflict from MacBook) (2)"
 *   → "/photos/IMG_1 (conflict from MacBook) (2).xmp"
 *
 *   rawAbsPath = "/photos/IMG_1.ARW"
 *   conflictBasename = "../etc/passwd"
 *   → null
 *
 *   rawAbsPath = "/photos/IMG_1.ARW"
 *   conflictBasename = "IMG_2 (conflict from MacBook)"   // different RAW
 *   → null
 */
export function resolveConflictSidecarPath(
  rawAbsPath: string,
  conflictBasename: string,
): string | null {
  if (conflictBasename.includes('/') || conflictBasename.includes('\\')) return null;
  if (conflictBasename.includes('..')) return null;

  const ext = path.extname(rawAbsPath);
  const rawBase = path.basename(rawAbsPath, ext); // e.g. "IMG_1"

  // The basename must start with the RAW's base and end with the
  // conflict-suffix (optionally followed by a numbered variant).
  const pattern = new RegExp(`^${escapeRegex(rawBase)} \\(conflict from [^)]+\\)( \\(\\d+\\))?$`);
  if (!pattern.test(conflictBasename)) return null;

  return path.join(path.dirname(rawAbsPath), `${conflictBasename}.xmp`);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Read a specific conflict-copy sidecar. Returns ok:false if the basename
 * doesn't validate or the file doesn't exist.
 */
export async function readConflictSidecar(
  rawAbsPath: string,
  conflictBasename: string,
): Promise<OpResult<string>> {
  const sidecar = resolveConflictSidecarPath(rawAbsPath, conflictBasename);
  if (!sidecar) return { ok: false, error: 'Invalid conflict basename' };
  try {
    const content = await fs.readFile(sidecar, 'utf-8');
    return { ok: true, data: content };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `No conflict sidecar at "${sidecar}": ${msg}` };
  }
}

/**
 * Atomically overwrite a specific conflict-copy sidecar. No precondition —
 * the user is editing this exact file directly. Returns the new mtime.
 */
export async function writeConflictSidecarAtomic(
  rawAbsPath: string,
  conflictBasename: string,
  xmlContent: string,
): Promise<{ ok: true; mtime: Date } | { ok: false; error: string }> {
  const sidecar = resolveConflictSidecarPath(rawAbsPath, conflictBasename);
  if (!sidecar) return { ok: false, error: 'Invalid conflict basename' };

  const allowed = await safeWriteAllowed(sidecar);
  if (!allowed.ok) return { ok: false, error: allowed.error ?? 'Path not allowed' };

  const tmp = `${sidecar}.tmp.${process.pid}.${randomBytes(8).toString('hex')}`;
  try {
    await fs.mkdir(path.dirname(sidecar), { recursive: true });
    const fh = await fs.open(tmp, 'w');
    try {
      await fh.writeFile(xmlContent, 'utf-8');
      await fh.datasync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, sidecar);
    const st = await fs.stat(sidecar);
    return { ok: true, mtime: st.mtime };
  } catch (err) {
    try {
      await fs.unlink(tmp);
    } catch {}
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Conflict sidecar write failed: ${msg}` };
  }
}

/**
 * Return absolute paths of every XMP sidecar paired to the given RAW —
 * the canonical `<base>.xmp` plus every `<base> (conflict from <device>).xmp`
 * (with optional ` (N)` numeric suffix). Order is unspecified; callers that
 * care about ordering must sort.
 *
 * Reads the RAW's parent directory once and filters by name. Missing
 * directory or read errors return an empty array — the caller is moving
 * sidecars best-effort.
 */
export async function listPairedSidecars(rawAbsPath: string): Promise<string[]> {
  const dir = path.dirname(rawAbsPath);
  const rawBase = path.basename(rawAbsPath, path.extname(rawAbsPath));
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  // Anchored: name is either `<rawBase>.xmp` (canonical) or
  // `<rawBase> (conflict from <device>)[ (N)].xmp` (variant). The
  // numeric `(N)` suffix is only valid AFTER a conflict-from suffix —
  // a bare `<rawBase> (N).xmp` (e.g. `IMG_1 (2).xmp`) is NOT a paired
  // sidecar and must not match, otherwise trash/purge would move
  // unrelated XMP files with that name.
  const escaped = rawBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `^${escaped}(?:\\.xmp| \\(conflict from [^)]+\\)(?: \\(\\d+\\))?\\.xmp)$`,
    'i',
  );
  return entries.filter((name) => pattern.test(name)).map((name) => path.join(dir, name));
}

/**
 * Delete a specific conflict-copy sidecar. Idempotent — succeeds whether
 * or not the file existed. Returns error only if the basename doesn't
 * validate.
 */
export async function deleteConflictSidecar(
  rawAbsPath: string,
  conflictBasename: string,
): Promise<OpResult> {
  const sidecar = resolveConflictSidecarPath(rawAbsPath, conflictBasename);
  if (!sidecar) return { ok: false, error: 'Invalid conflict basename' };
  const allowed = await safeWriteAllowed(sidecar);
  if (!allowed.ok) return { ok: false, error: allowed.error ?? 'Path not allowed' };
  try {
    await fs.unlink(sidecar);
    return { ok: true };
  } catch (err: unknown) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: string }).code === 'ENOENT'
    ) {
      return { ok: true };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Conflict sidecar delete failed: ${msg}` };
  }
}
