/**
 * Sidecar relocation for external-rename reconciliation (#4702).
 *
 * Moves (or copies, when a live same-stem sibling still uses the source
 * sidecar) `<oldstem>.xmp` to `<newstem>.xmp` under `serializeSidecarWrite` on
 * both paths. Publishes exclusively (`link` + `unlink` with `COPYFILE_EXCL`
 * fallback) so an occupied `<newstem>.xmp` is never clobbered — on `EEXIST`,
 * the incoming sidecar lands at `<newstem> (conflict from rename).xmp`.
 * A pre-#5021 `<name>.<ext>.xmp` follows separately, after those locks are
 * released, and stays in place when its destination is taken (#5063).
 */
import * as path from 'node:path';
import type { ObjectId } from '../../db/object-id.ts';
import { listRecordedInDirectory } from '../../db/repos/assets.discover.sweep.ts';
import * as fs from '../../fs/mirrored.ts';
import { classifySameFile } from '../../fs/relocate-case-only-rename.ts';
import { isWithinRoot, resolveRealPath } from '../../fs/root.ts';
import {
  serializeSidecarWrite,
  SidecarWritePathDeniedError,
} from '../../fs/sidecar-write-order.ts';
import { sidecarAlreadyCarried } from '../../fs/sidecar-ownership.ts';
import { pickFreeConflictPath } from '../../fs/xmp-conflict.ts';
import { xmpSidecarPath } from '../../fs/xmp.ts';
import {
  legacyBackupSidecar,
  locateLegacyBackupEdit,
  oldNameSlotTaken,
  readLegacyAt,
} from '../../fs/legacy-backup-sidecar.ts';
import { child } from '../../log.ts';

const log = child('discover:rename-reconcile');
const NON_PRIMARY_EXTENSIONS = new Set(['.xmp', '.hidden']);
const RENAME_CONFLICT_ATTEMPTS = 5;

function comparablePath(p: string): string {
  return path.resolve(p).normalize('NFC').toLowerCase().normalize('NFC');
}

function isErrno(err: unknown, code: string): boolean {
  return (
    !!err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === code
  );
}

/** Resolve a sidecar path to its canonical realpath (resolving parent symlinks
 * when the destination file does not exist yet, and rejecting dangling symlinks). */
async function resolveCanonicalSidecarPath(sidecarPath: string): Promise<string> {
  const lexical = path.resolve(sidecarPath);
  const name = path.basename(lexical);
  if (name === '.' || name === '..') {
    throw new SidecarWritePathDeniedError('Sidecar destination must name a file');
  }
  try {
    return await resolveRealPath(lexical);
  } catch (err) {
    if (!isErrno(err, 'ENOENT')) throw err;
    const st = await fs.lstat(lexical).catch((lstatErr: unknown) => {
      if (isErrno(lstatErr, 'ENOENT')) return null;
      throw lstatErr;
    });
    if (st?.isSymbolicLink()) {
      throw new SidecarWritePathDeniedError(`Dangling symlink sidecar path denied: "${lexical}"`);
    }
    const parent = await resolveRealPath(path.dirname(lexical));
    return path.join(parent, name);
  }
}

async function authorizeSidecarWrite(sidecarPath: string, root: string): Promise<string> {
  const [canonicalPath, canonicalRoot] = await Promise.all([
    resolveCanonicalSidecarPath(sidecarPath),
    resolveRealPath(path.resolve(root)).catch(() => path.resolve(root)),
  ]);
  if (!isWithinRoot(canonicalRoot, canonicalPath)) {
    throw new SidecarWritePathDeniedError(
      `Sidecar path "${canonicalPath}" escapes library root "${canonicalRoot}"`,
    );
  }
  if (path.extname(canonicalPath).toLowerCase() !== '.xmp') {
    throw new SidecarWritePathDeniedError(
      `Sidecar path "${canonicalPath}" must resolve to an .xmp file`,
    );
  }
  return canonicalPath;
}

async function authorizeSidecarRead(sidecarPath: string, root: string): Promise<string> {
  return authorizeSidecarWrite(sidecarPath, root);
}

/** Acquire `serializeSidecarWrite` on both `oldSidecar` and `newSidecar` in a
 * deterministic canonical-path order so two concurrent calls touching the same
 * pair (including via symlink aliases) can never deadlock or bypass barriers. */
async function withBothSidecarWriteLocks<T>(
  oldSidecar: string,
  newSidecar: string,
  root: string,
  fn: (resolvedOldSidecar: string, resolvedNewSidecar: string) => Promise<T>,
): Promise<T> {
  const [canonicalOld, canonicalNew] = await Promise.all([
    authorizeSidecarRead(oldSidecar, root),
    authorizeSidecarWrite(newSidecar, root),
  ]);
  const oldKey = comparablePath(canonicalOld);
  const newKey = comparablePath(canonicalNew);
  if (oldKey === newKey) {
    return serializeSidecarWrite(
      canonicalOld,
      async (resolvedOld) => {
        const resolvedNew = await authorizeSidecarWrite(newSidecar, root);
        return fn(resolvedOld, resolvedNew);
      },
      {
        admissionScope: root,
        resolveDestination: () => authorizeSidecarRead(oldSidecar, root),
      },
    );
  }
  const oldFirst = oldKey < newKey;
  const [first, second] = oldFirst ? [canonicalOld, canonicalNew] : [canonicalNew, canonicalOld];
  const [rawFirst, rawSecond] = oldFirst ? [oldSidecar, newSidecar] : [newSidecar, oldSidecar];
  return serializeSidecarWrite(
    first,
    (resolvedFirst) =>
      serializeSidecarWrite(
        second,
        (resolvedSecond) =>
          oldFirst ? fn(resolvedFirst, resolvedSecond) : fn(resolvedSecond, resolvedFirst),
        {
          admissionScope: root,
          resolveDestination: () => authorizeSidecarWrite(rawSecond, root),
        },
      ),
    {
      admissionScope: root,
      resolveDestination: () => authorizeSidecarWrite(rawFirst, root),
    },
  );
}

function isPrimaryDiskEntry(entry: { isDirectory(): boolean; name: string }): boolean {
  if (entry.isDirectory()) return false;
  if (entry.name.startsWith('.') || entry.name.includes('.tmp.')) return false;
  return !NON_PRIMARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase());
}

function resolvesToTargetSidecar(
  candidateAbsPath: string,
  targetSidecarKey: string,
  skipAbsKeys: ReadonlySet<string>,
): boolean {
  if (skipAbsKeys.has(comparablePath(candidateAbsPath))) return false;
  return comparablePath(xmpSidecarPath(candidateAbsPath)) === targetSidecarKey;
}

async function hasDiskSiblingSharingSidecar(
  dir: string,
  targetSidecarKey: string,
  skipAbsKeys: ReadonlySet<string>,
): Promise<boolean> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return true;
  return entries.some(
    (entry) =>
      isPrimaryDiskEntry(entry) &&
      resolvesToTargetSidecar(path.join(dir, entry.name), targetSidecarKey, skipAbsKeys),
  );
}

function isLiveRecordedSibling(
  fileinfo: { filename: string; deleted_at?: string | null; missing_since?: string | null },
  missingFilenames: ReadonlySet<string>,
): boolean {
  return (
    !fileinfo.deleted_at && !fileinfo.missing_since && !missingFilenames.has(fileinfo.filename)
  );
}

async function hasRecordedSiblingSharingSidecar(
  dir: string,
  folderId: ObjectId,
  relDir: string,
  targetSidecarKey: string,
  skipAbsKeys: ReadonlySet<string>,
  missingFilenames: ReadonlySet<string>,
): Promise<boolean> {
  const recorded = await listRecordedInDirectory(folderId, relDir);
  return recorded.some(
    (row) =>
      isLiveRecordedSibling(row.fileinfo, missingFilenames) &&
      resolvesToTargetSidecar(path.join(dir, row.fileinfo.filename), targetSidecarKey, skipAbsKeys),
  );
}

/** True when another live primary in the same folder still resolves to
 * `oldAbsPath`'s sidecar (e.g. a RAW+JPEG pair where only one half was renamed). */
async function hasLiveSameStemSibling(
  oldAbsPath: string,
  newAbsPath: string,
  folderId: ObjectId,
  relDir: string,
  missingFilenames: ReadonlySet<string>,
): Promise<boolean> {
  const dir = path.dirname(oldAbsPath);
  const targetSidecarKey = comparablePath(xmpSidecarPath(oldAbsPath));
  const skipAbsKeys = new Set([comparablePath(oldAbsPath), comparablePath(newAbsPath)]);
  if (await hasDiskSiblingSharingSidecar(dir, targetSidecarKey, skipAbsKeys)) return true;
  return hasRecordedSiblingSharingSidecar(
    dir,
    folderId,
    relDir,
    targetSidecarKey,
    skipAbsKeys,
    missingFilenames,
  );
}

async function linkExclusive(src: string, dst: string): Promise<'published' | 'exists'> {
  try {
    await fs.link(src, dst);
    return 'published';
  } catch (err) {
    if (isErrno(err, 'EEXIST')) return 'exists';
    if (!isErrno(err, 'EXDEV') && !isErrno(err, 'ENOTSUP') && !isErrno(err, 'EPERM')) throw err;
    try {
      await fs.copyFile(src, dst, fs.constants.COPYFILE_EXCL);
      return 'published';
    } catch (copyErr) {
      if (isErrno(copyErr, 'EEXIST')) return 'exists';
      throw copyErr;
    }
  }
}

async function publishSidecarExclusive(
  srcSidecar: string,
  dstSidecar: string,
  root: string,
  keepSource: boolean,
): Promise<'published' | 'exists'> {
  const [authorizedSrc, authorizedDst] = await Promise.all([
    authorizeSidecarRead(srcSidecar, root),
    authorizeSidecarWrite(dstSidecar, root),
  ]);
  if (!keepSource) {
    const result = await linkExclusive(authorizedSrc, authorizedDst);
    if (result === 'published') {
      await fs.unlink(authorizedSrc).catch((err) => {
        log.warn(
          {
            srcSidecar: authorizedSrc,
            dstSidecar: authorizedDst,
            err: err instanceof Error ? err.message : err,
          },
          'rename-reconcile: source sidecar unlink failed after publish — duplicate retained',
        );
      });
    }
    return result;
  }
  const tmp = `${authorizedDst}.tmp.${process.pid}-${crypto.randomUUID()}`;
  try {
    await fs.copyFile(authorizedSrc, tmp);
    return await linkExclusive(tmp, authorizedDst);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

/** Moves (or copies, when a live sibling still shares the stem) the sidecar
 * from the old RAW's path to the new one under `serializeSidecarWrite` on both
 * paths (#4702). Publishes with `link` + `unlink` (`COPYFILE_EXCL` fallback) so
 * an occupied `<newstem>.xmp` is never clobbered — on `EEXIST` the incoming
 * sidecar lands at `<newstem> (conflict from rename).xmp` instead. */
export async function moveSidecarIfPresent(
  oldAbsPath: string,
  newAbsPath: string,
  root: string,
  folderId: ObjectId,
  relDir: string,
  missingFilenames: ReadonlySet<string>,
): Promise<boolean> {
  const oldSidecar = xmpSidecarPath(oldAbsPath);
  const newSidecar = xmpSidecarPath(newAbsPath);
  try {
    return await withBothSidecarWriteLocks(
      oldSidecar,
      newSidecar,
      root,
      async (resolvedOld, resolvedNew) => {
        try {
          await fs.stat(resolvedOld);
        } catch (err) {
          if (isErrno(err, 'ENOENT')) return true; // nothing to move
          throw err;
        }

        const keepSource = await hasLiveSameStemSibling(
          oldAbsPath,
          newAbsPath,
          folderId,
          relDir,
          missingFilenames,
        );
        const classification = await classifySameFile(resolvedOld, resolvedNew);
        if (classification === 'identical') return true;
        if (classification === 'case-only-rename') {
          if (!keepSource) await fs.rename(resolvedOld, resolvedNew);
          return true;
        }

        const primaryOutcome = await publishSidecarExclusive(
          resolvedOld,
          resolvedNew,
          root,
          keepSource,
        );
        if (primaryOutcome === 'published') return true;

        const conflictPath = await pickFreeConflictPath(newAbsPath, 'rename');
        const conflictOutcome = await serializeSidecarWrite(
          conflictPath,
          (authorizedConflict) =>
            publishSidecarExclusive(resolvedOld, authorizedConflict, root, keepSource),
          {
            admissionScope: root,
            resolveDestination: () => authorizeSidecarWrite(conflictPath, root),
          },
        );
        return conflictOutcome === 'published';
      },
    );
  } catch (err) {
    log.warn(
      { oldSidecar, newSidecar, err: err instanceof Error ? err.message : err },
      'rename-reconcile: sidecar move failed',
    );
    return false;
  }
}

/** A taken name, as the canonical move does: the edit lands beside the photo as
 * `<newstem> (conflict from rename).xmp` rather than staying behind with none. */
async function publishRenameConflict(source: string, newAbsPath: string, root: string) {
  // Another writer can take the picked name before the exclusive publish; pick again.
  for (let attempt = 0; attempt < RENAME_CONFLICT_ATTEMPTS; attempt++) {
    const conflictPath = await pickFreeConflictPath(newAbsPath, 'rename');
    const outcome = await serializeSidecarWrite(
      conflictPath,
      (authorized) => publishSidecarExclusive(source, authorized, root, false),
      {
        admissionScope: root,
        resolveDestination: () => authorizeSidecarWrite(conflictPath, root),
      },
    );
    if (outcome === 'published') return;
  }
  throw new Error(`rename-reconcile: no free conflict name for ${newAbsPath}`);
}

/** Carries a photo's pre-#5021 `IMG.dng.xmp` to its new full name (#5063), so the
 * canonical-sidecars migration still finds it. Runs after the canonical move's
 * locks are released; a taken name gets a conflict copy, and a failure leaves it in place. */
export async function moveLegacySidecarIfPresent(
  oldAbsPath: string,
  newAbsPath: string,
  root: string,
): Promise<void> {
  const newLegacy = legacyBackupSidecar(newAbsPath);
  if (newLegacy === null) return;
  try {
    // As stored, case variant included; a folder that can't be listed throws.
    const found = await locateLegacyBackupEdit(oldAbsPath);
    if (found === null) return;
    const oldLegacy = found.legacy;
    await withBothSidecarWriteLocks(
      oldLegacy,
      newLegacy,
      root,
      async (resolvedOld, resolvedNew) => {
        // The lexical name: the ownership check compares folder entries, which a
        // symlinked root's realpath would never match.
        if ((await readLegacyAt(oldAbsPath, oldLegacy)) === null) return;
        const classification = await classifySameFile(resolvedOld, resolvedNew);
        if (classification === 'identical') return;
        if (classification === 'case-only-rename') return fs.rename(resolvedOld, resolvedNew);
        // On a case-sensitive volume the edit's own spelling counts as taking its slot,
        // so only the exclusive publish decides: an occupied spelling gets a conflict copy.
        const ownSpelling =
          path.basename(oldLegacy).toLowerCase() === path.basename(newLegacy).toLowerCase();
        const landed =
          (ownSpelling || !(await oldNameSlotTaken(newAbsPath))) &&
          (await publishSidecarExclusive(resolvedOld, resolvedNew, root, false)) === 'published';
        if (landed) return;
        if (await sidecarAlreadyCarried(resolvedOld, resolvedNew)) return fs.unlink(resolvedOld);
        await publishRenameConflict(resolvedOld, newAbsPath, root);
      },
    );
  } catch (err) {
    // No retry path: discover re-attaches the renamed photo by content even if
    // this rename were declined, so the edit is kept at the old path and flagged.
    log.error(
      { oldAbsPath, newLegacy, err: err instanceof Error ? err.message : err },
      'rename-reconcile: old-name sidecar move failed — left in place',
    );
  }
}
