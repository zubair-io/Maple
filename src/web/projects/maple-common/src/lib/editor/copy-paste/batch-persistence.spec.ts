import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
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
import { XmpSerializerService } from '../../xmp/xmp-serializer.service';
import { XmpParserService } from '../../xmp/xmp-parser.service';
import { defaultAdjustmentModel } from '../../models/adjustment-model';
import type { Asset } from '../../models/asset';
import type { BatchOperation } from './batch-ledger';
import { PersistentBatchRunner } from './persistent-batch-runner';
import { BatchSyncAssetIO } from './batch-sync-asset-io.service';
import { DiskBatchLedger, DiskDirectory } from './testing/batch-test-files';

const image = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  ),
  (c) => c.charCodeAt(0),
);
const culling = {
  rating: 4,
  flag: 'pick' as const,
  colorLabel: 'green' as const,
  keywords: ['preserve'],
};

describe('persistent batch through real sidecar files', () => {
  let duringRead: (() => void) | undefined;
  let root: string;
  let ledger: DiskBatchLedger;
  let io: BatchSyncAssetIO;
  let operation: BatchOperation;
  const parser = new XmpParserService();
  const serializer = new XmpSerializerService();
  beforeEach(async () => {
    duringRead = undefined;
    root = await fs.mkdtemp(join(tmpdir(), 'maple-batch-test-'));
    const photos = join(root, 'photos');
    await fs.mkdir(photos);
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideHostedWorkspace(),
        {
          provide: FolderAccessService,
          useValue: {
            readFile: async (...args: Parameters<typeof fsAccessReadFile>) => {
              const result = await fsAccessReadFile(...args);
              const action = duringRead;
              duringRead = undefined;
              action?.();
              return result;
            },
            writeFile: fsAccessWriteFile,
            ensureSubdirectory: fsAccessEnsureSubdirectory,
            listEntries: fsAccessListEntries,
          },
        },
      ],
    });
    const store = TestBed.inject(LibraryStore);
    const library = TestBed.inject(LibraryStateService);
    const assets = ['a', 'b', 'c'].map(
      (name) =>
        ({
          id: 'photos:' + name,
          filename: name + '.png',
          folderId: 'f-photos',
          ...culling,
          thumbnailGradient: '',
          aspectRatio: 1,
        }) satisfies Asset,
    );
    store.assets.set(assets);
    store.currentFolder.set({
      name: 'photos',
      read: true,
      write: true,
      persistedKey: photos,
      native: new DiskDirectory(photos) as unknown as FileSystemDirectoryHandle,
    });
    for (const asset of assets) {
      await fs.writeFile(join(photos, asset.filename), image);
      const xml = serializer.serialize(
        { ...defaultAdjustmentModel(), saturation: 22 },
        {
          unknownAttributes: [{ name: 'vendor:Keep', value: 'yes' }],
          unknownNamespaces: [{ prefix: 'vendor', uri: 'https://example.test/' }],
          unknownNodes: [],
        },
        culling,
        { title: 'Keep title', headline: 'Keep headline' },
      );
      await fs.writeFile(join(photos, asset.filename.replace('.png', '.xmp')), xml);
    }
    io = TestBed.inject(BatchSyncAssetIO);
    operation = {
      id: crypto.randomUUID(),
      libraryId: photos,
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
    ledger = new DiskBatchLedger(join(root, 'ledger'));
    await ledger.create(operation);
    // The facade, canonical parser, serializer, debounce scheduler and atomic
    // filesystem writer remain real. Only the operating-system handle is an
    // adapter to this test's owned directory.
    expect(library.backend).toBe('hosted');
  });
  afterEach(async () => {
    TestBed.resetTestingModule();
    await fs.rm(root, { recursive: true, force: true });
  });
  const read = async (root: string, name: string) =>
    fs.readFile(join(root, 'photos', name + '.xmp'), 'utf8');

  it('records a real filesystem failure, continues, and retries only the failed asset', async () => {
    await fs.rm(join(root, 'photos/b.xmp'));
    await fs.mkdir(join(root, 'photos/b.xmp'));
    const runner = new PersistentBatchRunner(ledger, {
      prepare: io.prepare.bind(io),
      write: io.write.bind(io),
      changed: () => {},
    });
    const first = await runner.run(operation.id);
    expect(first.summary.applied).toEqual(['photos:a', 'photos:c']);
    expect(first.summary.failed[0].id).toBe('photos:b');
    const before = await read(root, 'a');
    const original = await fs.readFile(join(root, 'photos/a.png'));
    expect(parser.parseAdjustmentModel(before).model).toMatchObject({
      exposure: 1.25,
      saturation: 22,
    });
    expect(parser.parseCulling(before)).toMatchObject(culling);
    expect(parser.parseMetadata(before)).toMatchObject({
      title: 'Keep title',
      headline: 'Keep headline',
    });
    expect(before).toContain('vendor:Keep="yes"');
    expect([...original]).toEqual([...image]);
    const mtime = (await fs.stat(join(root, 'photos/a.xmp'))).mtimeMs;
    await fs.rm(join(root, 'photos/b.xmp'), { recursive: true });
    const reopened = new PersistentBatchRunner(new DiskBatchLedger(ledger.root), {
      prepare: io.prepare.bind(io),
      write: io.write.bind(io),
      changed: () => {},
    });
    const retry = await reopened.run(operation.id, true);
    expect(retry.summary.failed).toEqual([]);
    expect(retry.summary.applied).toHaveLength(3);
    expect((await fs.stat(join(root, 'photos/a.xmp'))).mtimeMs).toBe(mtime);
  });

  it('cancels after one committed file, then resumes remaining files after reopening the ledger', async () => {
    const beforeB = await read(root, 'b');
    const beforeC = await read(root, 'c');
    const runner = new PersistentBatchRunner(ledger, {
      prepare: io.prepare.bind(io),
      write: io.write.bind(io),
      changed: (_view, progress) => {
        if (progress?.applied === 1) void runner.cancel();
      },
    });
    const cancelled = await runner.run(operation.id);
    expect(cancelled.summary).toMatchObject({ applied: ['photos:a'], cancelled: true });
    expect(cancelled.remaining).toBe(2);
    expect(await read(root, 'b')).toBe(beforeB);
    expect(await read(root, 'c')).toBe(beforeC);
    const resumed = new PersistentBatchRunner(new DiskBatchLedger(ledger.root), {
      prepare: io.prepare.bind(io),
      write: io.write.bind(io),
      changed: () => {},
    });
    expect((await resumed.run(operation.id)).summary.applied).toHaveLength(3);
  });

  it('replays a prepared absolute target patch after the sidecar committed but the ledger became unavailable', async () => {
    operation.assetIds = ['photos:a'];
    operation.request = undefined;
    operation.patch = {
      temperature: 7200,
      tint: 11,
      whiteBalancePreset: 'Custom',
      wbSource: 'Manual',
    };
    await ledger.delete(operation.id);
    await ledger.create(operation);
    const saved = join(root, 'saved-ledger-assets');
    const runner = new PersistentBatchRunner(ledger, {
      prepare: io.prepare.bind(io),
      write: async (op, id, patch) => {
        await io.write(op, id, patch);
        await fs.rename(join(ledger.root, 'assets'), saved);
      },
      changed: () => {},
    });
    await expect(runner.run(operation.id)).rejects.toThrow();
    await fs.rename(saved, join(ledger.root, 'assets'));
    const prepared = (await ledger.assets(operation.id)).find((a) => a.id === 'photos:a')!;
    expect(prepared.status).toBe('prepared');
    expect(prepared.prepared?.patch.temperature).toBe(7200);
    const prepare = vi.fn(async () => {
      throw new Error('Must not calculate the delta twice');
    });
    const recovered = new PersistentBatchRunner(new DiskBatchLedger(ledger.root), {
      prepare,
      write: io.write.bind(io),
      changed: () => {},
    });
    await recovered.run(operation.id);
    expect(prepare).not.toHaveBeenCalled();
    expect(parser.parseAdjustmentModel(await read(root, 'a')).model).toMatchObject({
      temperature: 7200,
      tint: 11,
    });
  });
  it('records malformed existing XML without overwriting its bytes', async () => {
    const malformed = '<rdf:RDF><broken';
    await fs.writeFile(join(root, 'photos/b.xmp'), malformed);
    const runner = new PersistentBatchRunner(ledger, {
      prepare: io.prepare.bind(io),
      write: io.write.bind(io),
      changed: () => {},
    });
    const result = await runner.run(operation.id);
    expect(result.summary.failed.map((failure) => failure.id)).toEqual(['photos:b']);
    expect(await read(root, 'b')).toBe(malformed);
  });

  it('preserves an unselected user edit authored while the target sidecar is being read', async () => {
    const library = TestBed.inject(LibraryStateService);
    const prepared = await io.prepare(operation, 'photos:a');
    duringRead = () => library.updateAdjustment('photos:a', { saturation: 47 });
    await io.write(operation, 'photos:a', prepared);
    expect(parser.parseAdjustmentModel(await read(root, 'a')).model).toMatchObject({
      exposure: 1.25,
      saturation: 47,
    });
  });
  it.each(['before prepared acknowledgment', 'after sidecar commit'])(
    'resumes only the persisted failed-only selection after interruption %s',
    async (point) => {
      const a = await read(root, 'a');
      const b = await read(root, 'b');
      const c = await read(root, 'c');
      await fs.writeFile(join(root, 'photos/a.xmp'), '<broken');
      const initial = new PersistentBatchRunner(ledger, {
        prepare: io.prepare.bind(io),
        write: io.write.bind(io),
        changed: (_view, progress) => {
          if (progress?.failed === 1) void initial.cancel();
        },
      });
      const cancelled = await initial.run(operation.id);
      expect(cancelled.summary.failed.map((failure) => failure.id)).toEqual(['photos:a']);
      expect(cancelled.remaining).toBe(2);
      await fs.writeFile(join(root, 'photos/a.xmp'), a);
      const saved = join(root, 'unavailable-assets');
      const interrupted = new PersistentBatchRunner(ledger, {
        prepare: async (op, id) => {
          const prepared = await io.prepare(op, id);
          if (point === 'before prepared acknowledgment')
            await fs.rename(join(ledger.root, 'assets'), saved);
          return prepared;
        },
        write: async (op, id, prepared) => {
          await io.write(op, id, prepared);
          if (point === 'after sidecar commit') await fs.rename(join(ledger.root, 'assets'), saved);
        },
        changed: () => {},
      });
      await expect(interrupted.run(operation.id, true)).rejects.toThrow();
      await fs.rename(saved, join(ledger.root, 'assets'));
      const reopened = new PersistentBatchRunner(new DiskBatchLedger(ledger.root), {
        prepare: io.prepare.bind(io),
        write: io.write.bind(io),
        changed: () => {},
      });
      const recovered = await reopened.run(operation.id);
      expect(recovered.summary.applied).toEqual(['photos:a']);
      expect(recovered.remaining).toBe(2);
      expect(await read(root, 'b')).toBe(b);
      expect(await read(root, 'c')).toBe(c);
      expect((await reopened.run(operation.id)).summary.applied).toHaveLength(3);
    },
  );

  it('rejects a later selected-field edit when replaying a persisted prepared patch', async () => {
    const prepared = await io.prepare(operation, 'photos:a');
    await io.write(operation, 'photos:a', prepared);
    const path = join(root, 'photos/a.xmp');
    const edited = (await read(root, 'a')).replace(
      'crs:Exposure2012="1.25"',
      'crs:Exposure2012="2.5"',
    );
    expect(edited).toContain('crs:Exposure2012="2.5"');
    await fs.writeFile(path, edited);
    await expect(io.write(operation, 'photos:a', prepared)).rejects.toThrow(
      'Selected settings changed',
    );
    expect(await read(root, 'a')).toBe(edited);
  });
});
