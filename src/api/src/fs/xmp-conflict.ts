/**
 * Conflict-copy XMP sidecars — the "two devices edited the same photo" branch
 * of the sidecar contract, split out of `xmp.ts` (which had reached its
 * file-size budget) as its own cohesive unit.
 *
 * When `writeXmpWithPrecondition` finds the on-disk mtime no longer matches the
 * one the client last read, it must not clobber the other device's edits: it
 * writes to `<base> (conflict from <device>).xmp` and leaves the canonical
 * sidecar alone. Everything needed to compose, validate, read, write,
 * enumerate, and delete those files lives here.
 *
 * Path validation is security-relevant: `resolveConflictSidecarPath` is the one
 * gate between an API-supplied basename and a filesystem path, and it only ever
 * yields a sibling of the asset whose name matches the conflict pattern.
 */

import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
// Mirror-aware drop-in: durable writes/moves replicate to the library's
// configured backup root(s). Same `fs/promises` surface — see `mirrored.ts`.
import * as fs from './mirrored.ts';
import { readFileWithFailover } from './mirror-read.ts';
import { safeWriteAllowed } from './root.ts';
import type { OpResult } from './root.ts';
import { isVideoFilename } from '../indexer/media-types.ts';

/** Sanitize a device name for use in a conflict-copy filename. */
function sanitizeDeviceName(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return 'Unknown device';
  return trimmed.replace(/[/\\:*?"<>|]/g, '-').slice(0, 64);
}

/**
 * Same stem(image)/full-name(video) split as `xmpSidecarPath`, as a bare
 * `<base>` shared by every sidecar-address fn in this module (#1678/#2481).
 *
 * Load-bearing for Apple Live Photos: `IMG_1234.HEIC` and `IMG_1234.MOV` are
 * two independent same-stem assets, so a stem-swap base would make the video's
 * conflict copy collide with the photo's, and would make `listPairedSidecars`
 * hand a video's relocation the photo's sidecar. Keep the writer
 * (`conflictCopyPath`) and the matchers (`resolveConflictSidecarPath`,
 * `listPairedSidecars`) on this one helper — they MUST agree on the base or a
 * video's conflict sidecar is stranded on relocate.
 */
function sidecarBase(rawAbsPath: string): string {
  return path.basename(rawAbsPath, isVideoFilename(rawAbsPath) ? '' : path.extname(rawAbsPath));
}

/** Compose the conflict-copy path for a given RAW + device name (video-aware, #2481). */
export function conflictCopyPath(rawAbsPath: string, deviceName: string): string {
  const base = path.join(path.dirname(rawAbsPath), sidecarBase(rawAbsPath));
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

  const rawBase = sidecarBase(rawAbsPath); // e.g. "IMG_1" (video: full filename)

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
 * doesn't validate or the file doesn't exist. Reads the primary; a mirror is
 * consulted only when the primary volume is unreachable (`mirror-read.ts`).
 */
export async function readConflictSidecar(
  rawAbsPath: string,
  conflictBasename: string,
): Promise<OpResult<string>> {
  const sidecar = resolveConflictSidecarPath(rawAbsPath, conflictBasename);
  if (!sidecar) return { ok: false, error: 'Invalid conflict basename' };
  try {
    const content = await readFileWithFailover(sidecar);
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
  const rawBase = sidecarBase(rawAbsPath);
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
  const escaped = escapeRegex(rawBase);
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
