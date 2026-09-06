import '@angular/compiler';
import { TestBed } from '@angular/core/testing';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHostedWorkspace } from '../../projects/maple-common/src/lib/workspace/hosted-workspace.providers';
import { LibraryStateService } from '../../projects/maple-common/src/lib/state/library-state.service';
import { LibraryStore } from '../../projects/maple-common/src/lib/state/library-store.service';
import { XmpSerializerService } from '../../projects/maple-common/src/lib/xmp/xmp-serializer.service';
import { XmpParserService } from '../../projects/maple-common/src/lib/xmp/xmp-parser.service';
import { defaultAdjustmentModel } from '../../projects/maple-common/src/lib/models/adjustment-model';
import { BatchSyncAssetIO } from '../../projects/maple-common/src/lib/editor/copy-paste/batch-sync-asset-io.service';
import { BatchWorkerClient } from '../../projects/maple-common/src/lib/editor/copy-paste/batch-worker-client';
import type { BatchOperation } from '../../projects/maple-common/src/lib/editor/copy-paste/batch-ledger';
import type { Asset } from '../../projects/maple-common/src/lib/models/asset';

interface Photo {
  name: string;
  size: number;
  lastModified: number;
}
TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHostedWorkspace()] });
const library = TestBed.inject(LibraryStateService);
const store = TestBed.inject(LibraryStore);
const io = TestBed.inject(BatchSyncAssetIO);
const serializer = TestBed.inject(XmpSerializerService);
const parser = TestBed.inject(XmpParserService);
const root = await navigator.storage.getDirectory();
const directory = await root.getDirectoryHandle('real-photo-copies', { create: true });
const photos: Photo[] = await (await fetch('/corpus-manifest')).json();
const originals = new Map<string, { size: number; lastModified: number }>();
const assets: Asset[] = photos.map((photo) => ({
  id: 'benchmark:' + photo.name,
  filename: photo.name,
  folderId: 'benchmark',
  rating: 0,
  flag: 'unflagged',
  colorLabel: null,
  keywords: [],
  thumbnailGradient: '',
  aspectRatio: 1,
}));
const phaseSeconds = { prepare: 0, write: 0 };
const timed = async <T>(phase: keyof typeof phaseSeconds, work: () => Promise<T>) => {
  const started = performance.now();
  try {
    return await work();
  } finally {
    phaseSeconds[phase] += (performance.now() - started) / 1000;
  }
};
const worker = new BatchWorkerClient({
  prepare: (operation, id) => timed('prepare', () => io.prepare(operation, id)),
  write: (operation, id, patch) => timed('write', () => io.write(operation, id, patch)),
  changed: (_view, progress) => {
    if (progress && progress.processed % 500 === 0)
      console.info(`BATCH_BROWSER_PROGRESS ${progress.processed}/2000`);
  },
});
const api = {
  ready: true,
  setup: async () => {
    const initialXml = serializer.serialize({ ...defaultAdjustmentModel(), exposure: -0.5 });
    for (const photo of photos) {
      const handle = await directory.getFileHandle(photo.name, { create: true });
      const writer = await handle.createWritable();
      const response = await fetch('/corpus/' + photo.name);
      if (!response.ok || !response.body) throw new Error('Could not read the staged photograph.');
      await response.body.pipeTo(writer);
      const file = await handle.getFile();
      if (file.size !== photo.size) throw new Error('The staged photo copy is incomplete.');
      originals.set(photo.name, { size: file.size, lastModified: file.lastModified });
      const sidecar = await directory.getFileHandle(photo.name.replace(/\.[^.]+$/, '.xmp'), {
        create: true,
      });
      const sidecarWriter = await sidecar.createWritable();
      await sidecarWriter.write(initialXml);
      await sidecarWriter.close();
    }
    store.assets.set(assets);
    store.currentFolder.set({
      name: 'benchmark',
      read: true,
      write: true,
      persistedKey: 'browser-benchmark',
      native: directory,
    });
    return {
      imageCount: photos.length,
      originalBytes: photos.reduce((sum, photo) => sum + photo.size, 0),
      extensions: [
        ...new Set(photos.map((photo) => photo.name.slice(photo.name.lastIndexOf('.')))),
      ],
    };
  },
  run: async () => {
    const operation: BatchOperation = {
      id: crypto.randomUUID(),
      libraryId: 'browser-benchmark',
      createdAt: Date.now(),
      status: 'ready',
      directory,
      request: {
        source: { ...defaultAdjustmentModel(), exposure: 1.25 },
        groups: ['tone'],
        relativeWhiteBalance: false,
      },
      assetIds: assets.map((asset) => asset.id),
      assetNames: Object.fromEntries(assets.map((asset) => [asset.id, asset.filename])),
    };
    const started = performance.now();
    const result = await worker.request({ type: 'start', operation });
    await library.flushPendingXmpWrites();
    return {
      seconds: (performance.now() - started) / 1000,
      applied: result?.summary.applied.length ?? 0,
      failed: result?.summary.failed ?? [],
      phaseSeconds,
      initialExposure: -0.5,
    };
  },
  verify: async () => {
    for (const photo of photos) {
      const sidecar = await directory.getFileHandle(photo.name.replace(/\.[^.]+$/, '.xmp'));
      const xml = await (await sidecar.getFile()).text();
      if (parser.parseAdjustmentModel(xml).model.exposure !== 1.25)
        throw new Error('A sidecar did not receive the requested exposure.');
      const file = await (await directory.getFileHandle(photo.name)).getFile();
      const original = originals.get(photo.name)!;
      if (file.size !== original.size || file.lastModified !== original.lastModified)
        throw new Error('A staged original was modified during the batch.');
    }
  },
  dispose: () => {
    worker.destroy();
    TestBed.resetTestingModule();
  },
};
Object.assign(window, { batchLibrary: api });
export type BatchLibraryTest = typeof api;
