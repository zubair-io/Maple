import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { FolderAccessService } from '../folder-access/folder-access.service';
import type { MapleFolderHandle } from '../folder-access/folder-access.types';
import { MapleCacheService } from './maple-cache.service';

const folder: MapleFolderHandle = { name: 'QA', read: true, write: true };
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const avif = new Uint8Array([0, 0, 0, 28, 102, 116, 121, 112, 97, 118, 105, 102]);
const source = { size: 42, lastModified: 1234 };

describe('Hosted derivative sidecar fingerprints', () => {
  let cache: MapleCacheService;
  let files: Map<string, Uint8Array>;
  let modified: Map<string, number>;
  let clock: number;

  beforeEach(() => {
    files = new Map();
    modified = new Map();
    clock = 2000;
    TestBed.configureTestingModule({
      providers: [
        MapleCacheService,
        {
          provide: FolderAccessService,
          useValue: {
            async readFile(_folder: MapleFolderHandle, path: string) {
              const bytes = files.get(path);
              if (!bytes) throw new DOMException(path, 'NotFoundError');
              return bytes;
            },
            async writeFile(_folder: MapleFolderHandle, path: string, bytes: Uint8Array) {
              files.set(path, bytes);
              modified.set(path, ++clock);
            },
            async fileMetadata(_folder: MapleFolderHandle, path: string) {
              const bytes = files.get(path);
              if (!bytes) throw new DOMException(path, 'NotFoundError');
              return { size: bytes.length, lastModified: modified.get(path) ?? 0 };
            },
            async ensureSubdirectory(handle: MapleFolderHandle) {
              return handle;
            },
          },
        },
      ],
    });
    cache = TestBed.inject(MapleCacheService);
  });

  it('rejects a thumb after its sidecar or derivative bytes change', async () => {
    await cache.writeThumb(
      folder,
      'a.dng',
      new Blob([jpeg], { type: 'image/jpeg' }),
      'jpeg',
      'absent',
    );
    expect(await cache.readThumb(folder, 'a.dng', 'absent')).not.toBeNull();
    expect(await cache.readThumb(folder, 'a.dng', 'a'.repeat(64))).toBeNull();
    files.set('.maple/thumbs/a.dng.jpg', new Uint8Array([0xff, 0xd8, 0, 0xff, 0xd9]));
    expect(await cache.readThumb(folder, 'a.dng', 'absent')).toBeNull();
  });

  it('uses a stamped Hosted JPEG when an unstamped portable AVIF coexists', async () => {
    await cache.writeThumb(
      folder,
      'a.dng',
      new Blob([jpeg], { type: 'image/jpeg' }),
      'jpeg',
      'absent',
    );
    files.set('.maple/thumbs/a.dng.avif', avif);
    expect((await cache.readThumb(folder, 'a.dng', 'absent'))?.type).toBe('image/jpeg');
  });

  it('rejects a preview after its sidecar or derivative bytes change', async () => {
    const edited = 'a'.repeat(64);
    await cache.writePreview(
      folder,
      '',
      'a.dng',
      new Blob([jpeg], { type: 'image/jpeg' }),
      source,
      edited,
    );
    expect(await cache.readPreview(folder, '', 'a.dng', source, edited)).not.toBeNull();
    expect(await cache.readPreview(folder, '', 'a.dng', source, 'absent')).toBeNull();
    expect(await cache.readPreview(folder, '', 'a.dng', source, 'b'.repeat(64))).toBeNull();
    files.set('.maple/previews/a.dng.jpg', new Uint8Array([0xff, 0xd8, 0, 0xff, 0xd9]));
    expect(await cache.readPreview(folder, '', 'a.dng', source, edited)).toBeNull();
  });

  it('rejects an unstamped portable preview during a Hosted sidecar check', async () => {
    files.set('.maple/previews/a.dng.avif', avif);
    modified.set('.maple/previews/a.dng.avif', source.lastModified + 1);
    expect(await cache.readPreview(folder, '', 'a.dng', source, 'absent')).toBeNull();
  });
});
