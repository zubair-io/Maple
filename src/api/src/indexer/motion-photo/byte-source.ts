import { open, stat, type FileHandle } from '../../fs/mirrored.ts';

/**
 * Positioned reads over one opened original, against the size it had when it
 * was opened. Every read is bounded by that size and by a per-detection byte
 * budget, so a hostile length field can never make detection read the whole
 * file or allocate an arbitrary buffer.
 */
export interface ByteSource {
  readonly size: number;
  /** Exactly `length` bytes at `offset`, or null when the range is outside the file or the budget. */
  read(offset: number, length: number): Promise<Buffer | null>;
}

const READ_BUDGET_BYTES = 8 * 1024 * 1024;

/** The file shrank or grew under an open read: the copy is still in flight, so retry later. */
export class SourceChangedError extends Error {
  constructor(absPath: string) {
    super(`${absPath} changed while its embedded metadata was being read`);
    this.name = 'SourceChangedError';
  }
}

function isInside(size: number, offset: number, length: number): boolean {
  return (
    Number.isSafeInteger(offset) &&
    Number.isSafeInteger(length) &&
    offset >= 0 &&
    length >= 0 &&
    offset + length <= size
  );
}

async function fill(handle: FileHandle, buffer: Buffer, position: number): Promise<number> {
  const step = async (filled: number): Promise<number> => {
    if (filled === buffer.length) return filled;
    const { bytesRead } = await handle.read(
      buffer,
      filled,
      buffer.length - filled,
      position + filled,
    );
    return bytesRead === 0 ? filled : step(filled + bytesRead);
  };
  return step(0);
}

export function fileByteSource(
  handle: FileHandle,
  absPath: string,
  size: number,
  signal: AbortSignal,
): ByteSource {
  const state = { remaining: READ_BUDGET_BYTES };
  return {
    size,
    async read(offset, length) {
      signal.throwIfAborted();
      if (!isInside(size, offset, length) || length > state.remaining) return null;
      state.remaining -= length;
      const buffer = Buffer.alloc(length);
      if ((await fill(handle, buffer, offset)) !== length) throw new SourceChangedError(absPath);
      return buffer;
    },
  };
}

/**
 * Run `use` over one opened original and fail with {@link SourceChangedError}
 * when the file's size, mtime or identity differs after the read, so a caller
 * never records what a half-copied file happened to satisfy. A path that is
 * not a regular file yields `notRegular`.
 */
export async function withStableSource<T>(
  absPath: string,
  signal: AbortSignal,
  notRegular: T,
  use: (source: ByteSource) => Promise<T>,
): Promise<T> {
  const handle = await open(absPath, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile()) return notRegular;
    const result = await use(fileByteSource(handle, absPath, before.size, signal));
    const [afterHandle, afterPath] = await Promise.all([handle.stat(), stat(absPath)]);
    const unchanged = [afterHandle, afterPath].every(
      (after) =>
        after.size === before.size && after.mtimeMs === before.mtimeMs && after.ino === before.ino,
    );
    if (!unchanged) throw new SourceChangedError(absPath);
    return result;
  } finally {
    await handle.close();
  }
}
