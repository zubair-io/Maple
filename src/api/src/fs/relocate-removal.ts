/** #1472: a RAW relocation carries its immutable edit assets before repoint/delete. */
import * as fs from './mirrored.ts';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ffiPool } from '../ffi/ffi-pool.ts';
import { filesIdentical } from '../backup/fs-util.ts';
import { listPairedSidecars } from './xmp-conflict.ts';
import { removalRecords } from './removal-records.ts';
import { sidecarRenameTarget } from './sidecar-rename.ts';
import { child as childLogger } from '../log.ts';
import { createRemovalJournal } from './removal-relocation-journal.ts';
import type { RelocateOutcome, RelocateRequest } from './relocate.ts';

const log = childLogger('fs/removal-relocate');
interface Snapshot {
  path: string;
  bytes: Buffer<ArrayBuffer>;
  records: string | null;
}

async function snapshots(raw: string): Promise<Snapshot[]> {
  return Promise.all(
    (await listPairedSidecars(raw)).sort().map(async (path) => {
      const bytes = await fs.readFile(path);
      return { path, bytes, records: removalRecords(bytes.toString('utf8')) };
    }),
  );
}

async function assertSidecars(raw: string, expected: readonly Snapshot[]) {
  const current = await snapshots(raw);
  const byPath = new Map(expected.map((entry) => [entry.path, entry.bytes]));
  if (
    current.length !== expected.length ||
    current.some((entry) => !entry.bytes.equals(byPath.get(entry.path) ?? Buffer.alloc(0)))
  )
    throw new Error('Photo sidecars changed during removal relocation; source retained');
}

async function verify(raw: string, sidecars: readonly Snapshot[], digest?: string) {
  const values = await Promise.all(
    sidecars
      .filter((value) => value.records !== null)
      .map((value) => ffiPool().verifyRemovalAssets(raw, value.records!)),
  );
  const originalDigest = values[0].originalDigest;
  if (
    values.some((value) => value.originalDigest !== originalDigest) ||
    (digest && digest !== originalDigest)
  )
    throw new Error('Original changed during removal relocation; source retained');
  return { originalDigest, names: [...new Set(values.flatMap((value) => value.names))] };
}

async function existing(path: string) {
  return fs.lstat(path).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  });
}

async function syncDirectory(path: string) {
  const directory = await fs.open(path, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function ensureAssetsDirectory(raw: string) {
  const maple = join(dirname(raw), '.maple');
  const assets = join(maple, 'inpaint');
  for (const path of [maple, assets]) {
    const info = await existing(path);
    if (info && (!info.isDirectory() || info.isSymbolicLink()))
      throw new Error('Removal companion directory must not be a link or file');
    await fs.mkdir(path, { recursive: true });
    await syncDirectory(dirname(path));
  }
  return assets;
}

async function syncCopy(source: string, temp: string) {
  await fs.copyFile(source, temp);
  if (!(await filesIdentical(source, temp)))
    throw new Error(`Removal copy verification failed: ${source}`);
  const file = await fs.open(temp, 'r+');
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

async function copyAsset(source: string, target: string) {
  const info = await existing(target);
  if (info) {
    if (!info.isFile() || info.isSymbolicLink() || !(await filesIdentical(source, target)))
      throw new Error(`Existing removal companion is corrupt or unsafe: ${target}`);
    return;
  }
  const temp = `${target}.tmp.${randomUUID()}`;
  try {
    await syncCopy(source, temp);
    // Create-only publication: accepted bytes cannot overwrite another edit.
    await fs.link(temp, target).catch(async (error) => {
      if (error?.code !== 'EEXIST') throw error;
      const current = await existing(target);
      if (!current?.isFile() || current.isSymbolicLink() || !(await filesIdentical(source, target)))
        throw new Error('Removal companion changed during publication');
    });
    await syncDirectory(dirname(target));
  } finally {
    await fs.rm(temp, { force: true });
  }
}

/** Null retains the existing ordinary-file path. Accepted edits are strict:
 * source assets are never deleted (other photos may share them), and a failed
 * destination/identity step restores previous occupants rather than losing edits.
 * The ordinary relocate primitive holds the source/destination lease throughout. */
export async function relocateRemoval(
  req: RelocateRequest,
  target: string,
): Promise<RelocateOutcome | null> {
  const source = await snapshots(req.sourceAbsPath);
  if (!source.some((value) => value.records !== null)) return null;
  if (process.platform !== 'darwin' && process.platform !== 'linux')
    throw new Error('Removal relocation requires a POSIX filesystem lease');
  return relocateUnderLease(req, target, source);
}

async function relocateUnderLease(
  req: RelocateRequest,
  target: string,
  source: Snapshot[],
): Promise<RelocateOutcome> {
  const proof = await verify(req.sourceAbsPath, source);
  const pairs = source.map((value) => ({
    ...value,
    target: sidecarRenameTarget(req.sourceAbsPath, target, value.path)!,
  }));
  let repointed = false;
  let journal: Awaited<ReturnType<typeof createRemovalJournal>> | undefined;
  const publish = async (path: string, bytes: Buffer<ArrayBuffer> | null, from?: string) => {
    const temp = `${path}.tmp.${randomUUID()}`;
    try {
      if (bytes) {
        const file = await fs.open(temp, 'wx');
        try {
          await file.writeFile(bytes);
          await file.sync();
        } finally {
          await file.close();
        }
      } else await syncCopy(from!, temp);
      await fs.rename(temp, path);
      await syncDirectory(dirname(path));
    } finally {
      await fs.rm(temp, { force: true });
    }
  };
  try {
    const assets = await ensureAssetsDirectory(target);
    for (const name of proof.names)
      await copyAsset(join(dirname(req.sourceAbsPath), '.maple/inpaint', name), join(assets, name));
    const companionPaths: string[] = [];
    const companionSources = req.extraCompanionAbsPaths ?? [];
    for (const path of companionSources) {
      const candidate =
        sidecarRenameTarget(req.sourceAbsPath, target, path) ??
        join(dirname(target), path.split('/').at(-1)!);
      const { pickFreePath } = await import('./relocate.ts');
      companionPaths.push(await pickFreePath(candidate, 'relocate:companion'));
    }
    const staleSidecars = (await listPairedSidecars(target)).filter(
      (path) => !pairs.some((pair) => pair.target === path),
    );
    journal = await createRemovalJournal(
      req.sourceAbsPath,
      target,
      [req.sourceAbsPath, ...source.map((value) => value.path), ...companionSources],
      [
        { target, source: req.sourceAbsPath },
        ...pairs.map((pair) => ({ target: pair.target, bytes: pair.bytes })),
        ...staleSidecars.map((path) => ({ target: path })),
        ...companionPaths.map((path, index) => ({ target: path, source: companionSources[index] })),
      ],
    );
    await assertSidecars(req.sourceAbsPath, source);
    await publish(target, null, req.sourceAbsPath);
    for (const pair of pairs) await publish(pair.target, pair.bytes);
    // Remove a replaced occupant's unmatched sidecars with rollback evidence.
    for (const stale of staleSidecars) {
      await fs.unlink(stale);
      await syncDirectory(dirname(stale));
    }
    const destination = pairs.map((pair) => ({ ...pair, path: pair.target }));
    await assertSidecars(
      target,
      destination.sort((a, b) => a.path.localeCompare(b.path)),
    );
    await verify(target, destination, proof.originalDigest);
    await assertSidecars(req.sourceAbsPath, source);
    await verify(req.sourceAbsPath, source, proof.originalDigest);
    for (const [index, path] of companionSources.entries())
      await publish(companionPaths[index], null, path);
    await req.onVerified?.({
      newAbsPath: target,
      sidecarPaths: pairs.map((value) => value.target),
      companionPaths,
    });
    repointed = true;
    // A later save must never be unlinked under the old snapshot. Once the
    // identity hook succeeds, keep both copies on conflict because a catalogue
    // can already refer to the verified destination.
    await assertSidecars(req.sourceAbsPath, source);
    await verify(req.sourceAbsPath, source, proof.originalDigest);
    await assertSidecars(target, destination);
    await verify(target, destination, proof.originalDigest);
    if (req.mode === 'move') {
      const deleted = await fs.unlink(req.sourceAbsPath).then(
        () => true,
        (error) => {
          log.warn(
            { error, path: req.sourceAbsPath },
            'verified destination retained; source delete failed',
          );
          return false;
        },
      );
      if (deleted)
        for (const path of [...source.map((value) => value.path), ...companionSources])
          if (!pairs.some((pair) => pair.target === path))
            await fs
              .unlink(path)
              .catch((error) =>
                log.warn(
                  { error, path },
                  'source sidecar/companion delete failed after verified copy',
                ),
              );
    }
    await journal.finish();
    return {
      kind: 'relocated',
      newAbsPath: target,
      sidecarPaths: pairs.map((value) => value.target),
      companionPaths,
      renamedOnCollision: target !== req.destAbsPath,
    };
  } catch (error) {
    if (!repointed) await journal?.rollback();
    return { kind: 'error', error: String(error) };
  }
}
