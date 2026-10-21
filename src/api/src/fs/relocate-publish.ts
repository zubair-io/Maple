import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as fs from './mirrored.ts';
import { filesIdentical } from '../backup/fs-util.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('fs/relocate-publish');

/** A name this relocation published, pinned to the inode it wrote, so a
 * rollback can tell its own file from one another writer put there since. */
export interface RelocatePublication {
  path: string;
  dev: number;
  ino: number;
}

/** Another writer holds the destination name; it is never replaced. */
export class PublishCollisionError extends Error {
  constructor(
    readonly destination: string,
    message = `relocate: destination is occupied: ${destination}`,
  ) {
    super(message);
    this.name = 'PublishCollisionError';
  }
}

const LINK_UNSUPPORTED = new Set(['EXDEV', 'EPERM', 'EOPNOTSUPP', 'ENOTSUP', 'ENOSYS']);

export function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

/** `.tmp.` in the basename keeps `mirrored.ts` from replicating the name. A
 * destination name too long for the suffix gets a short hidden sibling instead,
 * so a long file name stays inside the 255-byte limit. */
function privateSiblingOf(destination: string): string {
  const suffix = `.tmp.${process.pid}-${randomBytes(8).toString('hex')}`;
  const beside = `${destination}${suffix}`;
  return Buffer.byteLength(path.basename(beside)) <= 255
    ? beside
    : path.join(path.dirname(destination), suffix);
}

function samePublication(
  publication: RelocatePublication,
  identity: { dev: number; ino: number } | null,
): boolean {
  return identity?.dev === publication.dev && identity.ino === publication.ino;
}

/** Copy `src` beside `destination`, verify it byte-for-byte, then publish it:
 * exclusively, or by replacing the occupant only for an explicit Replace. The
 * publication is recorded only once the bytes are reachable at `destination`. */
export async function copyVerifiedIntoPlace(
  src: string,
  destination: string,
  replace: boolean,
  publications: RelocatePublication[],
): Promise<void> {
  const tmp = privateSiblingOf(destination);
  try {
    await fs.copyFile(src, tmp);
    if (!(await filesIdentical(src, tmp))) {
      throw new Error(`relocate: copy verification failed: ${src} -> ${destination}`);
    }
    publications.push(
      replace ? await replaceWith(tmp, destination) : await publishExclusive(tmp, destination),
    );
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

async function replaceWith(tmp: string, destination: string): Promise<RelocatePublication> {
  const identity = await fs.lstat(tmp);
  await fs.rename(tmp, destination);
  return { path: destination, dev: identity.dev, ino: identity.ino };
}

/** Publish the complete file at `tmp` under `destination` without ever
 * replacing an occupant. `tmp` stays for the caller to remove. */
export async function publishExclusive(
  tmp: string,
  destination: string,
): Promise<RelocatePublication> {
  const identity = await fs.lstat(tmp);
  try {
    await fs.link(tmp, destination);
  } catch (err) {
    if (errnoCode(err) === 'EEXIST') throw new PublishCollisionError(destination);
    if (!LINK_UNSUPPORTED.has(errnoCode(err) ?? '')) throw err;
    return copyExclusive(tmp, destination);
  }
  return { path: destination, dev: identity.dev, ino: identity.ino };
}

/** Fallback for volumes that cannot hard-link (SMB, exFAT). The name exists
 * before its bytes do, so another writer can rename over it mid-write; the
 * handle then fills an inode no name points at, which is a lost race. */
async function copyExclusive(source: string, destination: string): Promise<RelocatePublication> {
  const target = await fs.open(destination, 'wx').catch((err: unknown) => {
    throw errnoCode(err) === 'EEXIST' ? new PublishCollisionError(destination) : err;
  });
  const identity = await handleIdentity(target, destination);
  const publication = { path: destination, dev: identity.dev, ino: identity.ino };
  try {
    try {
      await streamInto(source, target);
    } finally {
      await target.close();
    }
    await confirmPublished(source, publication);
  } catch (err) {
    await revertCreated([publication]);
    throw err;
  }
  fs.replicatePath(destination);
  return publication;
}

/** The handle's inode, read twice before giving up. Without it the created
 * name cannot be tied to this move by inode, so ownership is proven through
 * the handle instead (`withdrawUnidentified`) before anything is removed. */
async function handleIdentity(
  target: fs.FileHandle,
  destination: string,
): Promise<{ dev: number; ino: number }> {
  try {
    return await target.stat().catch(() => target.stat());
  } catch (err) {
    await withdrawUnidentified(target, destination);
    await target.close().catch(() => {});
    throw err;
  }
}

/** Only an inode that genuinely differs is a collision; an `lstat` error
 * proves nothing about a competitor and propagates as itself. */
async function confirmPublished(source: string, publication: RelocatePublication): Promise<void> {
  if (!samePublication(publication, await fs.lstat(publication.path))) {
    throw new PublishCollisionError(publication.path);
  }
  if (!(await filesIdentical(source, publication.path))) {
    throw new Error(
      `relocate: fallback copy verification failed: ${source} -> ${publication.path}`,
    );
  }
}

async function streamInto(source: string, target: fs.FileHandle): Promise<void> {
  const input = await fs.open(source, 'r');
  try {
    let position = 0;
    for await (const chunk of input.createReadStream({ autoClose: false })) {
      position += await writeFully(target, chunk as Buffer, position);
    }
  } finally {
    await input.close();
  }
}

/** `write` may report fewer bytes than asked (common on remote volumes);
 * the rest of the chunk is written until none remains. */
async function writeFully(target: fs.FileHandle, chunk: Buffer, position: number): Promise<number> {
  for (let written = 0; written < chunk.length; ) {
    const { bytesWritten } = await target.write(
      chunk,
      written,
      chunk.length - written,
      position + written,
    );
    if (bytesWritten <= 0) throw new Error('relocate: fallback copy write made no progress');
    written += bytesWritten;
  }
  return chunk.length;
}

/** Withdraw every publication. Only an inode proven to be this relocation's
 * is ever removed. */
export async function revertCreated(publications: RelocatePublication[]): Promise<void> {
  for (const publication of publications.splice(0)) await withdraw(publication);
}

type Ownership = 'ours' | 'theirs' | 'unproven';

/** No portable unlink is conditional on an inode, so the name is first moved
 * atomically to a private sibling; only there, where no other writer can
 * reach it, is ownership checked and the file removed. Anything else caught
 * by that move is put back without replacing anything. */
async function withdraw(publication: RelocatePublication): Promise<void> {
  const aside = await moveAside(publication.path);
  if (!aside) return;
  const identity = await fs.lstat(aside).catch(() => null);
  const ownership: Ownership = !identity
    ? 'unproven'
    : samePublication(publication, identity)
      ? 'ours'
      : 'theirs';
  await settleAside(aside, publication.path, ownership);
}

/** Same withdrawal when the inode is unknown: a random nonce written through
 * the still-open handle lands in this move's inode only, so the aside file
 * holding exactly that nonce proves it is ours. */
async function withdrawUnidentified(target: fs.FileHandle, destination: string): Promise<void> {
  const aside = await moveAside(destination);
  if (!aside) return;
  const nonce = randomBytes(32);
  const ownership: Ownership = await target
    .write(nonce, 0, nonce.length, 0)
    .then(async ({ bytesWritten }) => {
      if (bytesWritten !== nonce.length) return 'unproven';
      return nonce.equals(await fs.readFile(aside)) ? 'ours' : 'theirs';
    })
    .catch(() => 'unproven' as const);
  await settleAside(aside, destination, ownership);
}

async function moveAside(name: string): Promise<string | null> {
  const aside = privateSiblingOf(name);
  try {
    await fs.rename(name, aside);
    return aside;
  } catch (err) {
    if (errnoCode(err) !== 'ENOENT') {
      log.error(
        { name, err: err instanceof Error ? err.message : err },
        'relocate rollback: could not move a created file aside — it is kept, not deleted',
      );
    }
    return null;
  }
}

async function settleAside(aside: string, destination: string, ownership: Ownership) {
  if (ownership === 'ours') {
    await fs.unlink(aside).catch(() => {});
    return;
  }
  if (ownership === 'theirs') {
    await restoreAside(aside, destination);
    return;
  }
  // A plain link never leaves a partial file, so restoring an unproven file
  // cannot start another rollback of its own.
  const relinked = await fs.link(aside, destination).then(
    () =>
      fs.unlink(aside).then(
        () => true,
        () => false,
      ),
    () => false,
  );
  log.error(
    { aside, destination, keptAt: relinked ? destination : aside },
    "relocate rollback: could not prove a created file is this move's own — it is kept, not deleted",
  );
}

async function restoreAside(aside: string, destination: string): Promise<void> {
  try {
    await publishExclusive(aside, destination);
    if (await filesIdentical(aside, destination)) await fs.unlink(aside);
  } catch (err) {
    log.error(
      { aside, destination, err: err instanceof Error ? err.message : err },
      'relocate rollback: a file could not be put back at its name — it is kept at the aside path',
    );
  }
}
