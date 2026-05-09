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

interface FakeWorker {
  recognize(image: unknown): Promise<{ data: { text: string } }>;
  terminate(): Promise<unknown>;
}
interface FakeScheduler {
  addWorker(worker: FakeWorker): string;
  addJob(
    action: "recognize",
    image: unknown,
  ): Promise<{ data: { text: string } }>;
  terminate(): Promise<unknown>;
}

function fakeTesseract(opts: {
  /** Map of input bytes (stringified) → text the worker returns. */
  responses?: Map<string, string>;
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
        async addJob(action, image): Promise<{ data: { text: string } }> {
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
        async recognize(image): Promise<{ data: { text: string } }> {
          // The "image" arg is the bytes we passed in.
          const key = String(image);
          const text = opts.responses?.get(key) ?? "fake recognised text";
          return { data: { text } };
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

    expect(events.length).toBeGreaterThan(0);
    expect(events).toContain("createScheduler");
    expect(events).toContain("createWorker:eng");

    await engine.shutdown();
  });

  it("returns the worker's text trimmed and CRLF-normalised", async () => {
    const inputBytes = new Uint8Array([0, 1, 2]);
    const responses = new Map<string, string>();
    responses.set(String(inputBytes), "Welcome to Maple\r\n  ");
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
