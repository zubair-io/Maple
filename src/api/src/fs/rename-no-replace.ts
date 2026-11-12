import { dlopen, FFIType, read } from 'bun:ffi';
import { constants as osConstants } from 'node:os';
import * as path from 'node:path';
import * as fs from './mirrored.ts';
import { PublishCollisionError } from './relocate-publish.ts';

type Rename = (from: string, to: string) => number;

interface NativeRename {
  rename: Rename;
  errno: () => number;
}

const AT_FDCWD = -100;
const LINUX_RENAME_NOREPLACE = 1;
const DARWIN_RENAME_EXCL = 4;

function loadNativeRename(): NativeRename | null {
  const cstring = (value: string) => Buffer.from(`${value}\0`);
  try {
    if (process.platform === 'darwin') {
      const libc = dlopen('/usr/lib/libSystem.B.dylib', {
        renamex_np: { args: [FFIType.cstring, FFIType.cstring, FFIType.u32], returns: FFIType.i32 },
        __error: { args: [], returns: FFIType.ptr },
      });
      return {
        rename: (from, to) =>
          libc.symbols.renamex_np(cstring(from), cstring(to), DARWIN_RENAME_EXCL),
        errno: () => read.i32(libc.symbols.__error()!),
      };
    }
    if (process.platform === 'linux') {
      const libc = dlopen('libc.so.6', {
        renameat2: {
          args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring, FFIType.u32],
          returns: FFIType.i32,
        },
        __errno_location: { args: [], returns: FFIType.ptr },
      });
      return {
        rename: (from, to) =>
          libc.symbols.renameat2(
            AT_FDCWD,
            cstring(from),
            AT_FDCWD,
            cstring(to),
            LINUX_RENAME_NOREPLACE,
          ),
        errno: () => read.i32(libc.symbols.__errno_location()!),
      };
    }
  } catch {
    return null;
  }
  return null;
}

const native = loadNativeRename();

/** The volume answers the no-replace flag with one of these instead of acting
 * on it (smbfs: ENOTSUP, FAT/exFAT and old kernels: EINVAL, ENOSYS). */
const FLAG_UNSUPPORTED = new Set(['EINVAL', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP']);

const errnoNames = new Map(Object.entries(osConstants.errno).map(([name, value]) => [value, name]));

/** Volumes (by device) already found not to honor the flag, so the failed
 * probe is paid once, not on every upload. */
const unsupportedDevices = new Set<number>();

/** Rename `from` to `to` in one step that fails with EEXIST instead of
 * replacing whatever is at `to`: `renamex_np(RENAME_EXCL)` on macOS,
 * `renameat2(RENAME_NOREPLACE)` on Linux. `'unsupported'` when this platform or
 * volume cannot do it; the file is then untouched. */
export async function renameNoReplace(
  from: string,
  to: string,
): Promise<'renamed' | 'unsupported'> {
  if (!native) return 'unsupported';
  const device = (await fs.stat(path.dirname(to))).dev;
  if (unsupportedDevices.has(device)) return 'unsupported';
  if (native.rename(from, to) === 0) {
    fs.replicatePath(to);
    return 'renamed';
  }
  const code = errnoNames.get(native.errno()) ?? 'EIO';
  if (code === 'EEXIST') throw new PublishCollisionError(to);
  if (!FLAG_UNSUPPORTED.has(code)) {
    throw Object.assign(new Error(`${code}: rename '${from}' -> '${to}'`), { code });
  }
  unsupportedDevices.add(device);
  return 'unsupported';
}
