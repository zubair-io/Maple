/** #1472: a RAW relocation carries its immutable edit assets before repoint/delete. */
import * as fs from './mirrored.ts';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ffiPool } from '../ffi/ffi-pool.ts';
import { filesIdentical } from '../backup/fs-util.ts';
import { listPairedSidecars } from './xmp-conflict.ts';
import { removalRecords } from './removal-records.ts';
import {
  assertRemovalRecovered,
  recoverRemovalRelocation,
  removalCoordinationRequired,
  syncRemovalDirectory,
} from './removal-relocation-journal.ts';
import { removalRelocationLease } from './removal-relocation-lease.ts';

const posix = () => process.platform === 'darwin' || process.platform === 'linux';

async function acceptedRecords(raw: string): Promise<string[]> {
  const records = await Promise.all(
    (await listPairedSidecars(raw)).map(async (path) => {
      const xml = await fs.readFile(path, 'utf8').catch(() => null);
      return xml === null ? null : removalRecords(xml);
    }),
  );
  return records.filter((value): value is string => value !== null);
}

async function existing(path: string) {
  return fs.lstat(path).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  });
}

async function ensureAssetsDirectory(raw: string) {
  const maple = join(dirname(raw), '.maple');
  const assets = join(maple, 'inpaint');
  for (const path of [maple, assets]) {
    const info = await existing(path);
    if (info && (!info.isDirectory() || info.isSymbolicLink()))
      throw new Error('Removal companion directory must not be a link or file');
    await fs.mkdir(path, { recursive: true });
    await syncRemovalDirectory(dirname(path));
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
    await syncRemovalDirectory(dirname(target));
  } finally {
    await fs.rm(temp, { force: true });
  }
}

/** Copies the verified companion assets every accepted record names into the
 * destination folder before the relocate pipeline publishes the sidecars. Source
 * assets are never deleted: other photos may share them. */
export async function carryRemovalAssets(sourceRaw: string, targetRaw: string): Promise<void> {
  const records = await acceptedRecords(sourceRaw);
  if (records.length === 0) return;
  if (!posix()) throw new Error('Removal relocation requires a POSIX filesystem lease');
  const verified = await Promise.all(
    records.map((value) => ffiPool().verifyRemovalAssets(sourceRaw, value)),
  );
  if (verified.some((value) => value.originalDigest !== verified[0].originalDigest))
    throw new Error('Original changed during removal relocation; source retained');
  const assets = await ensureAssetsDirectory(targetRaw);
  const names = new Set(verified.flatMap((value) => value.names));
  for (const name of names)
    await copyAsset(join(dirname(sourceRaw), '.maple/inpaint', name), join(assets, name));
}

/** Only photos carrying accepted removals (or an interrupted removal
 * relocation) take the kernel lease; an ordinary move or trash must not leave
 * permanent coordination inodes in the user's folders. */
export async function withRelocationLease<T>(
  source: string,
  target: string,
  operation: () => Promise<T>,
): Promise<T> {
  await recoverRemovalRelocation(source);
  await recoverRemovalRelocation(target);
  if (!posix()) return operation();
  const required =
    (await removalCoordinationRequired(source, 'paired')) ||
    (await removalCoordinationRequired(target, 'paired'));
  if (!required) return operation();
  const lease = await removalRelocationLease(source, target);
  try {
    await assertRemovalRecovered(source);
    await assertRemovalRecovered(target);
    return await operation();
  } finally {
    await lease.release();
  }
}
