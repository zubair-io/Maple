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
    new Blob([new Uint8Array([0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70])], {
      type: 'image/avif',
    });
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
    files.set(AVIF, new Uint8Array([0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70]));
    files.set(AVIF_MARKER, new TextEncoder().encode(String(THUMB_PIPELINE_VERSION - 1)));
    const blob = await svc.readThumb(folder(), SHA);
    // Stale avif must NOT fall through to the co-present jpg and must not be
    // served — the caller re-decodes.
    expect(blob).toBeNull();
  });
});

describe('MapleCacheService — embedded-preview cache (#2010)', () => {
  let svc: MapleCacheService;
  let files: Map<string, Uint8Array>;

  const MAPLE_ID = 'a1b2c3d4e5f60000000000000000000';
  const PREVIEW_PATH = `.maple/previews/${MAPLE_ID}.jpg`;

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

  it('readPreview returns null on a cache miss', async () => {
    const blob = await svc.readPreview(folder(), MAPLE_ID);
    expect(blob).toBeNull();
  });

  it('writePreview then readPreview round-trips the exact bytes as an image/jpeg Blob', async () => {
    const jpegBytes = new Uint8Array([0xff, 0xd8, 1, 2, 3, 4, 5, 0xff, 0xd9]);
    await svc.writePreview(folder(), MAPLE_ID, new Blob([jpegBytes], { type: 'image/jpeg' }));

    expect(files.has(PREVIEW_PATH)).toBe(true);
    // No `.v` pipeline-version marker for this tier — extraction is a pure
    // re-encode of the RAW's own embedded JPEG, independent of
    // PIPELINE_OUTPUT_VERSION (contrast the thumb `.v` marker above).
    expect(files.has(`${PREVIEW_PATH}.v`)).toBe(false);

    const blob = await svc.readPreview(folder(), MAPLE_ID);
    expect(blob).not.toBeNull();
    expect(blob!.type).toBe('image/jpeg');
    const roundTripped = new Uint8Array(await blob!.arrayBuffer());
    expect(Array.from(roundTripped)).toEqual(Array.from(jpegBytes));
  });

  it('writePreview silently skips a read-only folder', async () => {
    await svc.writePreview(
      folder(false),
      MAPLE_ID,
      new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }),
    );
    expect(files.has(PREVIEW_PATH)).toBe(false);
  });

  it('readPreview correctly slices a Uint8Array view that does not start at byte 0 of its buffer', async () => {
    // Regression guard for the fix that dropped the `bytes.buffer` copy-out
    // dance: passing a view's `.buffer` directly (instead of the view
    // itself) would have leaked whatever precedes byteOffset in the
    // underlying buffer. Simulate `readFile` handing back exactly that
    // shape — a Uint8Array subarray view, not a byte0-aligned array.
    const backing = new Uint8Array([0xaa, 0xbb, 0xff, 0xd8, 1, 2, 3, 0xff, 0xd9, 0xcc]);
    const view = backing.subarray(2, 9); // [0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]
    files.set(PREVIEW_PATH, view);

    const blob = await svc.readPreview(folder(), MAPLE_ID);
    const roundTripped = new Uint8Array(await blob!.arrayBuffer());
    expect(Array.from(roundTripped)).toEqual(Array.from(view));
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
