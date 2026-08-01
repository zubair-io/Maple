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
import { PIPELINE_OUTPUT_VERSION } from '../generated/adjustment-model.generated';
import { FolderAccessService } from '../folder-access/folder-access.service';
import { MapleFolderHandle } from '../folder-access/folder-access.types';

const SHA = 'abc1230000000000';
const JPG = `.maple/thumbs/${SHA}.jpg`;
const MARKER = `.maple/thumbs/${SHA}.jpg.v`;
const AVIF = `.maple/thumbs/${SHA}.avif`;
const AVIF_MARKER = `.maple/thumbs/${SHA}.avif.v`;

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
      async ensureSubdirectory(f: MapleFolderHandle, _name: string): Promise<MapleFolderHandle> {
        return f;
      },
    };
    TestBed.configureTestingModule({
      providers: [MapleCacheService, { provide: FolderAccessService, useValue: fakeFs }],
    });
    svc = TestBed.inject(MapleCacheService);
  });

  const jpeg = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' });
  const avif = () =>
    new Blob(
      [new Uint8Array([0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66])],
      { type: 'image/avif' },
    );
  const markerInt = () => Number.parseInt(new TextDecoder().decode(files.get(MARKER)!).trim(), 10);
  const avifMarkerInt = () =>
    Number.parseInt(new TextDecoder().decode(files.get(AVIF_MARKER)!).trim(), 10);

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

  it('readThumb re-decodes a thumb whose marker is present but corrupt', async () => {
    // A partial write leaves a `.v` companion that doesn't parse. Since only
    // locally-developed thumbs carry a marker, a corrupt one must force a
    // re-decode rather than be trusted.
    files.set(JPG, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    files.set(MARKER, new TextEncoder().encode('not-a-number'));
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

  it("writeThumb with format 'avif' writes the avif AND its own version companion", async () => {
    await svc.writeThumb(folder(), SHA, avif(), 'avif');
    expect(files.has(AVIF)).toBe(true);
    expect(files.has(AVIF_MARKER)).toBe(true);
    expect(files.has(JPG)).toBe(false);
    expect(avifMarkerInt()).toBe(THUMB_PIPELINE_VERSION);
  });

  it('readThumb serves a locally-written avif thumb whose marker matches the current version', async () => {
    await svc.writeThumb(folder(), SHA, avif(), 'avif');
    const blob = await svc.readThumb(folder(), SHA);
    expect(blob).not.toBeNull();
    expect(blob!.type).toBe('image/avif');
  });

  it('readThumb prefers avif over a co-present legacy jpg', async () => {
    // A library can hold both a pre-migration jpg and a freshly re-developed
    // avif for the same sha (the jpg becomes an orphan; nothing deletes it
    // client-side). avif must win the read.
    files.set(JPG, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    await svc.writeThumb(folder(), SHA, avif(), 'avif');
    const blob = await svc.readThumb(folder(), SHA);
    expect(blob!.type).toBe('image/avif');
  });

  it('readThumb ignores a mislabeled avif and falls back to a real legacy jpg', async () => {
    files.set(AVIF, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    files.set(JPG, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    const blob = await svc.readThumb(folder(), SHA);
    expect(blob?.type).toBe('image/jpeg');
  });

  it('readThumb re-decodes a corrupt locally-written avif instead of serving an older jpg', async () => {
    files.set(AVIF, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    files.set(AVIF_MARKER, new TextEncoder().encode(String(THUMB_PIPELINE_VERSION)));
    files.set(JPG, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    expect(await svc.readThumb(folder(), SHA)).toBeNull();
  });

  it('writeThumb refuses bytes that do not match the requested format', async () => {
    await svc.writeThumb(folder(), SHA, jpeg(), 'avif');
    expect(files.has(AVIF)).toBe(false);
    expect(files.has(AVIF_MARKER)).toBe(false);
  });

  it('readThumb falls back to a legacy jpg when no avif is cached', async () => {
    // Foreign (server/native) thumb pre-dating the AVIF migration, or a local
    // thumb from a browser whose canvas encode fell back to JPEG.
    files.set(JPG, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    const blob = await svc.readThumb(folder(), SHA);
    expect(blob).not.toBeNull();
    expect(blob!.type).toBe('image/jpeg');
  });

  it('readThumb misses a stale locally-written avif rather than falling back to an even-older jpg', async () => {
    files.set(JPG, new Uint8Array([0xff, 0xd8, 0xff, 0xd9])); // a co-present legacy entry
    files.set(
      AVIF,
      new Uint8Array([0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]),
    );
    files.set(AVIF_MARKER, new TextEncoder().encode(String(THUMB_PIPELINE_VERSION - 1)));
    const blob = await svc.readThumb(folder(), SHA);
    // Stale avif must NOT fall through to the co-present jpg and must not be
    // served — the caller re-decodes.
    expect(blob).toBeNull();
  });
});

describe('MapleCacheService — unedited-preview cache (#2010, canonical <dir>/.maple/previews/<filename>.avif)', () => {
  let svc: MapleCacheService;
  let files: Map<string, Uint8Array>;
  let modified: Map<string, number>;
  let ensured: string[];

  beforeEach(() => {
    files = new Map();
    modified = new Map();
    ensured = [];
    const fakeFs = {
      async readFile(_f: MapleFolderHandle, path: string): Promise<Uint8Array> {
        const b = files.get(path);
        if (!b) throw new Error(`ENOENT ${path}`);
        return b;
      },
      async writeFile(_f: MapleFolderHandle, path: string, data: Uint8Array): Promise<void> {
        files.set(path, data);
        modified.set(path, Date.now());
      },
      async fileMetadata(_f: MapleFolderHandle, path: string) {
        if (!files.has(path)) throw new Error(`ENOENT ${path}`);
        return { size: files.get(path)!.byteLength, lastModified: modified.get(path) ?? 0 };
      },
      async ensureSubdirectory(f: MapleFolderHandle, name: string): Promise<MapleFolderHandle> {
        ensured.push(name);
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

  it('writePreview lands the AVIF in the asset OWN directory (per-directory .maple, not root)', async () => {
    await svc.writePreview(folder(), '2024/France', 'IMG_1234.CR2', avif());
    expect(files.has('2024/France/.maple/previews/IMG_1234.CR2.avif')).toBe(true);
    expect(ensured).toContain('2024/France/.maple/previews');
  });

  it('writePreview for a root-level asset keys off dir="" (root .maple/previews)', async () => {
    await svc.writePreview(folder(), '', 'top.dng', avif());
    expect(files.has('.maple/previews/top.dng.avif')).toBe(true);
    expect(ensured).toContain('.maple/previews');
  });

  it('writePreview skips entirely on a read-only folder', async () => {
    await svc.writePreview(folder(false), '2024', 'a.dng', avif());
    expect(files.size).toBe(0);
    expect(ensured).toEqual([]);
  });

  it('readPreview round-trips a written AVIF with image/avif type', async () => {
    const source = { size: 42, lastModified: 1234 };
    await svc.writePreview(folder(), '2024', 'a.dng', avif(), source);
    const blob = await svc.readPreview(folder(), '2024', 'a.dng', source);
    expect(blob).not.toBeNull();
    expect(blob!.type).toBe('image/avif');
  });

  it('readPreview returns null when nothing is cached', async () => {
    expect(
      await svc.readPreview(folder(), '2024', 'missing.dng', { size: 1, lastModified: 1 }),
    ).toBeNull();
  });

  it('readPreview refuses cached bytes that are not AVIF', async () => {
    files.set('2024/.maple/previews/a.dng.avif', new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    expect(
      await svc.readPreview(folder(), '2024', 'a.dng', { size: 1, lastModified: 1 }),
    ).toBeNull();
  });

  it('readPreview accepts mif1 containers with an AVIF compatible brand', async () => {
    files.set(
      '2024/.maple/previews/a.dng.avif',
      new Uint8Array([
        0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x69, 0x66, 0x31, 0, 0, 0, 0, 0x61, 0x76, 0x69,
        0x66,
      ]),
    );
    modified.set('2024/.maple/previews/a.dng.avif', 2);
    expect(
      (await svc.readPreview(folder(), '2024', 'a.dng', { size: 1, lastModified: 1 }))?.type,
    ).toBe('image/avif');
  });

  it('invalidates a same-named RAW replacement against the recorded source identity', async () => {
    const original = { size: 100, lastModified: 1_700_000_000_000 };
    await svc.writePreview(folder(), '', 'replace.dng', avif(), original);

    expect(await svc.readPreview(folder(), '', 'replace.dng', original)).not.toBeNull();
    expect(
      await svc.readPreview(folder(), '', 'replace.dng', {
        size: 101,
        lastModified: original.lastModified,
      }),
    ).toBeNull();
  });

  it('does not let a fresh derivative mtime bless a corrupt source marker', async () => {
    const previewPath = '.maple/previews/corrupt.dng.avif';
    files.set(
      previewPath,
      new Uint8Array([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]),
    );
    files.set(`${previewPath}.source.json`, new TextEncoder().encode('{not-json'));
    modified.set(previewPath, 2_000);

    expect(
      await svc.readPreview(folder(), '', 'corrupt.dng', { size: 10, lastModified: 1_000 }),
    ).toBeNull();
  });

  it('writePreview refuses a JPEG carrying an image/avif MIME label', async () => {
    const mislabeled = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], {
      type: 'image/avif',
    });
    await svc.writePreview(folder(), '2024', 'a.dng', mislabeled);
    expect(files.size).toBe(0);
    expect(ensured).toEqual([]);
  });

  it('preview cache filename includes the original extension (e.g. IMG.CR2.avif, not IMG.avif)', async () => {
    await svc.writePreview(folder(), '', 'IMG.CR2', avif());
    expect(files.has('.maple/previews/IMG.CR2.avif')).toBe(true);
    expect(files.has('.maple/previews/IMG.avif')).toBe(false);
  });
});

describe('THUMB_PIPELINE_VERSION is the single-sourced pipeline-output version (#1926)', () => {
  it('tracks the codegen PIPELINE_OUTPUT_VERSION exactly', () => {
    // The thumb marker is the develop-pipeline-output version, single-sourced
    // in raw-core and mirrored into TypeScript by codegen. Guarding equality
    // here is what makes "bump PIPELINE_OUTPUT_VERSION" propagate to the thumb
    // cache key: a bump moves THUMB_PIPELINE_VERSION ahead of every existing
    // `.jpg.v` marker, so previously-developed thumbs re-develop (the
    // stale-marker miss covered in the suite above). If this ever drifts back
    // to a hand-maintained local integer, this fails.
    expect(THUMB_PIPELINE_VERSION).toBe(PIPELINE_OUTPUT_VERSION);
  });

  it('is a positive integer (unset sentinel 0 is reserved)', () => {
    expect(Number.isInteger(PIPELINE_OUTPUT_VERSION)).toBe(true);
    expect(PIPELINE_OUTPUT_VERSION).toBeGreaterThanOrEqual(1);
  });
});
