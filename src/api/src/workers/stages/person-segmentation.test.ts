import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import personSegmentationStage, {
  personSegmentationHandler,
  PERSON_SEGMENTATION_TARGET_VERSION,
} from './person-segmentation.ts';
import {
  setPersonSegmenterForTests,
  type PersonSegmenter,
  type PersonSegmentationResult,
  PERSON_SEGMENTATION_MODEL_ID,
} from '../../enrichment/subject-masks/person-segmenter.ts';
import {
  readRasterPng,
  setSubjectMaskCacheDirForTests,
} from '../../enrichment/subject-masks/subject-mask-cache.ts';
import { subjectMaskDigest } from '../../enrichment/subject-masks/subject-mask-digest.ts';
import { ObjectId, newObjectIdHex } from '../../db/object-id.ts';
import type { ImageDoc, StageContext } from '../run-stage.ts';
import { cachePathForAsset } from '../../fs/xmp.ts';
import { PREVIEW_CACHE_SUFFIX } from '../../indexer/previewer.ts';
import { setLibraryRootsForTests } from '../../indexer/libraries.cache.ts';
import { solidJpeg } from '../../test-support/synth-image.ts';
import pino from 'pino';

describe('person-segmentation stage', () => {
  let tmpCacheDir: string;
  let tmpLibDir: string;
  const dummyCtx: StageContext = {
    log: pino({ level: 'silent' }),
    signal: new AbortController().signal,
  };

  beforeEach(async () => {
    tmpCacheDir = await mkdtemp(join(tmpdir(), 'person-seg-cache-test-'));
    tmpLibDir = await mkdtemp(join(tmpdir(), 'person-seg-lib-test-'));
    setSubjectMaskCacheDirForTests(tmpCacheDir);
  });

  afterEach(async () => {
    setPersonSegmenterForTests(null);
    setSubjectMaskCacheDirForTests(null);
    setLibraryRootsForTests(null);
    try {
      await rm(tmpCacheDir, { recursive: true, force: true });
      await rm(tmpLibDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  async function stagePreview(doc: ImageDoc, libraryId: ObjectId): Promise<string> {
    const libs = new Map([[libraryId.toHexString(), tmpLibDir]]);
    setLibraryRootsForTests(libs);
    const previewPath = cachePathForAsset(doc as never, libs, 'previews', PREVIEW_CACHE_SUFFIX);
    if (!previewPath) throw new Error('Failed to resolve preview path');
    await mkdir(dirname(previewPath), { recursive: true });
    await writeFile(previewPath, await solidJpeg(32, 24, [100, 100, 100]));
    return previewPath;
  }

  it('exposes correct stage configuration', () => {
    expect(personSegmentationStage.name).toBe('person-segmentation');
    expect(personSegmentationStage.targetVersion).toBe(PERSON_SEGMENTATION_TARGET_VERSION);
    expect(personSegmentationStage.defaults.pausedOnFirstBoot).toBe(true);
    expect(personSegmentationStage.defaults.concurrency).toBe(1);
    expect(personSegmentationStage.defaults.maxAttempts).toBe(5);
  });

  it('skips undecodable stub files', async () => {
    const doc: ImageDoc = {
      _id: new ObjectId(),
      fileinfo: [{ path: '', filename: 'test.afphoto', library_id: newObjectIdHex() }],
      size: 100,
      mtime: 100,
      indexed_at: '2026-01-01',
    };
    const res = await personSegmentationHandler(doc, dummyCtx);
    expect(res).toEqual({ skip: 'stub-file' });
  });

  it('skips video files', async () => {
    const doc: ImageDoc = {
      _id: new ObjectId(),
      fileinfo: [{ path: '', filename: 'clip.mp4', library_id: newObjectIdHex() }],
      size: 100,
      mtime: 100,
      indexed_at: '2026-01-01',
    };
    const res = await personSegmentationHandler(doc, dummyCtx);
    expect(res).toEqual({ skip: 'video-unsupported' });
  });

  it('handles empty segmentation (nobody detected)', async () => {
    const mockSegmenter: PersonSegmenter = {
      async segment(_bytes: Uint8Array): Promise<PersonSegmentationResult> {
        return {
          model: PERSON_SEGMENTATION_MODEL_ID,
          persons: [],
        };
      },
    };
    setPersonSegmenterForTests(mockSegmenter);

    const assetId = new ObjectId();
    const libId = new ObjectId();
    const doc: ImageDoc = {
      _id: assetId,
      fileinfo: [{ path: '', filename: 'landscape.jpg', library_id: libId }],
      size: 100,
      mtime: 100,
      indexed_at: '2026-01-01',
    };
    await stagePreview(doc, libId);

    const res = await personSegmentationHandler(doc, dummyCtx);
    expect('patch' in res).toBe(true);
    if ('patch' in res) {
      expect(res.patch).toHaveLength(1);
      const stmt = res.patch[0];
      expect(stmt.params[0]).toBe(assetId.toHexString());
      expect(stmt.params[1]).toBe(PERSON_SEGMENTATION_MODEL_ID);
      expect(JSON.parse(stmt.params[2] as string)).toEqual([]);
    }
  });

  it('segments detected person, generates raster PNG and computes digest', async () => {
    // 4x4 test mask raster
    const maskData = new Uint8Array([
      255, 255, 0, 0, 255, 255, 0, 0, 0, 0, 128, 128, 0, 0, 128, 128,
    ]);

    const mockSegmenter: PersonSegmenter = {
      async segment(_bytes: Uint8Array): Promise<PersonSegmentationResult> {
        return {
          model: PERSON_SEGMENTATION_MODEL_ID,
          persons: [
            {
              person: 0,
              bbox: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
              maskRaster: {
                width: 4,
                height: 4,
                data: maskData,
              },
            },
          ],
        };
      },
    };
    setPersonSegmenterForTests(mockSegmenter);

    const assetId = new ObjectId();
    const libId = new ObjectId();
    const doc: ImageDoc = {
      _id: assetId,
      fileinfo: [{ path: '', filename: 'portrait.jpg', library_id: libId }],
      size: 100,
      mtime: 100,
      indexed_at: '2026-01-01',
    };
    await stagePreview(doc, libId);

    const res = await personSegmentationHandler(doc, dummyCtx);
    expect('patch' in res).toBe(true);
    if ('patch' in res) {
      expect(res.patch).toHaveLength(1);
      const stmt = res.patch[0];
      expect(stmt.params[0]).toBe(assetId.toHexString());
      expect(stmt.params[1]).toBe(PERSON_SEGMENTATION_MODEL_ID);
      const parsedPersons = JSON.parse(stmt.params[2] as string);
      expect(parsedPersons).toEqual([
        {
          person: 0,
          bbox: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
        },
      ]);
    }

    // Verify raster PNG was written by digest
    const expectedDigest = subjectMaskDigest(
      assetId.toHexString(),
      0,
      true,
      true,
      PERSON_SEGMENTATION_MODEL_ID,
    );
    const cachedBytes = await readRasterPng(expectedDigest);
    expect(cachedBytes).not.toBeNull();
    // Check PNG signature [0x89, 0x50, 0x4E, 0x47]
    expect(cachedBytes![0]).toBe(0x89);
    expect(cachedBytes![1]).toBe(0x50);
    expect(cachedBytes![2]).toBe(0x4e);
    expect(cachedBytes![3]).toBe(0x47);
  });
});
