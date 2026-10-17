/**
 * Sidecar relocation for external-rename reconciliation (#4702).
 *
 * Moves (or copies, when a live same-stem sibling still uses the source
 * sidecar) `<oldstem>.xmp` to `<newstem>.xmp` under `serializeSidecarWrite` on
 * both paths. Publishes exclusively (`link` + `unlink` with `COPYFILE_EXCL`
 * fallback) so an occupied `<newstem>.xmp` is never clobbered — on `EEXIST`,
 * the incoming sidecar lands at `<newstem> (conflict from rename).xmp`.
 */
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import type { ObjectId } from '../../db/object-id.ts';
import { listRecordedInDirectory } from '../../db/repos/assets.discover.sweep.ts';
import * as fs from '../../fs/mirrored.ts';
import { classifySameFile } from '../../fs/relocate-case-only-rename.ts';
import { serializeSidecarWrite } from '../../fs/sidecar-write-order.ts';
import { pickFreeConflictPath } from '../../fs/xmp-conflict.ts';
import { xmpSidecarPath } from '../../fs/xmp.ts';
import { child } from '../../log.ts';

const log = child('discover:rename-reconcile');

function comparablePath(p: string): string {
  return path.resolve(p).normalize('NFC').toLowerCase().normalize('NFC');
}

function isErrno(err: unknown, code: string): boolean {
  return (
    !!err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === code
  );
}

/** Acquire `serializeSidecarWrite` on both `oldSidecar` and `newSidecar` in a
 * deterministic path order so two concurrent calls touching the same pair can
 * never deadlock. */
function withBothSidecarWriteLocks<T>(
  oldSidecar: string,
  newSidecar: string,
  root: string,
  fn: () => Promise<T>,
): Promise<T> {
  const oldKey = comparablePath(oldSidecar);
  const newKey = comparablePath(newSidecar);
  if (oldKey === newKey) {
    return serializeSidecarWrite(oldSidecar, () => fn(), { admissionScope: root });
  }
  const [first, second] = oldKey < newKey ? [oldSidecar, newSidecar] : [newSidecar, oldSidecar];
  return serializeSidecarWrite(
    first,
    () => serializeSidecarWrite(second, () => fn(), { admissionScope: root }),
    { admissionScope: root },
  );
}

/** True when another live primary in the same folder still resolves to
 * `oldAbsPath`'s sidecar (e.g. a RAW+JPEG pair where only one half was renamed).
 * Checks both the directory on disk and live DB rows not in `missingFilenames`;
 * an unlistable directory conservatively counts as claimed so the source
 * sidecar is kept rather than unlinked. */
async function hasLiveSameStemSibling(
  oldAbsPath: string,
  newAbsPath: string,
  folderId: ObjectId,
  relDir: string,
  missingFilenames: ReadonlySet<string>,
): Promise<boolean> {
  const dir = path.dirname(oldAbsPath);
  const targetSidecar = comparablePath(xmpSidecarPath(oldAbsPath));
  const skipAbs = new Set([comparablePath(oldAbsPath), comparablePath(newAbsPath)]);

  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return true;
  for (const entry of entries) {
    if (entry.isDirectory() || entry.name.startsWith('.') || entry.name.includes('.tmp.')) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (ext === '.xmp' || ext === '.hidden') continue;
    const entryAbs = path.join(dir, entry.name);
    if (skipAbs.has(comparablePath(entryAbs))) continue;
    if (comparablePath(xmpSidecarPath(entryAbs)) === targetSidecar) return true;
  }

  const recorded = await listRecordedInDirectory(folderId, relDir);
  for (const row of recorded) {
    if (row.fileinfo.deleted_at || row.fileinfo.missing_since) continue;
    if (missingFilenames.has(row.fileinfo.filename)) continue;
    const rowAbs = path.join(dir, row.fileinfo.filename);
    if (skipAbs.has(comparablePath(rowAbs))) continue;
    if (comparablePath(xmpSidecarPath(rowAbs)) === targetSidecar) return true;
  }
  return false;
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
  keepSource: boolean,
): Promise<'published' | 'exists'> {
  if (!keepSource) {
    const result = await linkExclusive(srcSidecar, dstSidecar);
    if (result === 'published') {
      await fs.unlink(srcSidecar).catch((err) => {
        log.warn(
          { srcSidecar, dstSidecar, err: err instanceof Error ? err.message : err },
          'rename-reconcile: source sidecar unlink failed after publish — duplicate retained',
        );
      });
    }
    return result;
  }
  const tmp = `${dstSidecar}.tmp.${process.pid}-${randomBytes(4).toString('hex')}`;
  await fs.copyFile(srcSidecar, tmp);
  try {
    return await linkExclusive(tmp, dstSidecar);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

/** Moves (or copies, when a live sibling still shares the stem) the sidecar
 * from the old RAW's path to the new one under `serializeSidecarWrite` on both
 * paths (#4702). Publishes with `link` + `unlink` (`COPYFILE_EXCL` fallback) so
 * an occupied `<newstem>.xmp` is never clobbered — on `EEXIST` the incoming
 * sidecar lands at `<newstem> (conflict from rename).xmp` instead.
 *
 * Returns `false` only on a genuine move FAILURE (sidecar present but
 * couldn't be relocated). Returns `true` when there was no sidecar to move
 * at all (never edited) or the move succeeded. */
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
    return await withBothSidecarWriteLocks(oldSidecar, newSidecar, root, async () => {
      try {
        await fs.stat(oldSidecar);
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
      const classification = await classifySameFile(oldSidecar, newSidecar);
      if (classification === 'identical') return true;
      if (classification === 'case-only-rename') {
        if (!keepSource) await fs.rename(oldSidecar, newSidecar);
        return true;
      }

      const primaryOutcome = await publishSidecarExclusive(oldSidecar, newSidecar, keepSource);
      if (primaryOutcome === 'published') return true;

      const conflictPath = await pickFreeConflictPath(newAbsPath, 'rename');
      const conflictOutcome = await serializeSidecarWrite(
        conflictPath,
        () => publishSidecarExclusive(oldSidecar, conflictPath, keepSource),
        { admissionScope: root },
      );
      return conflictOutcome === 'published';
    });
  } catch (err) {
    log.warn(
      { oldSidecar, newSidecar, err: err instanceof Error ? err.message : err },
      'rename-reconcile: sidecar move failed',
    );
    return false;
  }
}
