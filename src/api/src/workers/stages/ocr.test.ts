import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { ObjectId } from "mongodb";
import type { ImageDoc, StageContext } from "../runtime/define-stage.ts";
import type { OcrEngine, RecognitionResult } from "../../enrichment/ocr-engine.ts";
import { setOcrEngineForTests } from "../../enrichment/ocr-engine.ts";
import { cachePathFor } from "../../fs/xmp.ts";

import { ocrHandler } from "./ocr.ts";

const noopCtx: StageContext = {
  log: { info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {}, child: () => noopCtx.log } as never,
  signal: new AbortController().signal,
};

function fakeDoc(absPath: string): ImageDoc {
  return {
    _id: new ObjectId(),
    folder_id: new ObjectId(),
    filename: "test.dng",
    abs_path: absPath,
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
      camera_make: null, camera_model: null, lens: null,
      iso: null, aperture: null, shutter: null, focal_length: null, gps: null,
    },
    faces: [],
    description: null,
    place: null,
    stages: {},
  } as ImageDoc;
}

function fakeEngine(text: string): OcrEngine {
  return {
    async recognizeText(): Promise<RecognitionResult> {
      return { text, engine: "tesseract", engine_version: "tesseract@5.1" };
    },
    async shutdown(): Promise<void> {},
  };
}

function throwingEngine(err: Error): OcrEngine {
  return {
    async recognizeText(): Promise<RecognitionResult> { throw err; },
    async shutdown(): Promise<void> {},
  };
}

let tmpRoot: string;
beforeEach(() => { tmpRoot = mkdtempSync(join(tmpdir(), "maple-ocr-stage-")); });
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  setOcrEngineForTests(null);
});

function seedThumb(absPath: string): void {
  const thumbPath = cachePathFor(absPath, "thumbs");
  mkdirSync(dirname(thumbPath), { recursive: true });
  writeFileSync(thumbPath, Buffer.from([0xff, 0xd8, 0xff]));
}

describe("ocrHandler — happy path", () => {
  it("returns patch with ocr_text and ocr_meta", async () => {
    const absPath = join(tmpRoot, "img.dng");
    seedThumb(absPath);
    const doc = fakeDoc(absPath);
    setOcrEngineForTests(fakeEngine("Hello World"));
    const result = await ocrHandler(doc, noopCtx);
    const patch = (result as { patch: { ocr_text: string; ocr_meta: Record<string, string> } }).patch;
    expect(patch.ocr_text).toBe("Hello World");
    expect(patch.ocr_meta.engine).toBe("tesseract");
    expect(patch.ocr_meta.engine_version).toBe("tesseract@5.1");
    expect(typeof patch.ocr_meta.generated_at).toBe("string");
  });

  it("empty text is a valid result", async () => {
    const absPath = join(tmpRoot, "blank.dng");
    seedThumb(absPath);
    const doc = fakeDoc(absPath);
    setOcrEngineForTests(fakeEngine(""));
    const result = await ocrHandler(doc, noopCtx);
    expect((result as { patch: { ocr_text: string } }).patch.ocr_text).toBe("");
  });
});

describe("ocrHandler — missing thumb returns skip", () => {
  it("returns { skip } when thumb is absent (ENOENT is non-retryable)", async () => {
    const absPath = join(tmpRoot, "missing.dng");
    // No seedThumb — thumb file absent.
    const doc = fakeDoc(absPath);
    setOcrEngineForTests(fakeEngine("x"));
    const result = await ocrHandler(doc, noopCtx);
    expect(result).toHaveProperty("skip");
    expect((result as { skip: string }).skip).toMatch(/image-missing/i);
  });
});

describe("ocrHandler — engine error propagates", () => {
  it("throws when the engine throws (retryable up to maxAttempts)", async () => {
    const absPath = join(tmpRoot, "crash.dng");
    seedThumb(absPath);
    const doc = fakeDoc(absPath);
    setOcrEngineForTests(throwingEngine(new Error("tesseract crashed")));
    await expect(ocrHandler(doc, noopCtx)).rejects.toThrow("tesseract crashed");
  });
});
