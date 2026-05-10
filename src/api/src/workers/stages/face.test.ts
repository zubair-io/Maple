import { afterEach, describe, it, expect } from "bun:test";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { ObjectId } from "mongodb";
import type { ImageDoc, StageContext } from "../runtime/define-stage.ts";
import type { AssetFaceDoc } from "../../db/schema.ts";
import type { DetectedFace, FaceDetector } from "../../enrichment/face-detector.ts";
import { setDefaultFaceDetectorForTests } from "../../enrichment/face-detector.ts";
import { cachePathFor } from "../../fs/xmp.ts";

// Import after module is created.
import { faceHandler, THUMB_MISSING_REASON } from "./face.ts";

const noopCtx: StageContext = {
  log: { info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {}, child: () => noopCtx.log } as never,
  signal: new AbortController().signal,
};

afterEach(() => {
  setDefaultFaceDetectorForTests(null);
});

function fakeDoc(overrides: Partial<ImageDoc> & { abs_path: string }): ImageDoc {
  return {
    _id: new ObjectId(),
    folder_id: new ObjectId(),
    filename: "test.dng",
    size: 1,
    mtime: 1,
    rating: 0,
    flag: 0,
    color_label: "",
    indexed_at: new Date().toISOString(),
    exif: {
      captured_at: "2024-06-01T12:00:00.000Z",
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
    stages: {} as Record<string, import("../runtime/define-stage.ts").StageState>,
    ...overrides,
  } as ImageDoc;
}

function fakeDetection(): DetectedFace {
  return {
    bbox: { x: 0.1, y: 0.1, w: 0.4, h: 0.5 },
    confidence: 0.95,
    landmarks: [
      { x: 0.2, y: 0.2 }, { x: 0.4, y: 0.2 }, { x: 0.3, y: 0.3 },
      { x: 0.22, y: 0.4 }, { x: 0.38, y: 0.4 },
    ],
  };
}

function mockDetector(detections: DetectedFace[], embedErr?: Error): FaceDetector {
  return {
    detectFaces: async () => detections,
    embedFace: async () => {
      if (embedErr) throw embedErr;
      return new Float32Array([0.1, 0.2, 0.3, 0.4]);
    },
  };
}

let tmpRoot: string;
function setup(): string {
  tmpRoot = mkdtempSync(join(tmpdir(), "maple-face-stage-"));
  return tmpRoot;
}
function teardown() { rmSync(tmpRoot, { recursive: true, force: true }); }

describe("faceHandler — happy path", () => {
  it("detects faces and returns patch with faces array", async () => {
    const root = setup();
    try {
      const absPath = join(root, "img.dng");
      const thumbPath = cachePathFor(absPath, "thumbs");
      mkdirSync(dirname(thumbPath), { recursive: true });
      writeFileSync(thumbPath, "stub-jpeg");
      const doc = fakeDoc({ abs_path: absPath });
      setDefaultFaceDetectorForTests(mockDetector([fakeDetection()]));
      const result = await faceHandler(doc, noopCtx);
      expect(result).toHaveProperty("patch");
      expect((result as { patch: { faces: unknown[] } }).patch.faces).toHaveLength(1);
      const face = (result as { patch: { faces: AssetFaceDoc[] } }).patch.faces[0]!;
      expect(face.confidence).toBeCloseTo(0.95);
      expect(face.bbox.x).toBeCloseTo(0.1);
      expect(face.person_id).toBeNull();
      expect(face.embedding).toEqual([
        expect.closeTo(0.1, 5), expect.closeTo(0.2, 5),
        expect.closeTo(0.3, 5), expect.closeTo(0.4, 5),
      ] as never);
    } finally { teardown(); }
  });

  it("returns empty faces array when no detections", async () => {
    const root = setup();
    try {
      const absPath = join(root, "img.dng");
      const thumbPath = cachePathFor(absPath, "thumbs");
      mkdirSync(dirname(thumbPath), { recursive: true });
      writeFileSync(thumbPath, "stub-jpeg");
      const doc = fakeDoc({ abs_path: absPath });
      setDefaultFaceDetectorForTests(mockDetector([]));
      const result = await faceHandler(doc, noopCtx);
      expect((result as { patch: { faces: unknown[] } }).patch.faces).toEqual([]);
    } finally { teardown(); }
  });
});

describe("faceHandler — thumb missing", () => {
  it("returns { skip } with THUMB_MISSING_REASON when thumb is absent", async () => {
    const root = setup();
    try {
      const absPath = join(root, "noThumb.dng");
      const doc = fakeDoc({ abs_path: absPath });
      setDefaultFaceDetectorForTests(mockDetector([]));
      const result = await faceHandler(doc, noopCtx);
      expect(result).toHaveProperty("skip");
      expect((result as { skip: string }).skip).toContain(THUMB_MISSING_REASON);
    } finally { teardown(); }
  });
});
