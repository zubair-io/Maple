/** #1472: kernel releases relocation ownership even on SIGKILL. */
import { dlopen, FFIType } from 'bun:ffi';
import { basename, dirname, join } from 'node:path';
import * as fs from './mirrored.ts';
import { xmpSidecarPath } from './xmp.ts';

export async function removalRelocationLease(source: string, target: string) {
  const library =
    process.platform === 'darwin'
      ? '/usr/lib/libSystem.B.dylib'
      : process.platform === 'linux'
        ? 'libc.so.6'
        : null;
  if (!library) throw new Error('Removal relocation requires a POSIX filesystem lease');
  const native = dlopen(library, {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  const handles: Awaited<ReturnType<typeof fs.open>>[] = [];
  const inodes = new Set<string>();
  // Match Apple's persistent lock names. Never unlink: a new inode would let
  // another process bypass an owner still holding the original descriptor.
  const names = [
    ...new Set(
      [source, target].flatMap((raw) => [
        join(dirname(raw), `.${basename(raw)}.relocation.lock`),
        join(dirname(raw), `.${basename(xmpSidecarPath(raw))}.lock`),
      ]),
    ),
  ].sort();
  const release = async () => {
    try {
      await Promise.all(handles.reverse().map((handle) => handle.close()));
    } finally {
      native.close();
    }
  };
  const acquire = async (handle: Awaited<ReturnType<typeof fs.open>>) => {
    handles.push(handle);
    const info = await handle.stat();
    const inode = `${info.dev}:${info.ino}`;
    if (inodes.has(inode)) {
      handles.pop();
      await handle.close();
      return;
    }
    inodes.add(inode);
    if (!info.isFile() || native.symbols.flock(handle.fd, 2 | 4) !== 0)
      throw new Error('Photo is busy with another edit or relocation');
  };
  try {
    // A read-only source directory cannot create coordination files. Lock the
    // original's existing inode too, so copying remains possible without a
    // write to that directory and every API writer respects the same owner.
    const info = await fs.lstat(source).catch((error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        return null;
      throw error;
    });
    const originalLocked = info?.isFile() && !info.isSymbolicLink();
    if (originalLocked) await acquire(await fs.open(source, 'r'));
    for (const name of names) {
      const handle = await fs
        .open(name, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600)
        .catch(async (error: unknown) => {
          if (
            originalLocked &&
            dirname(name) === dirname(source) &&
            error &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === 'EACCES'
          ) {
            const writable = await fs.access(dirname(source), fs.constants.W_OK).then(
              () => true,
              () => false,
            );
            if (!writable) return null;
          }
          throw error;
        });
      // Case-only aliases can address the same coordination inode.
      if (handle) await acquire(handle);
    }
    return { release };
  } catch (error) {
    await release();
    throw error;
  }
}
