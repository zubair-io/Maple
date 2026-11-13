/** Flush copied bytes before publishing them or deleting their source. */
import { open, type FileHandle } from './mirrored.ts';

const UNSUPPORTED_SYNC = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);
const unsupported = (error: unknown): boolean =>
  UNSUPPORTED_SYNC.has((error as NodeJS.ErrnoException | null)?.code ?? '');

export async function syncFileHandle(handle: FileHandle): Promise<void> {
  try {
    await handle.datasync();
  } catch (error) {
    if (!unsupported(error)) throw error;
    try {
      await handle.sync();
    } catch (fallbackError) {
      // Some network mounts implement neither operation. Permit their
      // byte-verified copies; real I/O and permission failures still fail.
      if (!unsupported(fallbackError)) throw fallbackError;
    }
  }
}

export async function syncCopiedFile(filename: string): Promise<void> {
  const handle = await open(filename, 'r');
  try {
    await syncFileHandle(handle);
  } finally {
    await handle.close();
  }
}
