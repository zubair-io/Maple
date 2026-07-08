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

import { faceEmbedHandler, THUMB_MISSING_REASON, THUMB_UNDECODABLE_REASON } from './face-embed.ts';
import { CURRENT_EMBEDDING_VERSION } from '../../enrichment/face-models.ts';

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

function fakeFace(overrides: Partial<AssetFaceDoc> = {}): AssetFaceDoc {
  return {
    bbox: { x: 0.1, y: 0.1, w: 0.4, h: 0.5 },
    confidence: 0.95,
    person_id: null,
    hidden: false,
    landmarks: [
      { x: 0.2, y: 0.2 },
      { x: 0.4, y: 0.2 },
      { x: 0.3, y: 0.3 },
      { x: 0.22, y: 0.4 },
      { x: 0.38, y: 0.4 },
    ],
    ...overrides,
  };
}

function fakeDoc(
  overrides: {
    absPath: string;
    libraryId: ObjectId;
    faces: AssetFaceDoc[];
    mapleId?: string;
  } & Partial<ImageDoc>,
): ImageDoc {
  const { absPath, libraryId, mapleId, faces, ...rest } = overrides;
  const filename = absPath.split('/').pop()!;
  return {
    _id: new ObjectId(),
    maple_id: mapleId ?? 'face-embed-test-' + Math.random().toString(36).slice(2),
    fileinfo: [{ path: '', filename, library_id: libraryId, deleted_at: null }],
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
    faces,
    description: null,
    place: null,
    stages: {} as Record<string, StageState>,
    ...rest,
  } as unknown as ImageDoc;
}

/** Records every DetectedFace passed to embedFace so tests can assert the
 * stored bbox + landmarks were forwarded (not re-detected). */
function recordingDetector(embedErr?: Error): FaceDetector & { embedded: DetectedFace[] } {
  const embedded: DetectedFace[] = [];
  return {
    embedded,
    // face-embed must NOT re-detect — fail loudly if it does.
    detectFaces: async () => {
      throw new Error('face-embed must not call detectFaces');
    },
    embedFace: async (_bytes, det) => {
      embedded.push(det);
      if (embedErr) throw embedErr;
      return new Float32Array([0.1, 0.2, 0.3, 0.4]);
    },
  };
}

let tmpRoot: string;
function setup(): { root: string; libraryId: ObjectId } {
  tmpRoot = mkdtempSync(join(tmpdir(), 'maple-face-embed-'));
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
  faces: AssetFaceDoc[],
): { doc: ImageDoc; thumbPath: string } {
  const absPath = join(root, filename);
  const doc = fakeDoc({ absPath, libraryId, faces });
  const thumbPath = resolveThumbPathForAsset(
    doc as never,
    new Map([[libraryId.toHexString(), root]]),
  );
  if (!thumbPath) throw new Error('test setup: resolveThumbPathForAsset returned null');
  return { doc, thumbPath };
}

describe('faceEmbedHandler — video files', () => {
  it('skips a video asset as { skip: stub-file } without invoking the recognizer', async () => {
    const { root, libraryId } = setup();
    try {
      // Shared loadThumbBytes guard: a .mov/.mp4 thumb is the raw video
      // container (last-resort passthrough), which can't be cloned across the
      // face-pool IPC. Skip terminally rather than dead-letter after retries.
      const { doc, thumbPath } = stageAsset(root, libraryId, 'clip.mp4', [fakeFace()]);
      mkdirSync(dirname(thumbPath), { recursive: true });
      writeFileSync(thumbPath, 'raw-mp4-bytes');
      const detector = recordingDetector(new Error('recognizer must not run on a video asset'));
      setDefaultFaceDetectorForTests(detector);
      const result = await faceEmbedHandler(doc, noopCtx);
      expect((result as { skip: string }).skip).toBe('stub-file');
      expect(detector.embedded).toHaveLength(0);
    } finally {
      teardown();
    }
  });
});

describe('faceEmbedHandler — metadata-only stub images and audio (#1835)', () => {
  it.each([
    'scan.eip',
    'session.braw',
    'project.afphoto',
    'logo.ai',
    'track.mp3',
    'voice.wav',
    'memo.m4a',
    'song.aac',
  ])('skips %s as { skip: stub-file } without invoking the recognizer', async (filename) => {
    const { root, libraryId } = setup();
    try {
      const { doc, thumbPath } = stageAsset(root, libraryId, filename, [fakeFace()]);
      mkdirSync(dirname(thumbPath), { recursive: true });
      writeFileSync(thumbPath, 'not-a-real-thumb');
      const detector = recordingDetector(
        new Error('recognizer must not run on a stub/audio asset'),
      );
      setDefaultFaceDetectorForTests(detector);
      const result = await faceEmbedHandler(doc, noopCtx);
      expect((result as { skip: string }).skip).toBe('stub-file');
      expect(detector.embedded).toHaveLength(0);
    } finally {
      teardown();
    }
  });
});

describe('faceEmbedHandler — happy path', () => {
  it('embeds each detected face in place via per-index patch keys', async () => {
    const { root, libraryId } = setup();
    try {
      const { doc, thumbPath } = stageAsset(root, libraryId, 'img.dng', [
        fakeFace(),
        fakeFace({ bbox: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 } }),
      ]);
      mkdirSync(dirname(thumbPath), { recursive: true });
      writeFileSync(thumbPath, 'stub-jpeg');
      const detector = recordingDetector();
      setDefaultFaceDetectorForTests(detector);
      const result = await faceEmbedHandler(doc, noopCtx);
      expect(result).toHaveProperty('patch');
      const patch = (result as { patch: Record<string, unknown> }).patch;
      // Per-index embedding + version keys only — never the whole faces array.
      expect(patch['faces.0.embedding']).toEqual([
        expect.closeTo(0.1, 5),
        expect.closeTo(0.2, 5),
        expect.closeTo(0.3, 5),
        expect.closeTo(0.4, 5),
      ] as never);
      expect(patch['faces.0.embedding_version']).toBe(CURRENT_EMBEDDING_VERSION);
      expect(patch['faces.1.embedding_version']).toBe(CURRENT_EMBEDDING_VERSION);
      // Must not rewrite bbox / person_id / landmarks.
      expect(Object.keys(patch)).toEqual([
        'faces.0.embedding',
        'faces.0.embedding_version',
        'faces.1.embedding',
        'faces.1.embedding_version',
      ]);
      // The stored bbox + landmarks were forwarded to the recognizer, not
      // re-detected.
      expect(detector.embedded).toHaveLength(2);
      expect(detector.embedded[0]!.landmarks).toHaveLength(5);
      expect(detector.embedded[0]!.landmarks[0]!.x).toBeCloseTo(0.2);
      expect(detector.embedded[1]!.bbox.x).toBeCloseTo(0.5);
    } finally {
      teardown();
    }
  });

  it('forwards an empty landmark set for legacy faces (no landmarks stored)', async () => {
    const { root, libraryId } = setup();
    try {
      const legacy = fakeFace();
      delete legacy.landmarks;
      const { doc, thumbPath } = stageAsset(root, libraryId, 'legacy.dng', [legacy]);
      mkdirSync(dirname(thumbPath), { recursive: true });
      writeFileSync(thumbPath, 'stub-jpeg');
      const detector = recordingDetector();
      setDefaultFaceDetectorForTests(detector);
      const result = await faceEmbedHandler(doc, noopCtx);
      expect(result).toHaveProperty('patch');
      expect(detector.embedded[0]!.landmarks).toEqual([]);
    } finally {
      teardown();
    }
  });

  it('returns { wrote: true } when the asset has no detected faces', async () => {
    const { root, libraryId } = setup();
    try {
      const { doc } = stageAsset(root, libraryId, 'noFaces.dng', []);
      // No thumb staged on purpose — a faceless asset must short-circuit
      // before touching disk.
      setDefaultFaceDetectorForTests(recordingDetector());
      const result = await faceEmbedHandler(doc, noopCtx);
      expect(result).toEqual({ wrote: true });
    } finally {
      teardown();
    }
  });
});

describe('faceEmbedHandler — thumb missing', () => {
  it('returns { skip } with THUMB_MISSING_REASON when thumb is absent', async () => {
    const { root, libraryId } = setup();
    try {
      const { doc } = stageAsset(root, libraryId, 'noThumb.dng', [fakeFace()]);
      setDefaultFaceDetectorForTests(recordingDetector());
      const result = await faceEmbedHandler(doc, noopCtx);
      expect(result).toHaveProperty('skip');
      expect((result as { skip: string }).skip).toContain(THUMB_MISSING_REASON);
    } finally {
      teardown();
    }
  });
});

describe('faceEmbedHandler — thumb undecodable', () => {
  it('returns { skip } when embedFace throws ThumbDecodeError', async () => {
    const { root, libraryId } = setup();
    try {
      const { doc, thumbPath } = stageAsset(root, libraryId, 'corrupt.jpg', [fakeFace()]);
      mkdirSync(dirname(thumbPath), { recursive: true });
      writeFileSync(thumbPath, 'garbage-bytes');
      setDefaultFaceDetectorForTests(
        recordingDetector(new ThumbDecodeError('VipsJpeg: late decode failure')),
      );
      const result = await faceEmbedHandler(doc, noopCtx);
      expect(result).toHaveProperty('skip');
      expect((result as { skip: string }).skip).toContain(THUMB_UNDECODABLE_REASON);
    } finally {
      teardown();
    }
  });
});
