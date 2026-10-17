import { randomBytes } from 'node:crypto';
import * as fs from './mirrored.ts';
import { filesIdentical } from '../backup/fs-util.ts';

export interface RelocatePublication {
  path: string;
  dev: number;
  ino: number;
}

export function isPublishCollision(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST';
}

export async function copyVerifiedIntoPlace(
  src: string,
  destination: string,
  replace: boolean,
  publications: RelocatePublication[],
): Promise<void> {
  const tmp = `${destination}.tmp.${process.pid}-${randomBytes(8).toString('hex')}`;
  try {
    await fs.copyFile(src, tmp);
    if (!(await filesIdentical(src, tmp))) {
      throw new Error(`relocate: copy verification failed: ${src} -> ${destination}`);
    }
    const identity = await fs.lstat(tmp);
    if (replace) {
      await fs.rename(tmp, destination);
    } else {
      try {
        await fs.link(tmp, destination);
      } catch (error) {
        if (
          !(
            error &&
            typeof error === 'object' &&
            'code' in error &&
            ['EXDEV', 'EPERM', 'EOPNOTSUPP', 'ENOTSUP', 'ENOSYS'].includes(String(error.code))
          )
        ) {
          throw error;
        }
        publications.push(await copyExclusive(tmp, destination));
        fs.replicatePath(destination);
        return;
      }
    }
    publications.push({ path: destination, dev: identity.dev, ino: identity.ino });
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

export async function revertCreated(publications: RelocatePublication[]): Promise<void> {
  for (const publication of publications.splice(0)) {
    // A sync client may have replaced our publication before rollback runs.
    const identity = await fs.lstat(publication.path).catch(() => null);
    if (identity?.dev === publication.dev && identity.ino === publication.ino) {
      await fs.unlink(publication.path).catch(() => {});
    }
  }
}

async function copyExclusive(source: string, destination: string): Promise<RelocatePublication> {
  const target = await fs.open(destination, 'wx');
  try {
    const identity = await target.stat();
    const publication = { path: destination, dev: identity.dev, ino: identity.ino };
    try {
      const input = await fs.open(source, 'r');
      try {
        await target.writeFile(input.createReadStream({ autoClose: false }));
      } finally {
        await input.close();
      }
      return publication;
    } catch (error) {
      await revertCreated([publication]);
      throw error;
    }
  } finally {
    await target.close();
  }
}
