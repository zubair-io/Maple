import * as fs from './mirrored.ts';
import { errnoCode } from './relocate-publish.ts';

/** A sidecar name that is a symlink or anything other than a regular file. */
export class SidecarNotRegularFileError extends Error {
  constructor(readonly sidecar: string) {
    super(`relocate: sidecar is not a regular file (symlink?): ${sidecar}`);
    this.name = 'SidecarNotRegularFileError';
  }
}

/** Read that refuses a final-component symlink (#4749), so a sidecar link to
 * an original is never copied into a destination `.xmp`. Windows has no
 * `O_NOFOLLOW`, so the name is lstat'd first and the opened handle must be
 * that same file, which also closes a swap between the two calls. Callers
 * have already jailed the asset's folder; the DB-backed sidecar jail is not
 * consulted because a refusal would move the photo without its edits. */
export async function readSidecarBytes(
  sidecar: string,
  noFollowFlag: number = fs.constants.O_NOFOLLOW ?? 0,
): Promise<Buffer | null> {
  const named = await fs.lstat(sidecar, { bigint: true }).catch((err: unknown) => {
    if (errnoCode(err) === 'ENOENT') return null;
    throw err;
  });
  if (named === null) return null;
  if (!named.isFile()) throw new SidecarNotRegularFileError(sidecar);
  const handle = await fs.open(sidecar, fs.constants.O_RDONLY | noFollowFlag).catch((err) => {
    if (errnoCode(err) === 'ENOENT') return null;
    throw errnoCode(err) === 'ELOOP' ? new SidecarNotRegularFileError(sidecar) : err;
  });
  if (handle === null) return null;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino) {
      throw new SidecarNotRegularFileError(sidecar);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
