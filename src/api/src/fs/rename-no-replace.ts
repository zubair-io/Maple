import { constants as osConstants } from 'node:os';
import * as path from 'node:path';
import * as fs from './mirrored.ts';
import { PublishCollisionError } from './relocate-publish.ts';
import type { NativeRenameReply } from './rename-no-replace.worker.ts';

/** Whether this platform can rename without replacing; settled `false` once
 * the native call turns out to be missing. */
let nativeAvailable = process.platform === 'darwin' || process.platform === 'linux';

/** The volume answers the no-replace flag with one of these instead of acting
 * on it (smbfs: ENOTSUP, FAT/exFAT and old kernels: EINVAL, ENOSYS). */
const FLAG_UNSUPPORTED = new Set(['EINVAL', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP']);

const errnoNames = new Map(Object.entries(osConstants.errno).map(([name, value]) => [value, name]));

/** Volumes (by device) already found not to honor the flag, so the failed
 * probe is paid once, not on every upload. */
const unsupportedDevices = new Set<number>();

/** The native call blocks until the filesystem answers, which on a slow or
 * unresponsive network share can take a timeout; on a worker, the API thread
 * keeps serving requests and timers meanwhile. */
function renameOnWorker(from: string, to: string): Promise<NativeRenameReply> {
  const { promise, resolve, reject } = Promise.withResolvers<NativeRenameReply>();
  const worker = new Worker(new URL('./rename-no-replace.worker.ts', import.meta.url).href);
  worker.onmessage = (event: MessageEvent<NativeRenameReply>) => {
    worker.terminate();
    resolve(event.data);
  };
  worker.onerror = (event) => {
    worker.terminate();
    reject(new Error(event.message));
  };
  worker.postMessage({ from, to });
  return promise;
}

/** Rename `from` to `to` in one step that fails with EEXIST instead of
 * replacing whatever is at `to`: `renamex_np(RENAME_EXCL)` on macOS,
 * `renameat2(RENAME_NOREPLACE)` on Linux. `'unsupported'` when this platform or
 * volume cannot do it; the file is then untouched. */
export async function renameNoReplace(
  from: string,
  to: string,
): Promise<'renamed' | 'unsupported'> {
  if (!nativeAvailable) return 'unsupported';
  const device = (await fs.stat(path.dirname(to))).dev;
  if (unsupportedDevices.has(device)) return 'unsupported';
  const reply = await renameOnWorker(from, to);
  if (reply.status === 'unavailable') {
    nativeAvailable = false;
    return 'unsupported';
  }
  if (reply.status === 'renamed') {
    fs.replicatePath(to);
    return 'renamed';
  }
  const code = errnoNames.get(reply.errno) ?? 'EIO';
  if (code === 'EEXIST') throw new PublishCollisionError(to);
  if (!FLAG_UNSUPPORTED.has(code)) {
    throw Object.assign(new Error(`${code}: rename '${from}' -> '${to}'`), { code });
  }
  unsupportedDevices.add(device);
  return 'unsupported';
}
