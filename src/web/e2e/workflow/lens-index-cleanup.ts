import { cycleApplication } from './cycle-workflow-environment';
import { lensGestureStorage } from './lens-gesture-storage';
import { LibraryStore } from '../../projects/maple-common/src/lib/state/library-store.service';
import { XmpSerializerService } from '../../projects/maple-common/src/lib/xmp/xmp-serializer.service';
import { defaultAdjustmentModel } from '../../projects/maple-common/src/lib/models/adjustment-model';

/** Fence a real OPFS index stream, without replacing sidecar I/O (#4287). */
export async function lensIndexCleanupBoundary() {
  const owner = await cycleApplication('Hosted');
  const xml = owner.injector.get(XmpSerializerService).serialize(defaultAdjustmentModel());
  owner.destroy();
  const active = await lensGestureStorage('Hosted', xml);
  const folder = active.library.currentFolder();
  if (!folder?.native) throw Error('Owned OPFS folder required');
  const root = await navigator.storage.getDirectory();
  const files = FileSystemFileHandle.prototype;
  const directories = FileSystemDirectoryHandle.prototype;
  const createWritable = files.createWritable;
  const removeEntry = directories.removeEntry;
  const entered = checkpoint();
  const release = checkpoint();
  const closed = checkpoint();
  let writeClosed = false;
  let removalBeforeClose = false;
  let intercepted = false;
  files.createWritable = async function (options) {
    const stream = await createWritable.call(this, options);
    if (this.name === 'index.json' && !intercepted) {
      intercepted = true;
      const close = stream.close.bind(stream);
      stream.close = async () => {
        entered.resolve();
        await release.promise;
        await close();
        writeClosed = true;
        closed.resolve();
      };
    }
    return stream;
  };
  directories.removeEntry = function (name, options) {
    if (name === folder.name) removalBeforeClose = !writeClosed;
    return removeEntry.call(this, name, options);
  };
  try {
    active.app.injector.get(LibraryStore).assets.update((assets) => [...assets]);
    await entered.promise;
    const disposal = active.dispose().then(
      () => ({ cleanupSucceeded: true, error: null }),
      (error: unknown) => ({ cleanupSucceeded: false, error: String(error) }),
    );
    release.resolve();
    await closed.promise;
    const result = await disposal;
    return {
      ...result,
      removalBeforeClose,
      realIndexStreamClosed: writeClosed,
    };
  } finally {
    release.resolve();
    files.createWritable = createWritable;
    directories.removeEntry = removeEntry;
    // A failed before-control leaves only this test's unique folder behind.
    if (!active.app.destroyed) active.app.destroy();
    const remaining = await root.getDirectoryHandle(folder.name).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'NotFoundError') return null;
      throw error;
    });
    if (remaining) await root.removeEntry(folder.name, { recursive: true });
  }
}

function checkpoint() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}
