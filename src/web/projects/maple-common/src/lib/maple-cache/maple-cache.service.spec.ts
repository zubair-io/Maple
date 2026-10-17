import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MapleCacheService } from './maple-cache.service';
import { FolderAccessService } from '../folder-access/folder-access.service';
import { MapleFolderHandle } from '../folder-access/folder-access.types';

const FILENAME = 'IMG_1234.dng';
/** sha256Prefix16('IMG_1234.dng') — the pinned vector `sha.spec.ts` asserts. */
const SHA = '7ad25b268a071d01';
const JPG = `.maple/thumbs/${FILENAME}.jpg`;
const AVIF = `.maple/thumbs/${FILENAME}.avif`;
const LEGACY_JPG = `.maple/thumbs/${SHA}.v25.jpg`;
const LEGACY_AVIF = `.maple/thumbs/${SHA}.v25.avif`;
function folder(write = true): MapleFolderHandle {
  return { name: 'lib', read: true, write };
}

describe('MapleCacheService — unversioned shared thumbnails (#4795)', () => {
  let svc: MapleCacheService;
  let files: Map<string, Uint8Array>;
  let readFile: ReturnType<typeof vi.fn>;
  const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const avifBytes = new Uint8Array([0, 0, 0, 28, 102, 116, 121, 112, 97, 118, 105, 102]);

  beforeEach(() => {
    files = new Map();
    readFile = vi.fn(async (_folder: MapleFolderHandle, path: string) => {
      const bytes = files.get(path);
      if (!bytes) throw new Error(`ENOENT ${path}`);
      return bytes;
    });
    TestBed.configureTestingModule({
      providers: [
        MapleCacheService,
        {
          provide: FolderAccessService,
          useValue: {
            readFile,
            async writeFile(_folder: MapleFolderHandle, path: string, bytes: Uint8Array) {
              files.set(path, bytes);
            },
            async removeFile(_folder: MapleFolderHandle, path: string) {
              if (!files.delete(path)) throw new Error(`ENOENT ${path}`);
            },
            async ensureSubdirectory(handle: MapleFolderHandle) {
              return handle;
            },
          },
        },
      ],
    });
    svc = TestBed.inject(MapleCacheService);
  });

  it('writes the unversioned filename without a companion marker', async () => {
    await svc.writeThumb(folder(), FILENAME, new Blob([jpegBytes], { type: 'image/jpeg' }));
    expect([...files.keys()]).toEqual([JPG]);
    expect((await svc.readThumb(folder(), FILENAME))?.type).toBe('image/jpeg');
  });

  it('writes an AVIF thumb at .maple/thumbs/<filename.ext>.avif', async () => {
    await svc.writeThumb(folder(), FILENAME, new Blob([avifBytes], { type: 'image/avif' }), 'avif');
    expect([...files.keys()]).toEqual([AVIF]);
  });

  it('reads an unversioned cross-platform AVIF with one file open', async () => {
    files.set(AVIF, avifBytes);
    expect((await svc.readThumb(folder(), FILENAME))?.type).toBe('image/avif');
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledWith(folder(), AVIF);
  });

  it('trusts an unversioned thumb regardless of any stale version marker beside it', async () => {
    files.set(AVIF, avifBytes);
    files.set(`${AVIF}.v`, new TextEncoder().encode('1'));
    expect((await svc.readThumb(folder(), FILENAME))?.type).toBe('image/avif');
  });

  it('prefers an AVIF over a JPEG fallback', async () => {
    files.set(JPG, jpegBytes);
    files.set(AVIF, avifBytes);
    expect((await svc.readThumb(folder(), FILENAME))?.type).toBe('image/avif');
  });

  it('ignores mislabeled AVIF bytes and reads a genuine JPEG', async () => {
    files.set(AVIF, jpegBytes);
    files.set(JPG, jpegBytes);
    expect((await svc.readThumb(folder(), FILENAME))?.type).toBe('image/jpeg');
  });

  it('renames a frozen legacy .v25 AVIF into place on a miss instead of regenerating', async () => {
    files.set(LEGACY_AVIF, avifBytes);
    expect((await svc.readThumb(folder(), FILENAME))?.type).toBe('image/avif');
    expect([...files.keys()]).toEqual([AVIF]);
    expect(files.get(AVIF)).toEqual(avifBytes);
  });

  it('renames a frozen legacy .v25 JPEG fallback into its unversioned name', async () => {
    files.set(LEGACY_JPG, jpegBytes);
    expect((await svc.readThumb(folder(), FILENAME))?.type).toBe('image/jpeg');
    expect([...files.keys()]).toEqual([JPG]);
  });

  it('serves a legacy .v25 thumb from a read-only folder without touching it', async () => {
    files.set(LEGACY_AVIF, avifBytes);
    expect((await svc.readThumb(folder(false), FILENAME))?.type).toBe('image/avif');
    expect([...files.keys()]).toEqual([LEGACY_AVIF]);
  });

  it('never probes the legacy name when an unversioned thumb is present', async () => {
    files.set(AVIF, avifBytes);
    files.set(LEGACY_AVIF, avifBytes);
    await svc.readThumb(folder(), FILENAME);
    expect(readFile).not.toHaveBeenCalledWith(folder(), LEGACY_AVIF);
    expect(files.has(LEGACY_AVIF)).toBe(true);
  });

  it('does not fall through to a legacy name when the unversioned entry is corrupt', async () => {
    files.set(AVIF, jpegBytes);
    files.set(LEGACY_AVIF, avifBytes);
    expect(await svc.readThumb(folder(), FILENAME)).toBeNull();
  });

  it('writes the thumb under the photo filename, never a hash', async () => {
    await svc.writeThumb(folder(), 'DSC 001.NEF', new Blob([avifBytes]), 'avif');
    expect([...files.keys()]).toEqual(['.maple/thumbs/DSC 001.NEF.avif']);
  });

  it('only consults the hashed name with the frozen .v25 segment', async () => {
    files.set(`.maple/thumbs/${SHA}.avif`, avifBytes);
    expect(await svc.readThumb(folder(), FILENAME)).toBeNull();
    expect([...files.keys()]).toEqual([`.maple/thumbs/${SHA}.avif`]);
  });

  it.each([24, 26, 29])(
    'ignores any version segment other than the frozen .v25 (%s)',
    async (v) => {
      files.set(`.maple/thumbs/${SHA}.v${v}.avif`, avifBytes);
      expect(await svc.readThumb(folder(), FILENAME)).toBeNull();
    },
  );

  it('rejects bytes that do not match the requested output format', async () => {
    await svc.writeThumb(folder(), FILENAME, new Blob([jpegBytes]), 'avif');
    expect(files.size).toBe(0);
  });

  it('does not write to a read-only folder', async () => {
    await svc.writeThumb(folder(false), FILENAME, new Blob([jpegBytes]));
    expect(files.size).toBe(0);
  });
});

describe(`MapleCacheService — unedited-preview cache (#2010, canonical <dir>/.maple/previews/<filename>.avif)`, () => {
  let svc: MapleCacheService;
  let files: Map<string, Uint8Array>;
  let modified: Map<string, number>;
  let ensured: string[];
  let clock: number;

  beforeEach(() => {
    files = new Map();
    modified = new Map();
    ensured = [];
    clock = 1_000_000;
    const fakeFs = {
      async readFile(_f: MapleFolderHandle, path: string): Promise<Uint8Array> {
        const b = files.get(path);
        if (!b) throw new Error(`ENOENT ${path}`);
        return b;
      },
      async writeFile(_f: MapleFolderHandle, path: string, data: Uint8Array): Promise<void> {
        files.set(path, data);
        modified.set(path, ++clock);
      },
      async removeFile(_f: MapleFolderHandle, path: string): Promise<void> {
        if (!files.delete(path)) throw new Error(`ENOENT ${path}`);
        modified.delete(path);
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
  const jpeg = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' });
  const webp = () =>
    new Blob([new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])], {
      type: 'image/webp',
    });
  const png = () =>
    new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], {
      type: 'image/png',
    });
  const webpBytes = () =>
    new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  const source = { size: 42, lastModified: 1234 };

  it('writePreview lands the AVIF in the asset OWN directory (per-directory .maple, not root)', async () => {
    await svc.writePreview(folder(), '2024/France', 'IMG_1234.CR2', avif(), source);
    expect(files.has(`2024/France/.maple/previews/IMG_1234.CR2.avif`)).toBe(true);
    expect(files.has(`2024/France/.maple/previews/IMG_1234.CR2.preview.json`)).toBe(true);
    expect(ensured).toContain('2024/France/.maple/previews');
  });

  it('writePreview for a root-level asset keys off dir="" (root .maple/previews)', async () => {
    await svc.writePreview(folder(), '', 'top.dng', avif(), source);
    expect(files.has(`.maple/previews/top.dng.avif`)).toBe(true);
    expect(ensured).toContain('.maple/previews');
  });

  it('writePreview skips entirely on a read-only folder', async () => {
    await svc.writePreview(folder(false), '2024', 'a.dng', avif(), source);
    expect(files.size).toBe(0);
    expect(ensured).toEqual([]);
  });

  it('readPreview round-trips a written AVIF with image/avif type', async () => {
    await svc.writePreview(folder(), '2024', 'a.dng', avif(), source);
    const blob = await svc.readPreview(folder(), '2024', 'a.dng', source);
    expect(blob).not.toBeNull();
    expect(blob!.type).toBe('image/avif');
  });

  it.each([
    ['jpeg', jpeg(), 'jpg', 'image/jpeg'],
    ['webp', webp(), 'webp', 'image/webp'],
    ['png', png(), 'png', 'image/png'],
  ])(
    'round-trips a Hosted-private %s artifact with its actual format',
    async (_name, blob, ext, mime) => {
      await svc.writePreview(folder(), '', 'format.dng', blob, source);
      expect(files.has(`.maple/previews/format.dng.${ext}`)).toBe(true);
      expect((await svc.readPreview(folder(), '', 'format.dng', source))?.type).toBe(mime);
    },
  );

  it('prefers a newer canonical AVIF written by Apple/API over a Hosted descriptor', async () => {
    await svc.writePreview(folder(), '', 'shared.dng', jpeg(), source);
    const jpegPath = `.maple/previews/shared.dng.jpg`;
    const avifPath = `.maple/previews/shared.dng.avif`;
    files.set(avifPath, new Uint8Array(await avif().arrayBuffer()));
    modified.set(avifPath, (modified.get(jpegPath) ?? 0) + 1);

    const result = await svc.readPreview(folder(), '', 'shared.dng', source);

    expect(result?.type).toBe('image/avif');
  });

  it('keeps the described artifact when a canonical AVIF is older', async () => {
    await svc.writePreview(folder(), '', 'shared.dng', jpeg(), source);
    const jpegPath = `.maple/previews/shared.dng.jpg`;
    const avifPath = `.maple/previews/shared.dng.avif`;
    files.set(avifPath, new Uint8Array(await avif().arrayBuffer()));
    modified.set(avifPath, (modified.get(jpegPath) ?? 1) - 1);

    expect((await svc.readPreview(folder(), '', 'shared.dng', source))?.type).toBe('image/jpeg');
  });

  it('keeps a valid described artifact when a newer canonical AVIF is corrupt', async () => {
    await svc.writePreview(folder(), '', 'shared.dng', webp(), source);
    const webpPath = `.maple/previews/shared.dng.webp`;
    const avifPath = `.maple/previews/shared.dng.avif`;
    files.set(avifPath, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    modified.set(avifPath, (modified.get(webpPath) ?? 0) + 1);

    const result = await svc.readPreview(folder(), '', 'shared.dng', source);

    expect(result?.type).toBe('image/webp');
  });

  it('fails closed when the described artifact is corrupt', async () => {
    await svc.writePreview(folder(), '', 'described-corrupt.dng', png(), source);
    files.set(`.maple/previews/described-corrupt.dng.png`, new Uint8Array([0xff, 0xd8]));

    expect(await svc.readPreview(folder(), '', 'described-corrupt.dng', source)).toBeNull();
  });

  it('readPreview returns null when nothing is cached', async () => {
    expect(
      await svc.readPreview(folder(), '2024', 'missing.dng', { size: 1, lastModified: 1 }),
    ).toBeNull();
  });

  it('readPreview refuses cached bytes that are not AVIF', async () => {
    files.set(`2024/.maple/previews/a.dng.avif`, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    expect(
      await svc.readPreview(folder(), '2024', 'a.dng', { size: 1, lastModified: 1 }),
    ).toBeNull();
  });

  it('readPreview accepts mif1 containers with an AVIF compatible brand', async () => {
    files.set(
      `2024/.maple/previews/a.dng.avif`,
      new Uint8Array([
        0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x69, 0x66, 0x31, 0, 0, 0, 0, 0x61, 0x76, 0x69,
        0x66,
      ]),
    );
    modified.set(`2024/.maple/previews/a.dng.avif`, 2);
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
    const previewPath = `.maple/previews/corrupt.dng.avif`;
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

  it('fails closed on a corrupt descriptor instead of falling back to legacy AVIF', async () => {
    const previewPath = `.maple/previews/corrupt-descriptor.dng.avif`;
    files.set(
      previewPath,
      new Uint8Array([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]),
    );
    files.set(
      `.maple/previews/corrupt-descriptor.dng.preview.json`,
      new TextEncoder().encode('{not-json'),
    );
    modified.set(previewPath, 2_000);

    expect(
      await svc.readPreview(folder(), '', 'corrupt-descriptor.dng', {
        size: 10,
        lastModified: 1_000,
      }),
    ).toBeNull();
  });

  it('rejects descriptor keys inherited from Object.prototype', async () => {
    files.set(
      `.maple/previews/prototype.dng.preview.json`,
      new TextEncoder().encode(JSON.stringify({ version: 1, format: 'toString', source })),
    );
    expect(await svc.readPreview(folder(), '', 'prototype.dng', source)).toBeNull();
  });

  it('keeps a legacy AVIF without a descriptor readable', async () => {
    const previewPath = `.maple/previews/legacy.dng.avif`;
    files.set(
      previewPath,
      new Uint8Array([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]),
    );
    modified.set(previewPath, 2_000);
    expect(
      (await svc.readPreview(folder(), '', 'legacy.dng', { size: 10, lastModified: 1_000 }))?.type,
    ).toBe('image/avif');
  });

  describe('frozen legacy .v25 names (#4795)', () => {
    const avifBytes = new Uint8Array([
      0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66,
    ]);
    const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const descriptorBytes = (format: string, mimeType: string, artifactLastModified: number) =>
      new TextEncoder().encode(
        JSON.stringify({ version: 1, format, mimeType, source, artifactLastModified }),
      );
    const decodeDescriptor = (path: string) =>
      JSON.parse(new TextDecoder().decode(files.get(path)!)) as { artifactLastModified: number };

    it('renames a legacy canonical AVIF into place on a miss instead of regenerating', async () => {
      files.set('2024/.maple/previews/a.dng.v25.avif', avifBytes);
      modified.set('2024/.maple/previews/a.dng.v25.avif', 2_000);

      const blob = await svc.readPreview(folder(), '2024', 'a.dng', {
        size: 1,
        lastModified: 1_000,
      });

      expect(blob?.type).toBe('image/avif');
      expect([...files.keys()]).toEqual(['2024/.maple/previews/a.dng.avif']);
      expect(files.get('2024/.maple/previews/a.dng.avif')).toEqual(avifBytes);
    });

    it('judges a legacy AVIF against its own mtime before the rename', async () => {
      files.set('.maple/previews/stale.dng.v25.avif', avifBytes);
      modified.set('.maple/previews/stale.dng.v25.avif', 500);

      expect(
        await svc.readPreview(folder(), '', 'stale.dng', { size: 1, lastModified: 1_000 }),
      ).toBeNull();
      expect([...files.keys()]).toEqual(['.maple/previews/stale.dng.v25.avif']);
    });

    it('carries a legacy source identity across with its AVIF', async () => {
      files.set('.maple/previews/id.dng.v25.avif', avifBytes);
      files.set(
        '.maple/previews/id.dng.v25.avif.source.json',
        new TextEncoder().encode(JSON.stringify(source)),
      );

      expect((await svc.readPreview(folder(), '', 'id.dng', source))?.type).toBe('image/avif');
      expect([...files.keys()].sort()).toEqual([
        '.maple/previews/id.dng.avif',
        '.maple/previews/id.dng.avif.source.json',
      ]);
      expect((await svc.readPreview(folder(), '', 'id.dng', source))?.type).toBe('image/avif');
    });

    it('renames a legacy descriptor and its JPEG fallback and re-stamps the artifact mtime', async () => {
      files.set('.maple/previews/d.dng.v25.jpg', jpegBytes);
      modified.set('.maple/previews/d.dng.v25.jpg', 10);
      files.set(
        '.maple/previews/d.dng.v25.preview.json',
        descriptorBytes('jpeg', 'image/jpeg', 10),
      );

      expect((await svc.readPreview(folder(), '', 'd.dng', source))?.type).toBe('image/jpeg');
      expect([...files.keys()].sort()).toEqual([
        '.maple/previews/d.dng.jpg',
        '.maple/previews/d.dng.preview.json',
      ]);
      expect(decodeDescriptor('.maple/previews/d.dng.preview.json').artifactLastModified).toBe(
        modified.get('.maple/previews/d.dng.jpg'),
      );
      expect((await svc.readPreview(folder(), '', 'd.dng', source))?.type).toBe('image/jpeg');
    });

    it('keeps the described artifact winning over an older legacy AVIF after the rename', async () => {
      files.set('.maple/previews/o.dng.v25.avif', avifBytes);
      modified.set('.maple/previews/o.dng.v25.avif', 5);
      files.set('.maple/previews/o.dng.v25.webp', webpBytes());
      modified.set('.maple/previews/o.dng.v25.webp', 10);
      files.set(
        '.maple/previews/o.dng.v25.preview.json',
        descriptorBytes('webp', 'image/webp', 10),
      );

      expect((await svc.readPreview(folder(), '', 'o.dng', source))?.type).toBe('image/webp');
      expect((await svc.readPreview(folder(), '', 'o.dng', source))?.type).toBe('image/webp');
    });

    it('serves a newer legacy canonical AVIF over a legacy descriptor and renames it', async () => {
      files.set('.maple/previews/n.dng.v25.jpg', jpegBytes);
      modified.set('.maple/previews/n.dng.v25.jpg', 10);
      files.set(
        '.maple/previews/n.dng.v25.preview.json',
        descriptorBytes('jpeg', 'image/jpeg', 10),
      );
      files.set('.maple/previews/n.dng.v25.avif', avifBytes);
      modified.set('.maple/previews/n.dng.v25.avif', 20);

      expect((await svc.readPreview(folder(), '', 'n.dng', source))?.type).toBe('image/avif');
      expect(files.has('.maple/previews/n.dng.avif')).toBe(true);
      expect(files.has('.maple/previews/n.dng.v25.avif')).toBe(false);
      expect((await svc.readPreview(folder(), '', 'n.dng', source))?.type).toBe('image/avif');
    });

    it('serves a legacy preview from a read-only folder without renaming it', async () => {
      files.set('.maple/previews/ro.dng.v25.avif', avifBytes);
      files.set(
        '.maple/previews/ro.dng.v25.avif.source.json',
        new TextEncoder().encode(JSON.stringify(source)),
      );

      expect((await svc.readPreview(folder(false), '', 'ro.dng', source))?.type).toBe('image/avif');
      expect(files.has('.maple/previews/ro.dng.v25.avif')).toBe(true);
      expect(files.has('.maple/previews/ro.dng.avif')).toBe(false);
    });

    it('does not consult legacy names when an unversioned descriptor is present', async () => {
      await svc.writePreview(folder(), '', 'cur.dng', jpeg(), { size: 1, lastModified: 1 });
      files.set('.maple/previews/cur.dng.v25.avif', avifBytes);
      files.set(
        '.maple/previews/cur.dng.v25.avif.source.json',
        new TextEncoder().encode(JSON.stringify(source)),
      );

      expect(await svc.readPreview(folder(), '', 'cur.dng', source)).toBeNull();
      expect(files.has('.maple/previews/cur.dng.v25.avif')).toBe(true);
    });

    it('ignores version segments other than the frozen .v25', async () => {
      files.set('.maple/previews/v29.dng.v29.avif', avifBytes);
      expect(await svc.readPreview(folder(), '', 'v29.dng', source)).toBeNull();
    });
  });

  it('writePreview refuses a JPEG carrying an image/avif MIME label', async () => {
    const mislabeled = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], {
      type: 'image/avif',
    });
    await svc.writePreview(folder(), '2024', 'a.dng', mislabeled, source);
    expect(files.size).toBe(0);
    expect(ensured).toEqual([]);
  });

  it('preview cache filename includes the original extension (e.g. IMG.CR2.avif, not IMG.avif)', async () => {
    await svc.writePreview(folder(), '', 'IMG.CR2', avif(), source);
    expect(files.has(`.maple/previews/IMG.CR2.avif`)).toBe(true);
    expect(files.has(`.maple/previews/IMG.avif`)).toBe(false);
  });
});
