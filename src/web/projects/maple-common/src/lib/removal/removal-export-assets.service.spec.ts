import { promises as fs, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { NativeDetailClient } from '../raw-pipeline/raw-pipeline.native-detail';
import { NativeDetailWorker } from '../raw-pipeline/raw-pipeline.native-detail-handler';
import type { PendingHandler } from '../raw-pipeline/raw-pipeline.service-internals';
import type { NativeDetailRequest } from '../raw-pipeline/raw-pipeline.native-detail.types';
import { savedRemovalRecords } from './saved-removal-records';
import {
  initSync,
  NativeDetailSession,
  removal_prepare,
  removal_content_digest,
} from '../raw-pipeline/pkg/raw_wasm';
import { LibraryStateService } from '../state/library-state.service';
import { FolderAccessService } from '../folder-access/folder-access.service';
import { fsAccessReadFile } from '../folder-access/fs-access-backend';
import { LibrarySlugRegistry } from '../addressing/library-slug-registry';
import { DiskDirectory } from '../editor/copy-paste/testing/batch-test-files';
import { RemovalExportAssetsService } from './removal-export-assets.service';
import type { Asset } from '../models/asset';

const fixtures = resolve(process.cwd(), '../../test-fixtures/removal/basic');
const fixture = (name: string) => new Uint8Array(readFileSync(join(fixtures, name)));
const raw = fixture('source.dng');
const focused = signal<Asset | null>(null);

describe('export resolves actual durable removal companions independently of focus', () => {
  let root: string,
    xml: string,
    directory: FileSystemDirectoryHandle,
    service: RemovalExportAssetsService;
  let companions: Map<string, Uint8Array>;
  beforeAll(() =>
    initSync({
      module: readFileSync(
        resolve(process.cwd(), 'projects/maple-common/src/lib/raw-pipeline/pkg/raw_wasm_bg.wasm'),
      ),
    }),
  );
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'maple-removal-export-'));
    directory = new DiskDirectory(root) as unknown as FileSystemDirectoryHandle;
    focused.set(null);
    await fs.mkdir(join(root, '.maple/inpaint'), { recursive: true });
    await fs.writeFile(join(root, 'photo.dng'), raw);
    const session = new NativeDetailSession(raw, 'dng');
    try {
      const request = JSON.parse(readFileSync(join(fixtures, 'request.txt'), 'utf8'));
      const mask = fixture('mask.mimf'),
        patch = fixture('patch.f16');
      const records = removal_prepare(
        JSON.stringify({
          ...request,
          plate: 'linear-calibration-v1',
          source: JSON.parse(session.removal_calibration_source()),
        }),
        '[]',
        mask,
        patch,
      );
      xml = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:papp="http://ns.justmaple.app/photo/1.0/" papp:InpaintRemovals="${records.replaceAll('"', '&quot;')}" /></rdf:RDF></x:xmpmeta>`;
      companions = new Map([
        [removal_content_digest(mask).slice(7) + '.mask', mask],
        [removal_content_digest(patch).slice(7) + '.f16', patch],
      ]);
      for (const [name, bytes] of companions)
        await fs.writeFile(join(root, '.maple/inpaint', name), bytes);
    } finally {
      session.free();
    }
    TestBed.configureTestingModule({
      providers: [
        {
          provide: LibraryStateService,
          useValue: {
            focusedAsset: focused,
            currentFolder: () => ({ name: root, native: directory, read: true, write: false }),
          },
        },
        { provide: FolderAccessService, useValue: { readFile: fsAccessReadFile } },
        {
          provide: LibrarySlugRegistry,
          useValue: { getHandle: async (slug: string) => (slug === 'photos' ? directory : null) },
        },
      ],
    });
    service = TestBed.inject(RemovalExportAssetsService);
  });
  afterEach(async () => {
    TestBed.resetTestingModule();
    await fs.rm(root, { recursive: true, force: true });
  });
  it('loads a registered nonfocused photo and retains exact companion bytes', async () => {
    const bundle = await service.load('photos:photo.dng', 'photo.dng', xml);
    expect(bundle).toBeDefined();
    const session = new NativeDetailSession(raw, 'dng');
    try {
      expect(session.prepare_saved_removals(xml, bundle!.manifest, bundle!.bytes)).toBe('[]');
    } finally {
      session.free();
    }
    expect(
      new Set(JSON.parse(bundle!.manifest).map((entry: { name: string }) => entry.name)),
    ).toEqual(new Set(companions.keys()));
  });
  it('uses a captured queue directory even when the registry or focus has changed', async () => {
    focused.set({ id: 'other:photo.dng', filename: 'photo.dng' } as Asset);
    expect(await service.load('old:photo.dng', 'photo.dng', xml, directory)).toBeDefined();
  });
  it('uses a read-only focused containing folder for a local imported photo', async () => {
    focused.set({ id: 'imported', filename: 'photo.dng' } as Asset);
    expect(await service.load('imported', 'photo.dng', xml)).toBeDefined();
  });
  it('rejects missing companions and a replaced RAW before exporting', async () => {
    await fs.writeFile(join(root, 'photo.dng'), new Uint8Array([1, 2, 3]));
    await expect(service.load('photos:photo.dng', 'photo.dng', xml)).rejects.toThrow();
    await fs.writeFile(join(root, 'photo.dng'), raw);
    await fs.unlink(join(root, '.maple/inpaint', [...companions.keys()][0]));
    await expect(service.load('photos:photo.dng', 'photo.dng', xml)).rejects.toThrow();
  });
  it('rejects unsafe or unresolved recipe addresses without reading outside the library', async () => {
    for (const id of ['photos:../photo.dng', 'photos:wrong.dng', 'old:photo.dng'])
      await expect(service.load(id, 'photo.dng', xml)).rejects.toThrow('Reopen');
  });
  it('needs no folder or models for a recipe without removals', async () => {
    expect(
      await service.load('absent', 'photo.dng', '<x:xmpmeta xmlns:x="adobe:ns:meta/"/>'),
    ).toBeUndefined();
  });
  it('renders saved native tiles through the actual worker and reuses assets over pans and authoring', async () => {
    const pending = new Map<number, PendingHandler>();
    let nextId = 0;
    const worker = new NativeDetailWorker({
      ready: async () => undefined,
      open: (bytes, ext) => new NativeDetailSession(bytes, ext),
      post: (reply) => {
        const handler = pending.get(reply.id)!;
        pending.delete(reply.id);
        if (reply.type === 'native-detail-error') handler.reject(new Error(reply.message));
        else if (handler.kind === 'native-detail')
          handler.resolve({
            width: reply.width,
            height: reply.height,
            rgb: new Uint8Array(reply.rgb),
          });
      },
    });
    const transport = {
      postMessage: (request: NativeDetailRequest | { type: 'close-native-detail' }) => {
        if (request.type === 'close-native-detail') worker.close();
        else void worker.render(request);
      },
    } as unknown as Worker;
    const client = new NativeDetailClient(
      () => transport,
      () => ++nextId,
      pending,
    );
    const load = vi.spyOn(service, 'load');
    const sourceId = 'photos:photo.dng';
    const args = {
      sourceId,
      bytes: raw,
      ext: 'dng',
      xmp: xml,
      rect: { x: 2, y: 1, width: 6, height: 4 },
      maxLongEdge: 64,
      qualityPreview: false,
      removalRecords: savedRemovalRecords(xml),
      loadRemovals: () => service.load(sourceId, 'photo.dng', xml),
    };
    const oracle = new NativeDetailSession(raw, 'dng');
    try {
      const bundle = await service.load(sourceId, 'photo.dng', xml);
      oracle.prepare_saved_removals(xml, bundle!.manifest, bundle!.bytes);
      const base = oracle.render_saved_removals(xml, 64, new Uint8Array());
      const width = base.width;
      const pixels = base.take_rgb();
      base.free();
      const expectedTile = (x: number) => {
        const result = new Uint8Array(6 * 4 * 3);
        for (let y = 0; y < 4; y++) {
          const start = ((y + 1) * width + x) * 3;
          result.set(pixels.subarray(start, start + 18), y * 18);
        }
        return result;
      };
      load.mockClear();
      expect((await client.render(args, client.revision())).rgb).toEqual(expectedTile(2));
      expect(
        (await client.render({ ...args, rect: { ...args.rect, x: 4 } }, client.revision())).rgb,
      ).toEqual(expectedTile(4));
      expect(load).toHaveBeenCalledOnce();
      // A temporary authoring preparation must not strand the tile owner's
      // accepted recipe. Reinstall the retained bytes without another read.
      await worker.withRemovalSession(sourceId, 'dng', undefined, (retained) =>
        retained.prepare_saved_removals!(
          '<rdf:Description xmlns:rdf="x"/>',
          '[]',
          new Uint8Array(),
        ),
      );
      expect((await client.render(args, client.revision())).rgb).toEqual(expectedTile(2));
      expect(load).toHaveBeenCalledOnce();
      // Removing the recipe must discard the retained companion manifest,
      // rather than trying to prepare nonempty assets for an ordinary tile.
      expect(
        (
          await client.render(
            { ...args, xmp: undefined, removalRecords: undefined },
            client.revision(),
          )
        ).rgb.length,
      ).toBe(72);
      client.close();
      await fs.unlink(join(root, '.maple/inpaint', [...companions.keys()][0]));
      await expect(client.render(args, client.revision())).rejects.toThrow();
      expect(pending.size).toBe(0);
    } finally {
      client.close();
      worker.close();
      oracle.free();
    }
  });
});
