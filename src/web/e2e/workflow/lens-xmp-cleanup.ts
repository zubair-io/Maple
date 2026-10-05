import { createLensCleanupStorage } from './lens-index-cleanup';
import { XmpStoreService } from '../../projects/maple-common/src/lib/xmp/xmp-store.service';
import { XmpParserService } from '../../projects/maple-common/src/lib/xmp/xmp-parser.service';
import { defaultAdjustmentModel } from '../../projects/maple-common/src/lib/models/adjustment-model';

/** Two actual sidecar streams: one locked write fails, the other's close is fenced. */
export async function lensXmpCleanupBoundary() {
  const { active, folder, xml } = await createLensCleanupStorage();
  const store = active.app.injector.get(XmpStoreService);
  const files = FileSystemFileHandle.prototype;
  const createWritable = files.createWritable;
  const entered = checkpoint();
  const release = checkpoint();
  const closed = checkpoint();
  let failedStream: FileSystemWritableFileStream | null = null;
  let failedWriter: WritableStreamDefaultWriter | null = null;
  let otherClosed = false;
  files.createWritable = async function (options) {
    const stream = await createWritable.call(this, options);
    if (this.name === 'a.xmp') {
      failedStream = stream;
      failedWriter = stream.getWriter();
    }
    if (this.name === 'b.xmp') {
      const close = stream.close.bind(stream);
      stream.close = async () => {
        entered.resolve();
        await release.promise;
        await close();
        otherClosed = true;
        closed.resolve();
      };
    }
    return stream;
  };
  try {
    const culling = { rating: 0, flag: 'unflagged' as const, colorLabel: null };
    store.scheduleWrite(
      active.ids[0],
      folder,
      'a.dng',
      { ...defaultAdjustmentModel(), exposure: 1 },
      culling,
    );
    store.scheduleWrite(
      active.ids[1],
      folder,
      'b.dng',
      { ...defaultAdjustmentModel(), exposure: 2 },
      culling,
    );
    let flushFinished = false;
    const flush = active.library.flushPendingXmpWrites().then(
      () => {
        flushFinished = true;
        return null;
      },
      (error: unknown) => {
        flushFinished = true;
        return error;
      },
    );
    await entered.promise;
    // Genuine OPFS reads allow queued Promise reactions to finish with B still open.
    const saved = await active.read(0);
    const flushFinishedBeforeOtherClose = flushFinished;
    const failedRetryRetained =
      (Reflect.get(store, 'retryWrites') as Map<string, unknown[]>).get(active.ids[0])?.length ===
      1;
    const failedSidecarUnchanged = saved.xml === xml;
    release.resolve();
    await closed.promise;
    const error = await flush;
    const primaryAndAbortErrorsPreserved =
      error instanceof AggregateError &&
      error.errors.length === 2 &&
      error.errors.every((item: unknown) => item instanceof TypeError);
    files.createWritable = createWritable;
    (failedWriter as WritableStreamDefaultWriter | null)?.releaseLock();
    failedWriter = null;
    await (failedStream as FileSystemWritableFileStream | null)?.abort();
    failedStream = null;
    await active.library.flushPendingXmpWrites();
    const parser = active.app.injector.get(XmpParserService);
    const states = await Promise.all([active.read(0), active.read(1)]);
    const result = {
      flushFinishedBeforeOtherClose,
      primaryAndAbortErrorsPreserved,
      failedRetryRetained,
      failedSidecarUnchanged,
      retryPublished: parser.parseAdjustmentModel(states[0].xml).model.exposure === 1,
      otherSidecarPublished:
        otherClosed && parser.parseAdjustmentModel(states[1].xml).model.exposure === 2,
      originalBytesPreserved: states.every(
        (state, index) =>
          JSON.stringify(state.original) === JSON.stringify(active.initial[index].original),
      ),
    };
    await active.dispose();
    return result;
  } finally {
    release.resolve();
    files.createWritable = createWritable;
    (failedWriter as WritableStreamDefaultWriter | null)?.releaseLock();
    await (failedStream as FileSystemWritableFileStream | null)?.abort();
    if (!active.app.destroyed) await active.dispose();
  }
}

function checkpoint() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}
