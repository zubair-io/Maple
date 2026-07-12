// MapleCacheService — thumb cache pipeline-version guard (#1927).
//
// Covers the `<sha>.jpg.v` companion marker: a locally-developed thumb is
// stamped with THUMB_PIPELINE_VERSION and re-developed once that version
// moves ahead of the marker, while a foreign (server/native, unmarked) thumb
// is trusted as-is. FolderAccessService is faked with an in-memory path→bytes
// map so no real FS Access / IndexedDB backend is exercised.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';

import { MapleCacheService, THUMB_PIPELINE_VERSION } from './maple-cache.service';
import { FolderAccessService } from '../folder-access/folder-access.service';
import { MapleFolderHandle } from '../folder-access/folder-access.types';

const SHA = 'abc1230000000000';
const JPG = `.maple/thumbs/${SHA}.jpg`;
const MARKER = `.maple/thumbs/${SHA}.jpg.v`;

function folder(write = true): MapleFolderHandle {
  return { name: 'lib', read: true, write };
}

describe('MapleCacheService — thumb pipeline-version guard (#1927)', () => {
  let svc: MapleCacheService;
  let files: Map<string, Uint8Array>;

  beforeEach(() => {
    files = new Map();
    const fakeFs = {
      async readFile(_f: MapleFolderHandle, path: string): Promise<Uint8Array> {
        const b = files.get(path);
        if (!b) throw new Error(`ENOENT ${path}`);
        return b;
      },
      async writeFile(_f: MapleFolderHandle, path: string, data: Uint8Array): Promise<void> {
        files.set(path, data);
      },
      async ensureSubdirectory(f: MapleFolderHandle): Promise<MapleFolderHandle> {
        return f;
      },
    };
    TestBed.configureTestingModule({
      providers: [MapleCacheService, { provide: FolderAccessService, useValue: fakeFs }],
    });
    svc = TestBed.inject(MapleCacheService);
  });

  const jpeg = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' });
  const markerInt = () => Number.parseInt(new TextDecoder().decode(files.get(MARKER)!).trim(), 10);

  it('writeThumb writes the jpg AND the version companion', async () => {
    await svc.writeThumb(folder(), SHA, jpeg());
    expect(files.has(JPG)).toBe(true);
    expect(files.has(MARKER)).toBe(true);
    expect(markerInt()).toBe(THUMB_PIPELINE_VERSION);
  });

  it('writeThumb skips entirely on a read-only folder', async () => {
    await svc.writeThumb(folder(false), SHA, jpeg());
    expect(files.has(JPG)).toBe(false);
    expect(files.has(MARKER)).toBe(false);
  });

  it('readThumb serves a thumb whose marker matches the current version', async () => {
    await svc.writeThumb(folder(), SHA, jpeg());
    const blob = await svc.readThumb(folder(), SHA);
    expect(blob).not.toBeNull();
    expect(blob!.type).toBe('image/jpeg');
  });

  it('readThumb misses a thumb whose marker is older than the current version', async () => {
    files.set(JPG, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    files.set(MARKER, new TextEncoder().encode(String(THUMB_PIPELINE_VERSION - 1)));
    const blob = await svc.readThumb(folder(), SHA);
    expect(blob).toBeNull();
  });

  it('readThumb trusts a foreign thumb with no version marker', async () => {
    // Server/native write only the .jpg (embedded-preview, version-independent).
    files.set(JPG, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    const blob = await svc.readThumb(folder(), SHA);
    expect(blob).not.toBeNull();
  });

  it('readThumb returns null when no cached thumb exists', async () => {
    const blob = await svc.readThumb(folder(), SHA);
    expect(blob).toBeNull();
  });
});
