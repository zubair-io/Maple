// Cross-platform preview path-derivation contract (#1997, epic #1993 stage 5).
//
// Server, web, and Apple each independently compute
// `<relDir>/.maple/previews/<filename>.avif` for a given asset. This test
// pins the WEB half of that contract (`MapleCacheService.writePreview`'s
// `<relDir>/.maple/previews/<filename>.avif` path composition) against the
// SAME golden fixture the server (`tests/preview-path-contract.test.ts`) and
// Apple (`PreviewPathContractTests.swift`) resolvers are pinned against, so a
// change to any one implementation's path scheme fails loudly here instead
// of silently diverging from the other two. See `preview-path-contract.json`'s
// header for the shared-fixture convention (mirrors `auth-contract.json`).

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';

import { MapleCacheService } from '../maple-cache/maple-cache.service';
import { FolderAccessService } from '../folder-access/folder-access.service';
import { MapleFolderHandle } from '../folder-access/folder-access.types';
import contract from './preview-path-contract.json';

function folder(): MapleFolderHandle {
  return { name: 'lib', read: true, write: true };
}

describe('preview path contract — web resolver agrees with the shared golden (#1997)', () => {
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
      async fileMetadata(_f: MapleFolderHandle, path: string) {
        if (!files.has(path)) throw new Error(`ENOENT ${path}`);
        return { size: files.get(path)!.byteLength, lastModified: 1 };
      },
      async ensureSubdirectory(f: MapleFolderHandle, _name: string): Promise<MapleFolderHandle> {
        return f;
      },
    };
    TestBed.configureTestingModule({
      providers: [MapleCacheService, { provide: FolderAccessService, useValue: fakeFs }],
    });
    svc = TestBed.inject(MapleCacheService);
  });

  const avif = () =>
    new Blob([new Uint8Array([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66])], {
      type: 'image/avif',
    });

  it('fixture is non-empty and every case has the fields this test depends on', () => {
    expect(contract.cases.length).toBeGreaterThan(0);
    for (const c of contract.cases) {
      expect(typeof c.relDir).toBe('string');
      expect(c.filename).toBeTruthy();
      expect(c.relPath).toBeTruthy();
    }
  });

  for (const c of contract.cases) {
    it(`writePreview(${c.id}) lands at the golden relPath "${c.relPath}"`, async () => {
      await svc.writePreview(folder(), c.relDir, c.filename, avif(), {
        size: 42,
        lastModified: 1234,
      });
      expect(files.has(c.relPath)).toBe(true);
      // The cross-platform AVIF artifact path remains exact. Hosted also
      // writes a local descriptor beside it; API and Apple do not consume it.
      expect(files.has(`${c.relPath.slice(0, -'.avif'.length)}.preview.json`)).toBe(true);
      expect(files.size).toBe(2);
    });
  }
});
