/**
 * OCR engine tests.
 *
 * The default tests use a fake tesseract module — they cover the
 * lifecycle (lazy init, idle teardown, retry across teardowns) without
 * shipping the real tesseract wasm or downloading the eng traineddata in
 * CI. The real tesseract.js code path is exercised by an opt-in smoke
 * test gated on `MAPLE_OCR_SMOKE=1`; without the gate the test
 * skip-passes with a clear marker so headless CI runs don't fail
 * spuriously.
 */

import { describe, it, expect } from "bun:test";
import { createOcrEngine, OCR_ENGINE_VERSION } from "./ocr-engine.ts";

interface FakeWordRaw {
  text?: string;
  confidence?: number;
  bbox?: { x0: number; y0: number; x1: number; y1: number };
}
interface FakeRecognizeData {
  text: string;
  confidence?: number;
  words?: FakeWordRaw[];
}
interface FakeWorker {
  recognize(image: unknown): Promise<{ data: FakeRecognizeData }>;
  terminate(): Promise<unknown>;
}
interface FakeScheduler {
  addWorker(worker: FakeWorker): string;
  addJob(
    action: "recognize",
    image: unknown,
  ): Promise<{ data: FakeRecognizeData }>;
  terminate(): Promise<unknown>;
}

interface FakeResponse {
  text: string;
  confidence?: number;
  words?: FakeWordRaw[];
}

function fakeTesseract(opts: {
  /** Map of input bytes (stringified) → response the worker returns. */
  responses?: Map<string, FakeResponse>;
  /** Track lifecycle calls. */
  events?: string[];
} = {}) {
  const events = opts.events ?? [];
  return {
    createScheduler(): FakeScheduler {
      events.push("createScheduler");
      let worker: FakeWorker | null = null;
      return {
        addWorker(w: FakeWorker): string {
          worker = w;
          events.push("addWorker");
          return "fake-id";
        },
        async addJob(action, image): Promise<{ data: FakeRecognizeData }> {
          if (action !== "recognize") {
            throw new Error(`unexpected action: ${action}`);
          }
          if (!worker) throw new Error("worker missing");
          return worker.recognize(image);
        },
        async terminate() {
          events.push("terminateScheduler");
          if (worker) await worker.terminate();
          return undefined;
        },
      };
    },
    async createWorker(langs: string | string[]): Promise<FakeWorker> {
      events.push(`createWorker:${Array.isArray(langs) ? langs.join("+") : langs}`);
      return {
        async recognize(image): Promise<{ data: FakeRecognizeData }> {
          // The "image" arg is the bytes we passed in.
          const key = String(image);
          const resp = opts.responses?.get(key);
          if (resp) {
            return {
              data: {
                text: resp.text,
                confidence: resp.confidence,
                words: resp.words,
              },
            };
          }
          return {
            data: {
              text: "fake recognised text",
              confidence: 88,
              words: [
                {
                  text: "fake",
                  confidence: 90,
                  bbox: { x0: 0, y0: 0, x1: 30, y1: 10 },
                },
              ],
            },
          };
        },
        async terminate() {
          events.push("terminateWorker");
          return undefined;
        },
      };
    },
  };
}

describe("createOcrEngine — lazy init + result shape", () => {
  it("does not load tesseract until the first recognize call", async () => {
    const events: string[] = [];
    const engine = createOcrEngine({
      languages: "eng",
      idleTeardownMs: 60_000,
      loadTesseract: async () => fakeTesseract({ events }),
    });
    expect(events).toEqual([]);

    const r = await engine.recognizeText(new Uint8Array([1, 2, 3]));
    expect(r.engine).toBe("tesseract");
    expect(r.engine_version).toBe(OCR_ENGINE_VERSION);
    expect(r.text).toBe("fake recognised text");
    expect(r.mean_confidence).toBe(88);
    expect(r.words).toHaveLength(1);
    expect(r.words[0]).toEqual({
      text: "fake",
      confidence: 90,
      bbox: { x: 0, y: 0, w: 30, h: 10 },
    });

    expect(events.length).toBeGreaterThan(0);
    expect(events).toContain("createScheduler");
    expect(events).toContain("createWorker:eng");

    await engine.shutdown();
  });

  it("returns the worker's text trimmed and CRLF-normalised", async () => {
    const inputBytes = new Uint8Array([0, 1, 2]);
    const responses = new Map<string, FakeResponse>();
    responses.set(String(inputBytes), {
      text: "Welcome to Maple\r\n  ",
      confidence: 80,
      words: [],
    });
    const engine = createOcrEngine({
      languages: "eng",
      idleTeardownMs: 60_000,
      loadTesseract: async () =>
        fakeTesseract({
          responses,
        }),
    });
    const r = await engine.recognizeText(inputBytes);
    expect(r.text).toBe("Welcome to Maple");
    await engine.shutdown();
  });

  it("falls back to per-word mean when engine confidence is missing", async () => {
    const inputBytes = new Uint8Array([7, 8, 9]);
    const responses = new Map<string, FakeResponse>();
    responses.set(String(inputBytes), {
      text: "two words",
      words: [
        { text: "two", confidence: 70, bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } },
        { text: "words", confidence: 30, bbox: { x0: 12, y0: 0, x1: 50, y1: 10 } },
      ],
      // No top-level confidence — engine omitted it.
    });
    const engine = createOcrEngine({
      languages: "eng",
      idleTeardownMs: 60_000,
      loadTesseract: async () => fakeTesseract({ responses }),
    });
    const r = await engine.recognizeText(inputBytes);
    expect(r.mean_confidence).toBe(50); // (70 + 30) / 2
    expect(r.words.map((w) => w.text)).toEqual(["two", "words"]);
    await engine.shutdown();
  });

  it("coerces non-finite word confidences to 0 instead of poisoning the mean", async () => {
    const inputBytes = new Uint8Array([99]);
    const responses = new Map<string, FakeResponse>();
    responses.set(String(inputBytes), {
      text: "two words",
      // No top-level confidence — forces the per-word mean fallback.
      words: [
        { text: "two", confidence: 80, bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } },
        // NaN is what we'd get if Tesseract ever emitted a malformed entry.
        // Without coercion the mean would itself be NaN.
        { text: "words", confidence: Number.NaN, bbox: { x0: 12, y0: 0, x1: 50, y1: 10 } },
      ],
    });
    const engine = createOcrEngine({
      languages: "eng",
      idleTeardownMs: 60_000,
      loadTesseract: async () => fakeTesseract({ responses }),
    });
    const r = await engine.recognizeText(inputBytes);
    expect(r.words.map((w) => w.confidence)).toEqual([80, 0]);
    expect(r.mean_confidence).toBe(40); // (80 + 0) / 2 — never NaN.
    await engine.shutdown();
  });

  it("clamps out-of-range word confidences into [0, 100]", async () => {
    const inputBytes = new Uint8Array([12]);
    const responses = new Map<string, FakeResponse>();
    responses.set(String(inputBytes), {
      text: "x",
      confidence: 60,
      words: [
        { text: "neg", confidence: -50, bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } },
        { text: "huge", confidence: 9_999, bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } },
      ],
    });
    const engine = createOcrEngine({
      languages: "eng",
      idleTeardownMs: 60_000,
      loadTesseract: async () => fakeTesseract({ responses }),
    });
    const r = await engine.recognizeText(inputBytes);
    expect(r.words.map((w) => w.confidence)).toEqual([0, 100]);
    await engine.shutdown();
  });

  it("returns null mean_confidence when the engine produces no words", async () => {
    const inputBytes = new Uint8Array([42]);
    const responses = new Map<string, FakeResponse>();
    responses.set(String(inputBytes), { text: "", words: [] });
    const engine = createOcrEngine({
      languages: "eng",
      idleTeardownMs: 60_000,
      loadTesseract: async () => fakeTesseract({ responses }),
    });
    const r = await engine.recognizeText(inputBytes);
    expect(r.mean_confidence).toBeNull();
    expect(r.words).toEqual([]);
    await engine.shutdown();
  });

  it("drops words with blank text but keeps a zero bbox when the engine omits one", async () => {
    const inputBytes = new Uint8Array([10]);
    const responses = new Map<string, FakeResponse>();
    responses.set(String(inputBytes), {
      text: "kept",
      confidence: 75,
      words: [
        { text: "  ", confidence: 99 }, // blank — dropped
        { text: "kept", confidence: 75 }, // no bbox — zero bbox
      ],
    });
    const engine = createOcrEngine({
      languages: "eng",
      idleTeardownMs: 60_000,
      loadTesseract: async () => fakeTesseract({ responses }),
    });
    const r = await engine.recognizeText(inputBytes);
    expect(r.words).toEqual([
      { text: "kept", confidence: 75, bbox: { x: 0, y: 0, w: 0, h: 0 } },
    ]);
    await engine.shutdown();
  });

  it("reuses the scheduler across calls", async () => {
    const events: string[] = [];
    const engine = createOcrEngine({
      languages: "eng",
      idleTeardownMs: 60_000,
      loadTesseract: async () => fakeTesseract({ events }),
    });
    await engine.recognizeText(new Uint8Array([1]));
    await engine.recognizeText(new Uint8Array([2]));
    await engine.recognizeText(new Uint8Array([3]));
    // Only one createScheduler call across three recognises.
    expect(events.filter((e) => e === "createScheduler").length).toBe(1);
    await engine.shutdown();
  });

  it("tears the scheduler down after the idle window", async () => {
    const events: string[] = [];
    const engine = createOcrEngine({
      languages: "eng",
      idleTeardownMs: 5,
      loadTesseract: async () => fakeTesseract({ events }),
    });
    await engine.recognizeText(new Uint8Array([1]));
    // Wait past the teardown window.
    await new Promise((r) => setTimeout(r, 30));
    expect(events).toContain("terminateScheduler");
    // A second call rebuilds the scheduler.
    await engine.recognizeText(new Uint8Array([2]));
    expect(
      events.filter((e) => e === "createScheduler").length,
    ).toBeGreaterThanOrEqual(2);
    await engine.shutdown();
  });

  it("respects MAPLE_OCR_LANGUAGES from env when no explicit override", async () => {
    const prior = process.env.MAPLE_OCR_LANGUAGES;
    process.env.MAPLE_OCR_LANGUAGES = "eng,fra";
    try {
      const events: string[] = [];
      const engine = createOcrEngine({
        loadTesseract: async () => fakeTesseract({ events }),
      });
      await engine.recognizeText(new Uint8Array([1]));
      expect(events).toContain("createWorker:eng+fra");
      await engine.shutdown();
    } finally {
      if (prior === undefined) delete process.env.MAPLE_OCR_LANGUAGES;
      else process.env.MAPLE_OCR_LANGUAGES = prior;
    }
  });
});

// Real tesseract smoke test. Off by default — enable with MAPLE_OCR_SMOKE=1.
describe("createOcrEngine — real tesseract smoke", () => {
  it("returns text on a tiny known image", async () => {
    if (process.env.MAPLE_OCR_SMOKE !== "1") {
      // Mirror the test_color_pipeline.sh "no fixtures, skipping" pattern.
      console.log("[ocr-engine.test] skipping: set MAPLE_OCR_SMOKE=1 to run");
      return;
    }
    const engine = createOcrEngine({ languages: "eng" });
    // Generate a tiny "HELLO" PNG via sharp at runtime so we don't ship
    // a binary fixture.
    const sharp = (await import("sharp")).default;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><rect width="200" height="60" fill="white"/><text x="10" y="40" font-family="monospace" font-size="32" fill="black">HELLO</text></svg>`;
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    const r = await engine.recognizeText(new Uint8Array(png));
    expect(r.text.toUpperCase()).toContain("HELLO");
    await engine.shutdown();
  }, 60_000);
});
