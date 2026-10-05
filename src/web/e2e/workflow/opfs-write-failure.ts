import { fsAccessWriteFile } from '../../projects/maple-common/src/lib/folder-access/fs-access-backend';

/** Real OPFS atomic writer, with a genuinely detached caller buffer (#4287). */
export async function opfsWriteFailure(lockCleanup = false) {
  const root = await navigator.storage.getDirectory();
  const name = 'maple-write-failure-' + crypto.randomUUID();
  const native = await root.getDirectoryHandle(name, { create: true });
  const folder = { native, name, read: true, write: true };
  const original = new Uint8Array([42, 0, 255, 19]);
  await fsAccessWriteFile(folder, 'original.bin', original);
  const files = FileSystemFileHandle.prototype;
  const createWritable = files.createWritable;
  let stream: FileSystemWritableFileStream | null = null;
  let aborted = false;
  let writer: WritableStreamDefaultWriter | null = null;
  files.createWritable = async function (options) {
    const opened = await createWritable.call(this, options);
    stream = opened;
    const abort = opened.abort.bind(opened);
    opened.abort = async (reason) => {
      await abort(reason);
      aborted = true;
    };
    if (lockCleanup) writer = opened.getWriter();
    return opened;
  };
  try {
    const data = new Uint8Array([1, 2, 3]);
    structuredClone(data.buffer, { transfer: [data.buffer] });
    const failure = await fsAccessWriteFile(folder, 'original.bin', data).then(
      () => null,
      (error: unknown) => error,
    );
    const saved = new Uint8Array(
      await (await (await native.getFileHandle('original.bin')).getFile()).arrayBuffer(),
    );
    const removed = await root.removeEntry(name, { recursive: true }).then(
      () => true,
      () => false,
    );
    return {
      originalTypeError: failure instanceof TypeError,
      bothFailuresPreserved:
        failure instanceof AggregateError &&
        failure.errors.length === 2 &&
        failure.errors.every((error: unknown) => error instanceof TypeError),
      aborted,
      originalBytesPreserved:
        saved.every((value, index) => value === original[index]) &&
        saved.length === original.length,
      ownedDirectoryRemoved: removed,
    };
  } finally {
    files.createWritable = createWritable;
    // Release only the actual stream opened by this control on the old implementation.
    if (writer) (writer as WritableStreamDefaultWriter).releaseLock();
    if (stream && !aborted) await (stream as FileSystemWritableFileStream).abort();
    await root.removeEntry(name, { recursive: true }).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
    });
  }
}
