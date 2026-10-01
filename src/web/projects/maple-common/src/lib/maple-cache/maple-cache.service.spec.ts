import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MapleCacheService } from './maple-cache.service';
import { PIPELINE_OUTPUT_VERSION } from '../generated/adjustment-model.generated';
import { FolderAccessService } from '../folder-access/folder-access.service';
import { MapleFolderHandle } from '../folder-access/folder-access.types';

const SHA = 'abc1230000000000';
const JPG = `.maple/thumbs/${SHA}.v${PIPELINE_OUTPUT_VERSION}.jpg`;
const AVIF = `.maple/thumbs/${SHA}.v${PIPELINE_OUTPUT_VERSION}.avif`;
function folder(write = true): MapleFolderHandle {
  return { name: 'lib', read: true, write };
}

describe('MapleCacheService — versioned shared thumbnails (#3594)', () => {
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
            async ensureSubdirectory(handle: MapleFolderHandle) {
              return handle;
            },
          },
        },
      ],
    });
    svc = TestBed.inject(MapleCacheService);
  });

  it('writes the current filename without a companion marker', async () => {
    await svc.writeThumb(folder(), SHA, new Blob([jpegBytes], { type: 'image/jpeg' }));
    expect([...files.keys()]).toEqual([JPG]);
    expect((await svc.readThumb(folder(), SHA))?.type).toBe('image/jpeg');
  });

  it('reads a current cross-platform AVIF with one file open', async () => {
    files.set(AVIF, avifBytes);
    expect((await svc.readThumb(folder(), SHA))?.type).toBe('image/avif');
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledWith(folder(), AVIF);
  });

  it.each([undefined, PIPELINE_OUTPUT_VERSION - 1, PIPELINE_OUTPUT_VERSION + 1])(
    'rejects foreign thumbnails from pipeline %s even with a fresh legacy marker',
    async (version) => {
      const name = `.maple/thumbs/${SHA}${version === undefined ? '' : `.v${version}`}.avif`;
      files.set(name, avifBytes);
      files.set(`${name}.v`, new TextEncoder().encode(String(PIPELINE_OUTPUT_VERSION)));
      expect(await svc.readThumb(folder(), SHA)).toBeNull();
    },
  );

  it('prefers a current AVIF over a current JPEG fallback', async () => {
    files.set(JPG, jpegBytes);
    files.set(AVIF, avifBytes);
    expect((await svc.readThumb(folder(), SHA))?.type).toBe('image/avif');
  });

  it('ignores mislabeled AVIF bytes and reads a genuine current JPEG', async () => {
    files.set(AVIF, jpegBytes);
    files.set(JPG, jpegBytes);
    expect((await svc.readThumb(folder(), SHA))?.type).toBe('image/jpeg');
  });

  it('never falls back to an unversioned JPEG', async () => {
    files.set(AVIF, jpegBytes);
    files.set(`.maple/thumbs/${SHA}.jpg`, jpegBytes);
    expect(await svc.readThumb(folder(), SHA)).toBeNull();
  });

  it('rejects bytes that do not match the requested output format', async () => {
    await svc.writeThumb(folder(), SHA, new Blob([jpegBytes]), 'avif');
    expect(files.size).toBe(0);
  });

  it('does not write to a read-only folder', async () => {
    await svc.writeThumb(folder(false), SHA, new Blob([jpegBytes]));
    expect(files.size).toBe(0);
  });
});

describe(`MapleCacheService — unedited-preview cache (#2010, canonical <dir>/.maple/previews/<filename>.avif)`, () => {
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
  const jpeg = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' });
  const webp = () =>
    new Blob([new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])], {
      type: 'image/webp',
    });
  const png = () =>
    new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], {
      type: 'image/png',
    });
  const source = { size: 42, lastModified: 1234 };

  it('writePreview lands the AVIF in the asset OWN directory (per-directory .maple, not root)', async () => {
    await svc.writePreview(folder(), '2024/France', 'IMG_1234.CR2', avif(), source);
    expect(
      files.has(`2024/France/.maple/previews/IMG_1234.CR2.v${PIPELINE_OUTPUT_VERSION}.avif`),
    ).toBe(true);
    expect(
      files.has(
        `2024/France/.maple/previews/IMG_1234.CR2.v${PIPELINE_OUTPUT_VERSION}.preview.json`,
      ),
    ).toBe(true);
    expect(ensured).toContain('2024/France/.maple/previews');
  });

  it('writePreview for a root-level asset keys off dir="" (root .maple/previews)', async () => {
    await svc.writePreview(folder(), '', 'top.dng', avif(), source);
    expect(files.has(`.maple/previews/top.dng.v${PIPELINE_OUTPUT_VERSION}.avif`)).toBe(true);
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
      expect(files.has(`.maple/previews/format.dng.v${PIPELINE_OUTPUT_VERSION}.${ext}`)).toBe(true);
      expect((await svc.readPreview(folder(), '', 'format.dng', source))?.type).toBe(mime);
    },
  );

  it('prefers a newer canonical AVIF written by Apple/API over a Hosted descriptor', async () => {
    await svc.writePreview(folder(), '', 'shared.dng', jpeg(), source);
    const jpegPath = `.maple/previews/shared.dng.v${PIPELINE_OUTPUT_VERSION}.jpg`;
    const avifPath = `.maple/previews/shared.dng.v${PIPELINE_OUTPUT_VERSION}.avif`;
    files.set(avifPath, new Uint8Array(await avif().arrayBuffer()));
    modified.set(avifPath, (modified.get(jpegPath) ?? 0) + 1);

    const result = await svc.readPreview(folder(), '', 'shared.dng', source);

    expect(result?.type).toBe('image/avif');
  });

  it('keeps the described artifact when a canonical AVIF is older', async () => {
    await svc.writePreview(folder(), '', 'shared.dng', jpeg(), source);
    const jpegPath = `.maple/previews/shared.dng.v${PIPELINE_OUTPUT_VERSION}.jpg`;
    const avifPath = `.maple/previews/shared.dng.v${PIPELINE_OUTPUT_VERSION}.avif`;
    files.set(avifPath, new Uint8Array(await avif().arrayBuffer()));
    modified.set(avifPath, (modified.get(jpegPath) ?? 1) - 1);

    expect((await svc.readPreview(folder(), '', 'shared.dng', source))?.type).toBe('image/jpeg');
  });

  it('keeps a valid described artifact when a newer canonical AVIF is corrupt', async () => {
    await svc.writePreview(folder(), '', 'shared.dng', webp(), source);
    const webpPath = `.maple/previews/shared.dng.v${PIPELINE_OUTPUT_VERSION}.webp`;
    const avifPath = `.maple/previews/shared.dng.v${PIPELINE_OUTPUT_VERSION}.avif`;
    files.set(avifPath, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    modified.set(avifPath, (modified.get(webpPath) ?? 0) + 1);

    const result = await svc.readPreview(folder(), '', 'shared.dng', source);

    expect(result?.type).toBe('image/webp');
  });

  it('fails closed when the described artifact is corrupt', async () => {
    await svc.writePreview(folder(), '', 'described-corrupt.dng', png(), source);
    files.set(
      `.maple/previews/described-corrupt.dng.v${PIPELINE_OUTPUT_VERSION}.png`,
      new Uint8Array([0xff, 0xd8]),
    );

    expect(await svc.readPreview(folder(), '', 'described-corrupt.dng', source)).toBeNull();
  });

  it('readPreview returns null when nothing is cached', async () => {
    expect(
      await svc.readPreview(folder(), '2024', 'missing.dng', { size: 1, lastModified: 1 }),
    ).toBeNull();
  });

  it('readPreview refuses cached bytes that are not AVIF', async () => {
    files.set(
      `2024/.maple/previews/a.dng.v${PIPELINE_OUTPUT_VERSION}.avif`,
      new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    );
    expect(
      await svc.readPreview(folder(), '2024', 'a.dng', { size: 1, lastModified: 1 }),
    ).toBeNull();
  });

  it('readPreview accepts mif1 containers with an AVIF compatible brand', async () => {
    files.set(
      `2024/.maple/previews/a.dng.v${PIPELINE_OUTPUT_VERSION}.avif`,
      new Uint8Array([
        0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x69, 0x66, 0x31, 0, 0, 0, 0, 0x61, 0x76, 0x69,
        0x66,
      ]),
    );
    modified.set(`2024/.maple/previews/a.dng.v${PIPELINE_OUTPUT_VERSION}.avif`, 2);
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
    const previewPath = `.maple/previews/corrupt.dng.v${PIPELINE_OUTPUT_VERSION}.avif`;
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
    const previewPath = `.maple/previews/corrupt-descriptor.dng.v${PIPELINE_OUTPUT_VERSION}.avif`;
    files.set(
      previewPath,
      new Uint8Array([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]),
    );
    files.set(
      `.maple/previews/corrupt-descriptor.dng.v${PIPELINE_OUTPUT_VERSION}.preview.json`,
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
      `.maple/previews/prototype.dng.v${PIPELINE_OUTPUT_VERSION}.preview.json`,
      new TextEncoder().encode(JSON.stringify({ version: 1, format: 'toString', source })),
    );
    expect(await svc.readPreview(folder(), '', 'prototype.dng', source)).toBeNull();
  });

  it('keeps a legacy AVIF without a descriptor readable', async () => {
    const previewPath = `.maple/previews/legacy.dng.v${PIPELINE_OUTPUT_VERSION}.avif`;
    files.set(
      previewPath,
      new Uint8Array([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]),
    );
    modified.set(previewPath, 2_000);
    expect(
      (await svc.readPreview(folder(), '', 'legacy.dng', { size: 10, lastModified: 1_000 }))?.type,
    ).toBe('image/avif');
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
    expect(files.has(`.maple/previews/IMG.CR2.v${PIPELINE_OUTPUT_VERSION}.avif`)).toBe(true);
    expect(files.has(`.maple/previews/IMG.v${PIPELINE_OUTPUT_VERSION}.avif`)).toBe(false);
  });
});
