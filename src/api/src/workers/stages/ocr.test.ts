import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { ObjectId } from "mongodb";
import type { ImageDoc, StageContext } from "../runtime/define-stage.ts";
import type {
  OcrEngine,
  RecognitionResult,
  RecognizedWord,
} from "../../enrichment/ocr-engine.ts";
import {
  OCR_ENGINE_VERSION,
  setOcrEngineForTests,
} from "../../enrichment/ocr-engine.ts";
import { cachePathFor } from "../../fs/xmp.ts";

import ocrStage, { ocrHandler } from "./ocr.ts";

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

interface FakeEngineOptions {
  text: string;
  mean_confidence?: number | null;
  words?: RecognizedWord[];
}

function fakeEngine(opts: FakeEngineOptions | string): OcrEngine {
  const config: FakeEngineOptions =
    typeof opts === "string" ? { text: opts } : opts;
  const mean_confidence =
    config.mean_confidence === undefined ? 88 : config.mean_confidence;
  const words = config.words ?? [];
  return {
    async recognizeText(): Promise<RecognitionResult> {
      return {
        text: config.text,
        engine: "tesseract",
        engine_version: OCR_ENGINE_VERSION,
        mean_confidence,
        words,
      };
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

interface OcrPatchShape {
  ocr_text: string;
  ocr_words: RecognizedWord[];
  ocr_meta: {
    engine: string;
    engine_version: string;
    generated_at: string;
    mean_confidence: number | null;
  };
}

function patchOf(result: unknown): OcrPatchShape {
  return (result as { patch: OcrPatchShape }).patch;
}

describe("ocrHandler — happy path", () => {
  it("returns patch with ocr_text, ocr_words, and ocr_meta", async () => {
    const absPath = join(tmpRoot, "img.dng");
    seedThumb(absPath);
    const doc = fakeDoc(absPath);
    setOcrEngineForTests(
      fakeEngine({
        text: "Hello World",
        mean_confidence: 85,
        words: [
          { text: "Hello", confidence: 90, bbox: { x: 0, y: 0, w: 30, h: 10 } },
          { text: "World", confidence: 80, bbox: { x: 35, y: 0, w: 30, h: 10 } },
        ],
      }),
    );
    const result = await ocrHandler(doc, noopCtx);
    const patch = patchOf(result);
    expect(patch.ocr_text).toBe("Hello World");
    expect(patch.ocr_words).toHaveLength(2);
    expect(patch.ocr_words[0].text).toBe("Hello");
    expect(patch.ocr_meta.engine).toBe("tesseract");
    expect(patch.ocr_meta.engine_version).toBe(OCR_ENGINE_VERSION);
    expect(patch.ocr_meta.mean_confidence).toBe(85);
    expect(typeof patch.ocr_meta.generated_at).toBe("string");
  });

  it("empty text is a valid result", async () => {
    const absPath = join(tmpRoot, "blank.dng");
    seedThumb(absPath);
    const doc = fakeDoc(absPath);
    setOcrEngineForTests(
      fakeEngine({ text: "", mean_confidence: null, words: [] }),
    );
    const result = await ocrHandler(doc, noopCtx);
    const patch = patchOf(result);
    expect(patch.ocr_text).toBe("");
    expect(patch.ocr_words).toEqual([]);
    expect(patch.ocr_meta.mean_confidence).toBeNull();
  });
});

describe("ocr stage definition", () => {
  it("targetVersion is at least 2 so pre-gate rows are re-OCR'd", () => {
    // v1 wrote raw `ocr_text` with no confidence filter. v2 added the
    // mean-confidence gate. Bumping forces existing rows to re-run so
    // their poisoned text gets blanked.
    expect(ocrStage.targetVersion).toBeGreaterThanOrEqual(2);
  });
});

describe("ocrHandler — confidence gate", () => {
  afterEach(() => {
    delete process.env.MAPLE_OCR_MIN_CONFIDENCE;
    delete process.env.MAPLE_OCR_WORD_CONFIDENCE_FLOOR;
  });

  it("blanks ocr_text when mean confidence is below the default threshold", async () => {
    const absPath = join(tmpRoot, "noisy.dng");
    seedThumb(absPath);
    const doc = fakeDoc(absPath);
    setOcrEngineForTests(
      fakeEngine({
        text: "G@RB4GE WORD5 H3R3",
        mean_confidence: 25, // well below default 60
        words: [
          { text: "G@RB4GE", confidence: 20, bbox: { x: 0, y: 0, w: 30, h: 10 } },
        ],
      }),
    );
    const result = await ocrHandler(doc, noopCtx);
    const patch = patchOf(result);
    expect(patch.ocr_text).toBe("");
    // Words still persisted so the threshold can be re-tuned.
    expect(patch.ocr_words).toHaveLength(1);
    expect(patch.ocr_meta.mean_confidence).toBe(25);
  });

  it("blanks ocr_text when mean_confidence is null (engine gave no signal)", async () => {
    const absPath = join(tmpRoot, "blank-signal.dng");
    seedThumb(absPath);
    const doc = fakeDoc(absPath);
    setOcrEngineForTests(
      fakeEngine({
        text: "ghost text",
        mean_confidence: null,
        words: [],
      }),
    );
    const patch = patchOf(await ocrHandler(doc, noopCtx));
    expect(patch.ocr_text).toBe("");
    expect(patch.ocr_words).toEqual([]);
  });

  it("honours MAPLE_OCR_MIN_CONFIDENCE override", async () => {
    process.env.MAPLE_OCR_MIN_CONFIDENCE = "20";
    const absPath = join(tmpRoot, "lowered.dng");
    seedThumb(absPath);
    const doc = fakeDoc(absPath);
    setOcrEngineForTests(
      fakeEngine({
        text: "marginal text",
        mean_confidence: 25, // would fail at 60, passes at 20
        words: [
          { text: "marginal", confidence: 25, bbox: { x: 0, y: 0, w: 10, h: 10 } },
        ],
      }),
    );
    const patch = patchOf(await ocrHandler(doc, noopCtx));
    expect(patch.ocr_text).toBe("marginal text");
  });

  it("keeps high-confidence text exactly as the engine returned it", async () => {
    const absPath = join(tmpRoot, "clear.dng");
    seedThumb(absPath);
    const doc = fakeDoc(absPath);
    setOcrEngineForTests(
      fakeEngine({
        text: "Crystal clear text",
        mean_confidence: 95,
        words: [
          { text: "Crystal", confidence: 95, bbox: { x: 0, y: 0, w: 50, h: 10 } },
        ],
      }),
    );
    const patch = patchOf(await ocrHandler(doc, noopCtx));
    expect(patch.ocr_text).toBe("Crystal clear text");
    expect(patch.ocr_meta.mean_confidence).toBe(95);
  });

  it("filters per-word noise below MAPLE_OCR_WORD_CONFIDENCE_FLOOR", async () => {
    const absPath = join(tmpRoot, "noise.dng");
    seedThumb(absPath);
    const doc = fakeDoc(absPath);
    setOcrEngineForTests(
      fakeEngine({
        text: "good ok",
        mean_confidence: 70,
        words: [
          { text: "good", confidence: 80, bbox: { x: 0, y: 0, w: 30, h: 10 } },
          { text: "ok", confidence: 50, bbox: { x: 35, y: 0, w: 20, h: 10 } },
          { text: "j", confidence: 8, bbox: { x: 60, y: 0, w: 5, h: 10 } },
          { text: ".", confidence: 1, bbox: { x: 70, y: 0, w: 2, h: 2 } },
        ],
      }),
    );
    // Default floor of 20 → drops the two noise tokens, keeps the rest.
    const patch = patchOf(await ocrHandler(doc, noopCtx));
    expect(patch.ocr_words.map((w) => w.text)).toEqual(["good", "ok"]);
  });

  it("MAPLE_OCR_WORD_CONFIDENCE_FLOOR=0 disables word filtering", async () => {
    process.env.MAPLE_OCR_WORD_CONFIDENCE_FLOOR = "0";
    const absPath = join(tmpRoot, "raw.dng");
    seedThumb(absPath);
    const doc = fakeDoc(absPath);
    setOcrEngineForTests(
      fakeEngine({
        text: "good j",
        mean_confidence: 70,
        words: [
          { text: "good", confidence: 80, bbox: { x: 0, y: 0, w: 30, h: 10 } },
          { text: "j", confidence: 8, bbox: { x: 35, y: 0, w: 5, h: 10 } },
        ],
      }),
    );
    const patch = patchOf(await ocrHandler(doc, noopCtx));
    expect(patch.ocr_words).toHaveLength(2);
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
