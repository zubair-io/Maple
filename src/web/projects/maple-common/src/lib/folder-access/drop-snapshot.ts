interface DataTransferItemWithHandle extends DataTransferItem {
  getAsFileSystemHandle?: () => Promise<FileSystemHandle | null>;
}

/**
 * What a drop carried, captured synchronously inside the `drop` handler.
 * Chromium locks a drop's DataTransfer once the event finishes dispatching, so
 * `files` and every `getAsFileSystemHandle()` call must be read before the
 * first `await`.
 */
export interface DropSnapshot {
  readonly files: readonly File[];
  /** One entry per dropped file item, `null` where the browser gave no handle. */
  readonly handles: Promise<(FileSystemHandle | null)[]>;
}

export function snapshotDrop(dataTransfer: DataTransfer): DropSnapshot {
  const files = Array.from(dataTransfer.files);
  const handles = Promise.all(
    Array.from(dataTransfer.items)
      .filter((item) => item.kind !== 'string')
      .map((item) => {
        const pending = (item as DataTransferItemWithHandle).getAsFileSystemHandle?.();
        return pending ? pending.catch(() => null) : Promise.resolve(null);
      }),
  );
  return { files, handles };
}
