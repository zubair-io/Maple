import { promises as fs } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { tmpdir, platform, arch, cpus } from 'node:os';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { describe, expect, it } from 'vitest';
import { provideHostedWorkspace } from '../../workspace/hosted-workspace.providers';
import { FolderAccessService } from '../../folder-access/folder-access.service';
import {
  fsAccessReadFile,
  fsAccessWriteFile,
  fsAccessEnsureSubdirectory,
  fsAccessListEntries,
} from '../../folder-access/fs-access-backend';
import { LibraryStateService } from '../../state/library-state.service';
import { LibraryStore } from '../../state/library-store.service';
import { XmpParserService } from '../../xmp/xmp-parser.service';
import { defaultAdjustmentModel } from '../../models/adjustment-model';
import type { Asset } from '../../models/asset';
import type { BatchOperation } from './batch-ledger';
import { PersistentBatchRunner } from './persistent-batch-runner';
import { BatchSyncAssetIO } from './batch-sync-asset-io.service';
import { DiskBatchLedger, DiskDirectory } from './testing/batch-test-files';

// This fixture input is a test-only path to an OWNED staged copy, never the
// user's library. No app/runtime configuration is added. The budget is
// declared here before running: <=120 s and <=512 MiB incremental RSS for
// 2,000 completed sidecars, including updateAdjustment and debounce flush.
const corpus = process.env['MAPLE_BATCH_CORPUS'];
describe.skipIf(!corpus)('real 2,000-image library batch budget', () => {
  it('measures full state mutation and durable sidecar writes', async () => {
    const directory = resolve(corpus!);
    if (!directory.startsWith(resolve(tmpdir()) + '/') && !directory.startsWith('/tmp/'))
      throw new Error('Benchmark accepts only an owned temporary staged library.');
    const filenames = (await fs.readdir(directory))
      .filter((name) => /^asset-\d{4}\./.test(name) && extname(name) !== '.xmp')
      .sort();
    expect(filenames).toHaveLength(2000);
    const originals = await Promise.all(
      filenames.map(async (name) => {
        const s = await fs.stat(join(directory, name));
        return { size: s.size, mtime: s.mtimeMs };
      }),
    );
    const ledgerDirectory = await fs.mkdtemp(join(tmpdir(), 'maple-batch-benchmark-ledger-'));
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideHostedWorkspace(),
        {
          provide: FolderAccessService,
          useValue: {
            readFile: fsAccessReadFile,
            writeFile: fsAccessWriteFile,
            ensureSubdirectory: fsAccessEnsureSubdirectory,
            listEntries: fsAccessListEntries,
          },
        },
      ],
    });
    const store = TestBed.inject(LibraryStore);
    const library = TestBed.inject(LibraryStateService);
    const assets = filenames.map(
      (filename) =>
        ({
          id: 'benchmark:' + filename,
          filename,
          folderId: 'benchmark',
          rating: 0,
          flag: 'unflagged',
          colorLabel: null,
          keywords: [],
          thumbnailGradient: '',
          aspectRatio: 1,
        }) satisfies Asset,
    );
    store.assets.set(assets);
    store.currentFolder.set({
      name: 'benchmark',
      read: true,
      write: true,
      persistedKey: directory,
      native: new DiskDirectory(directory) as unknown as FileSystemDirectoryHandle,
    });
    const io = TestBed.inject(BatchSyncAssetIO);
    const operation: BatchOperation = {
      id: crypto.randomUUID(),
      libraryId: directory,
      createdAt: Date.now(),
      status: 'ready',
      request: {
        source: { ...defaultAdjustmentModel(), exposure: 1.25 },
        groups: ['tone'],
        relativeWhiteBalance: false,
      },
      assetIds: assets.map((a) => a.id),
      assetNames: Object.fromEntries(assets.map((a) => [a.id, a.filename])),
    };
    const ledger = new DiskBatchLedger(ledgerDirectory);
    await ledger.create(operation);
    const baseline = process.memoryUsage();
    let peakRss = baseline.rss;
    let peakHeap = baseline.heapUsed;
    const samples = setInterval(() => {
      const m = process.memoryUsage();
      peakRss = Math.max(peakRss, m.rss);
      peakHeap = Math.max(peakHeap, m.heapUsed);
    }, 10);
    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    const started = performance.now();
    try {
      const runner = new PersistentBatchRunner(ledger, {
        prepare: io.prepare.bind(io),
        write: io.write.bind(io),
        changed: (_view, progress) => {
          if (progress && progress.processed % 500 === 0)
            console.info(
              `BATCH_LIBRARY_PROGRESS ${progress.processed}/2000 in ${((performance.now() - started) / 1000).toFixed(2)} s`,
            );
        },
      });
      const result = await runner.run(operation.id);
      await library.flushPendingXmpWrites();
      const seconds = (performance.now() - started) / 1000;
      delay.disable();
      clearInterval(samples);
      expect(result.summary.failed).toEqual([]);
      expect(result.summary.applied).toHaveLength(2000);
      const parser = new XmpParserService();
      for (const filename of filenames) {
        const xml = await fs.readFile(
          join(directory, filename.replace(/\.[^.]+$/, '.xmp')),
          'utf8',
        );
        expect(parser.parseAdjustmentModel(xml).model.exposure).toBe(1.25);
      }
      const after = await Promise.all(
        filenames.map(async (name) => {
          const s = await fs.stat(join(directory, name));
          return { size: s.size, mtime: s.mtimeMs };
        }),
      );
      expect(after).toEqual(originals);
      const report = {
        date: new Date().toISOString(),
        runtime: process.version,
        os: platform(),
        arch: arch(),
        cpu: cpus()[0]?.model,
        imageCount: 2000,
        originalBytes: originals.reduce((sum, item) => sum + item.size, 0),
        extensions: [...new Set(filenames.map(extname))],
        operation:
          'All tone-group values; real LibraryState.updateAdjustment, canonical XMP reread, debounce flush, atomic filesystem close, per-asset durable ledger',
        previewScope:
          'Derived-preview scheduling is live and bounded to one original fetch/decode at a time; completion measures authoritative sidecar commits, not derived preview completion.',
        seconds,
        assetsPerSecond: 2000 / seconds,
        baselineRssBytes: baseline.rss,
        peakRssBytes: peakRss,
        incrementalRssBytes: peakRss - baseline.rss,
        baselineHeapBytes: baseline.heapUsed,
        peakHeapBytes: peakHeap,
        eventLoopP99Ms: delay.percentile(99) / 1e6,
        eventLoopMaxMs: delay.max / 1e6,
        budget: { maximumSeconds: 120, maximumIncrementalRssBytes: 512 * 1024 * 1024 },
        applied: result.summary.applied.length,
        failed: result.summary.failed.length,
      };
      await fs.writeFile(
        '/tmp/maple-3311-library-measurement.json',
        JSON.stringify(report, null, 2) + '\n',
      );
      console.info('BATCH_LIBRARY_MEASUREMENT ' + JSON.stringify(report));
      expect(seconds).toBeLessThanOrEqual(120);
      expect(peakRss - baseline.rss).toBeLessThanOrEqual(512 * 1024 * 1024);
    } finally {
      clearInterval(samples);
      delay.disable();
      TestBed.resetTestingModule();
      await fs.rm(ledgerDirectory, { recursive: true, force: true });
    }
  }, 600000);
});
