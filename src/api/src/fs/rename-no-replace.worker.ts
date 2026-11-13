import { dlopen, FFIType, read } from 'bun:ffi';

/** The native no-replace rename, kept off the API thread: on a slow or
 * unresponsive network share the call blocks until the filesystem answers.
 * errno is read here, on the thread that made the call. */
interface NativeRename {
  rename: (from: string, to: string) => number;
  errno: () => number;
}

export type NativeRenameReply =
  | { status: 'renamed' }
  | { status: 'failed'; errno: number }
  | { status: 'unavailable' };

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

function renameNoReplaceNative(from: string, to: string): NativeRenameReply {
  const native = loadNativeRename();
  if (!native) return { status: 'unavailable' };
  if (native.rename(from, to) === 0) return { status: 'renamed' };
  return { status: 'failed', errno: native.errno() };
}

declare const self: Worker;
self.onmessage = (event: MessageEvent<{ from: string; to: string }>) => {
  self.postMessage(renameNoReplaceNative(event.data.from, event.data.to));
};
