import { afterEach, describe, it, expect } from 'bun:test';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { ObjectId } from 'mongodb';
import type { ImageDoc, StageContext, StageState } from '../run-stage.ts';
import type { AssetFaceDoc } from '../../db/schema.ts';
import type { DetectedFace, FaceDetector } from '../../enrichment/face-detector.ts';
import {
  setDefaultFaceDetectorForTests,
  ThumbDecodeError,
} from '../../enrichment/face-detector.ts';
import { setLibraryRootsForTests } from '../../indexer/libraries.cache.ts';
import { resolveThumbPathForAsset } from '../../fs/xmp.ts';

import {
  faceDetectHandler,
  THUMB_MISSING_REASON,
  THUMB_UNDECODABLE_REASON,
} from './face-detect.ts';

const noopCtx: StageContext = {
  log: {
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    fatal() {},
    child: () => noopCtx.log,
  } as never,
  signal: new AbortController().signal,
};

afterEach(() => {
  setDefaultFaceDetectorForTests(null);
  setLibraryRootsForTests(null);
});

function fakeDoc(
  overrides: { absPath: string; libraryId: ObjectId; mapleId?: string } & Partial<ImageDoc>,
): ImageDoc {
  const { absPath, libraryId, mapleId, ...rest } = overrides;
  const filename = absPath.split('/').pop()!;
  return {
    _id: new ObjectId(),
    maple_id: mapleId ?? 'face-test-' + Math.random().toString(36).slice(2),
    fileinfo: [
      {
        path: '',
        filename,
        library_id: libraryId,
        deleted_at: null,
      },
    ],
    size: 1,
    mtime: 1,
    rating: 0,
    flag: 0,
    color_label: '',
    indexed_at: new Date().toISOString(),
    exif: {
      captured_at: '2024-06-01T12:00:00.000Z',
      captured_year: 2024,
      captured_month: 6,
      camera_make: null,
      camera_model: null,
      lens: null,
      iso: null,
      aperture: null,
      shutter: null,
      focal_length: null,
      gps: null,
    },
    faces: [],
    description: null,
    place: null,
    stages: {} as Record<string, StageState>,
    ...rest,
  } as unknown as ImageDoc;
}

function fakeDetection(): DetectedFace {
  return {
    bbox: { x: 0.1, y: 0.1, w: 0.4, h: 0.5 },
    confidence: 0.95,
    landmarks: [
      { x: 0.2, y: 0.2 },
      { x: 0.4, y: 0.2 },
      { x: 0.3, y: 0.3 },
      { x: 0.22, y: 0.4 },
      { x: 0.38, y: 0.4 },
    ],
  };
}

function mockDetector(detections: DetectedFace[], detectErr?: Error): FaceDetector {
  return {
    detectFaces: async () => {
      if (detectErr) throw detectErr;
      return detections;
    },
    // face-detect must NOT call embedFace — fail loudly if it does.
    embedFace: async () => {
      throw new Error('face-detect must not call embedFace');
    },
  };
}

let tmpRoot: string;
function setup(): { root: string; libraryId: ObjectId } {
  tmpRoot = mkdtempSync(join(tmpdir(), 'maple-face-detect-'));
  const libraryId = new ObjectId();
  setLibraryRootsForTests(new Map([[libraryId.toHexString(), tmpRoot]]));
  return { root: tmpRoot, libraryId };
}
function teardown() {
  rmSync(tmpRoot, { recursive: true, force: true });
  setLibraryRootsForTests(null);
}

function stageAsset(
  root: string,
  libraryId: ObjectId,
  filename: string,
): { absPath: string; doc: ImageDoc; thumbPath: string } {
  const absPath = join(root, filename);
  const doc = fakeDoc({ absPath, libraryId });
  const thumbPath = resolveThumbPathForAsset(
    doc as never,
    new Map([[libraryId.toHexString(), root]]),
  );
  if (!thumbPath) throw new Error('test setup: resolveThumbPathForAsset returned null');
  return { absPath, doc, thumbPath };
}

describe('faceDetectHandler — happy path', () => {
  it('detects faces and returns patch with bbox + landmarks, no embedding', async () => {
    const { root, libraryId } = setup();
    try {
      const { doc, thumbPath } = stageAsset(root, libraryId, 'img.dng');
      mkdirSync(dirname(thumbPath), { recursive: true });
      writeFileSync(thumbPath, 'stub-jpeg');
      setDefaultFaceDetectorForTests(mockDetector([fakeDetection()]));
      const result = await faceDetectHandler(doc, noopCtx);
      expect(result).toHaveProperty('patch');
      const faces = (result as { patch: { faces: AssetFaceDoc[] } }).patch.faces;
      expect(faces).toHaveLength(1);
      const face = faces[0]!;
      expect(face.confidence).toBeCloseTo(0.95);
      expect(face.bbox.x).toBeCloseTo(0.1);
      expect(face.person_id).toBeNull();
      expect(face.hidden).toBe(false);
      // Landmarks persisted so face-embed can align without re-detecting.
      expect(face.landmarks).toHaveLength(5);
      expect(face.landmarks![0]!.x).toBeCloseTo(0.2);
      // Detection stage does NOT embed.
      expect(face.embedding).toBeUndefined();
      expect(face.embedding_version).toBeUndefined();
    } finally {
      teardown();
    }
  });

  it('returns empty faces array when no detections', async () => {
    const { root, libraryId } = setup();
    try {
      const { doc, thumbPath } = stageAsset(root, libraryId, 'img.dng');
      mkdirSync(dirname(thumbPath), { recursive: true });
      writeFileSync(thumbPath, 'stub-jpeg');
      setDefaultFaceDetectorForTests(mockDetector([]));
      const result = await faceDetectHandler(doc, noopCtx);
      expect((result as { patch: { faces: unknown[] } }).patch.faces).toEqual([]);
    } finally {
      teardown();
    }
  });
});

describe('faceDetectHandler — video files', () => {
  it('skips a video asset as { skip: stub-file } even when a thumb exists, without invoking the detector', async () => {
    const { root, libraryId } = setup();
    try {
      // A cached "thumb" exists, but for a .MOV/.mp4 the thumb/preview
      // last-resort path copies the source bytes verbatim — so it's the raw
      // video container, not a JPEG. Handing those bytes to the face pool throws
      // "The object can not be cloned" on the IPC postMessage, which dead-letters
      // after maxAttempts. Skip videos terminally, mirroring describe/preview/exif.
      const { doc, thumbPath } = stageAsset(root, libraryId, 'IMG_4661.MOV');
      mkdirSync(dirname(thumbPath), { recursive: true });
      writeFileSync(thumbPath, 'raw-mov-bytes');
      setDefaultFaceDetectorForTests(
        mockDetector([], new Error('detector must not run on a video asset')),
      );
      const result = await faceDetectHandler(doc, noopCtx);
      expect((result as { skip: string }).skip).toBe('stub-file');
    } finally {
      teardown();
    }
  });
});

describe('faceDetectHandler — metadata-only stub images and audio (#1835)', () => {
  it.each([
    'scan.eip',
    'session.braw',
    'project.afphoto',
    'logo.ai',
    'track.mp3',
    'voice.wav',
    'memo.m4a',
    'song.aac',
  ])('skips %s as { skip: stub-file } without invoking the detector', async (filename) => {
    const { root, libraryId } = setup();
    try {
      const { doc, thumbPath } = stageAsset(root, libraryId, filename);
      mkdirSync(dirname(thumbPath), { recursive: true });
      writeFileSync(thumbPath, 'not-a-real-thumb');
      setDefaultFaceDetectorForTests(
        mockDetector([], new Error('detector must not run on a stub/audio asset')),
      );
      const result = await faceDetectHandler(doc, noopCtx);
      expect((result as { skip: string }).skip).toBe('stub-file');
    } finally {
      teardown();
    }
  });
});

describe('faceDetectHandler — thumb missing', () => {
  it('returns { skip } with THUMB_MISSING_REASON when thumb is absent', async () => {
    const { root, libraryId } = setup();
    try {
      const { doc } = stageAsset(root, libraryId, 'noThumb.dng');
      setDefaultFaceDetectorForTests(mockDetector([]));
      const result = await faceDetectHandler(doc, noopCtx);
      expect(result).toHaveProperty('skip');
      expect((result as { skip: string }).skip).toContain(THUMB_MISSING_REASON);
    } finally {
      teardown();
    }
  });
});

describe('faceDetectHandler — thumb undecodable', () => {
  it('returns { skip } with THUMB_UNDECODABLE_REASON when detector throws ThumbDecodeError', async () => {
    const { root, libraryId } = setup();
    try {
      const { doc, thumbPath } = stageAsset(root, libraryId, 'corrupt.jpg');
      mkdirSync(dirname(thumbPath), { recursive: true });
      writeFileSync(thumbPath, 'garbage-bytes');
      setDefaultFaceDetectorForTests(
        mockDetector(
          [],
          new ThumbDecodeError('VipsJpeg: Invalid SOS parameters for sequential JPEG'),
        ),
      );
      const result = await faceDetectHandler(doc, noopCtx);
      expect(result).toHaveProperty('skip');
      const skip = (result as { skip: string }).skip;
      expect(skip).toContain(THUMB_UNDECODABLE_REASON);
      expect(skip).toContain('VipsJpeg');
    } finally {
      teardown();
    }
  });
});

// The handler reads face_min_detection_size from the DB at run time; when no
// DB is configured (as in this test suite), loadEnrichmentConfig() returns null
// and the resolver falls back to DEFAULT_FACE_MIN_DETECTION_SIZE (0.06).
// Large faces (w/h ≥ 0.06) survive; tiny faces (w/h < 0.06) are dropped.
describe('faceDetectHandler — minimum face size filter', () => {
  function tinyDetection(): DetectedFace {
    // Both w and h are well below the default threshold of 0.06.
    return {
      bbox: { x: 0.5, y: 0.5, w: 0.02, h: 0.02 },
      confidence: 0.9,
      landmarks: [
        { x: 0.51, y: 0.51 },
        { x: 0.53, y: 0.51 },
        { x: 0.52, y: 0.52 },
        { x: 0.51, y: 0.53 },
        { x: 0.53, y: 0.53 },
      ],
    };
  }

  it('keeps faces that meet or exceed the default threshold', async () => {
    const { root, libraryId } = setup();
    try {
      const { doc, thumbPath } = stageAsset(root, libraryId, 'big.dng');
      mkdirSync(dirname(thumbPath), { recursive: true });
      writeFileSync(thumbPath, 'stub-jpeg');
      setDefaultFaceDetectorForTests(mockDetector([fakeDetection()]));
      const result = await faceDetectHandler(doc, noopCtx);
      const faces = (result as { patch: { faces: AssetFaceDoc[] } }).patch.faces;
      // fakeDetection() has w=0.4, h=0.5 — both ≥ 0.06.
      expect(faces).toHaveLength(1);
    } finally {
      teardown();
    }
  });

  it('drops faces smaller than the default threshold (0.06)', async () => {
    const { root, libraryId } = setup();
    try {
      const { doc, thumbPath } = stageAsset(root, libraryId, 'tiny-face.dng');
      mkdirSync(dirname(thumbPath), { recursive: true });
      writeFileSync(thumbPath, 'stub-jpeg');
      // Mix: one tiny face (should be dropped) + one normal face (kept).
      setDefaultFaceDetectorForTests(mockDetector([tinyDetection(), fakeDetection()]));
      const result = await faceDetectHandler(doc, noopCtx);
      const faces = (result as { patch: { faces: AssetFaceDoc[] } }).patch.faces;
      // Only the normal detection survives.
      expect(faces).toHaveLength(1);
      expect(faces[0]!.bbox.w).toBeCloseTo(0.4);
    } finally {
      teardown();
    }
  });

  it('returns empty faces when all detections are below the threshold', async () => {
    const { root, libraryId } = setup();
    try {
      const { doc, thumbPath } = stageAsset(root, libraryId, 'all-tiny.dng');
      mkdirSync(dirname(thumbPath), { recursive: true });
      writeFileSync(thumbPath, 'stub-jpeg');
      setDefaultFaceDetectorForTests(mockDetector([tinyDetection(), tinyDetection()]));
      const result = await faceDetectHandler(doc, noopCtx);
      const faces = (result as { patch: { faces: AssetFaceDoc[] } }).patch.faces;
      expect(faces).toHaveLength(0);
    } finally {
      teardown();
    }
  });
});
