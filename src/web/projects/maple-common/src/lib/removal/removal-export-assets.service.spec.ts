import { promises as fs, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
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
});
