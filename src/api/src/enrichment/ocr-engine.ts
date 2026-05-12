/**
 * Tesseract.js wrapper. One scheduler per process; workers spin up
 * lazily on the first recognise() call and tear themselves down after a
 * configurable idle window so the long tail of a small library doesn't
 * keep RAM pinned forever.
 *
 * tesseract.js is heavy (the wasm core + the language traineddata file
 * is ~10 MB per language, downloaded on first use and cached on disk).
 * Tests mock this module — `recognizeText` is the only seam.
 *
 * Default language is `eng`; configurable via `MAPLE_OCR_LANGUAGES`
 * (comma-separated; passed straight through to tesseract).
 */

import { child as childLogger } from "../log.ts";
import type { Bbox } from "../db/schema.ts";

const log = childLogger("enrichment:ocr-engine");

/** Stamped into `ocr_meta.engine_version` for human-readable provenance
 * only. The worker runtime decides whether to re-run a stage based on the
 * numeric `targetVersion` declared on the stage definition (see
 * `workers/stages/ocr.ts`), NOT this string. Bumping this constant
 * without also bumping `targetVersion` is a no-op for reprocessing. */
export const OCR_ENGINE_VERSION = "tesseract@5.1-conf";

/** The duration of inactivity after which the scheduler tears itself
 * down. Tunable via env mostly so tests can shrink it. */
const IDLE_TEARDOWN_MS_DEFAULT = 5 * 60 * 1_000;

/** Per-word output. Bboxes are in input-image pixel coordinates. */
export interface RecognizedWord {
  text: string;
  /** Engine-reported confidence, 0–100. */
  confidence: number;
  bbox: Bbox;
}

export interface RecognitionResult {
  /** Recognised text, normalised to LF newlines. Empty when nothing
   * was readable (still a valid result — the worker writes `""` to
   * `ocr_text` and marks the stage done). */
  text: string;
  /** Engine name. Stable across versions. */
  engine: "tesseract";
  /** Engine version string for provenance. */
  engine_version: string;
  /** Mean engine confidence over the page, 0–100. `null` when the engine
   * gave us no useful signal (e.g. zero words detected). */
  mean_confidence: number | null;
  /** Per-word output — always present; `[]` when nothing was detected. */
  words: RecognizedWord[];
}

/** Pluggable engine surface so tests can swap the real Tesseract for a
 * captured-call stub. */
export interface OcrEngine {
  recognizeText(jpegBytes: Uint8Array): Promise<RecognitionResult>;
  /** Tear down any background resources. Idempotent. */
  shutdown(): Promise<void>;
}

/** Tesseract-side word shape. Only the fields we actually consume are
 * typed; `bbox` is the engine's `{x0, y0, x1, y1}` rectangle. */
interface TesseractWordRaw {
  text?: string;
  confidence?: number;
  bbox?: { x0: number; y0: number; x1: number; y1: number };
}

/** Result shape returned by tesseract.js's `recognize` job. Lifted into
 * `RecognitionResult` by the engine wrapper. */
interface TesseractRecognizeData {
  text: string;
  confidence?: number;
  words?: TesseractWordRaw[];
}

interface TesseractWorker {
  recognize(image: unknown): Promise<{ data: TesseractRecognizeData }>;
  terminate(): Promise<unknown>;
}

interface TesseractScheduler {
  addWorker(worker: TesseractWorker): string;
  addJob(
    action: "recognize",
    image: unknown,
  ): Promise<{ data: TesseractRecognizeData }>;
  terminate(): Promise<unknown>;
}

interface TesseractModule {
  createScheduler(): TesseractScheduler;
  createWorker(langs: string | string[]): Promise<TesseractWorker>;
}

interface RealEngineConfig {
  /** Comma-separated tesseract language codes, e.g. `"eng"` or
   * `"eng,fra"`. Default `eng`. */
  languages?: string;
  /** Override the tesseract module — tests inject a fake without
   * shipping the real wasm in CI. */
  loadTesseract?: () => Promise<TesseractModule>;
  /** Idle teardown window. */
  idleTeardownMs?: number;
}

/** Build the production engine. Lazy: the scheduler isn't created until
 * the first `recognizeText` call, and it's torn down after
 * `idleTeardownMs` of inactivity. */
export function createOcrEngine(cfg: RealEngineConfig = {}): OcrEngine {
  const languages =
    cfg.languages?.trim() ||
    process.env.MAPLE_OCR_LANGUAGES?.trim() ||
    "eng";
  const idleMs = cfg.idleTeardownMs ?? IDLE_TEARDOWN_MS_DEFAULT;
  const loader =
    cfg.loadTesseract ??
    (async () => (await import("tesseract.js")) as unknown as TesseractModule);

  let scheduler: TesseractScheduler | null = null;
  let initPromise: Promise<TesseractScheduler> | null = null;
  let teardownTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = 0;

  async function ensureScheduler(): Promise<TesseractScheduler> {
    if (scheduler) return scheduler;
    if (initPromise) return initPromise;
    initPromise = (async () => {
      log.info({ languages }, "tesseract scheduler initialising");
      const tesseract = await loader();
      const s = tesseract.createScheduler();
      // Single worker — OCR is CPU-bound and the geocode-style
      // single-claim worker pool gives us all the parallelism we need
      // at the JS level. Crank this up when we add a worker pool sized
      // per CPU count later.
      const worker = await tesseract.createWorker(
        languages.split(",").map((l) => l.trim()).filter((l) => l.length > 0),
      );
      s.addWorker(worker);
      scheduler = s;
      initPromise = null;
      return s;
    })();
    return initPromise;
  }

  function scheduleTeardown(): void {
    if (teardownTimer) clearTimeout(teardownTimer);
    teardownTimer = setTimeout(async () => {
      if (inFlight > 0) {
        // Reschedule — a job snuck in.
        scheduleTeardown();
        return;
      }
      const s = scheduler;
      scheduler = null;
      teardownTimer = null;
      if (s) {
        try {
          await s.terminate();
          log.info("tesseract scheduler torn down (idle)");
        } catch (err) {
          log.warn(
            { err: err instanceof Error ? err.message : err },
            "tesseract scheduler teardown failed",
          );
        }
      }
    }, idleMs);
    teardownTimer.unref?.();
  }

  return {
    async recognizeText(jpegBytes: Uint8Array): Promise<RecognitionResult> {
      const s = await ensureScheduler();
      inFlight += 1;
      try {
        // tesseract.js accepts Uint8Array / Buffer / ArrayBuffer / data
        // URLs / image elements. We pass the bytes through directly.
        const { data } = await s.addJob("recognize", jpegBytes);
        const text = (data.text ?? "").replace(/\r\n/g, "\n").trim();
        const words = normaliseWords(data.words);
        const mean_confidence =
          typeof data.confidence === "number" && Number.isFinite(data.confidence)
            ? data.confidence
            : meanConfidence(words);
        return {
          text,
          engine: "tesseract",
          engine_version: OCR_ENGINE_VERSION,
          mean_confidence,
          words,
        };
      } finally {
        inFlight -= 1;
        scheduleTeardown();
      }
    },

    async shutdown(): Promise<void> {
      if (teardownTimer) {
        clearTimeout(teardownTimer);
        teardownTimer = null;
      }
      const s = scheduler;
      scheduler = null;
      initPromise = null;
      if (s) {
        try {
          await s.terminate();
        } catch {
          // Swallow — shutdown is best-effort.
        }
      }
    },
  };
}

/** Drop malformed/empty entries, convert tesseract's `{x0,y0,x1,y1}` to
 * the `{x,y,w,h}` shape used by the face bbox + the search layer. */
function normaliseWords(raw: TesseractWordRaw[] | undefined): RecognizedWord[] {
  if (!raw || raw.length === 0) return [];
  const out: RecognizedWord[] = [];
  for (const w of raw) {
    const text = (w.text ?? "").trim();
    if (text.length === 0) continue;
    const conf = typeof w.confidence === "number" ? w.confidence : 0;
    const b = w.bbox;
    const bbox =
      b && Number.isFinite(b.x0) && Number.isFinite(b.y0) && Number.isFinite(b.x1) && Number.isFinite(b.y1)
        ? {
            x: Math.min(b.x0, b.x1),
            y: Math.min(b.y0, b.y1),
            w: Math.abs(b.x1 - b.x0),
            h: Math.abs(b.y1 - b.y0),
          }
        : { x: 0, y: 0, w: 0, h: 0 };
    out.push({ text, confidence: conf, bbox });
  }
  return out;
}

/** Fallback mean confidence when the engine didn't give us a page-level
 * number. Returns `null` on an empty word list so callers can distinguish
 * "no signal" from "low signal". */
function meanConfidence(words: RecognizedWord[]): number | null {
  if (words.length === 0) return null;
  let sum = 0;
  for (const w of words) sum += w.confidence;
  return sum / words.length;
}

// Module-level singleton — same pattern as `meilisearchClient()` so
// production code grabs the same engine across calls.
let singleton: OcrEngine | null = null;

export function ocrEngine(): OcrEngine {
  if (!singleton) singleton = createOcrEngine();
  return singleton;
}

/** Test/boot reset. The bootstrap calls this on shutdown so a SIGTERM
 * doesn't leave a tesseract worker pinned to the process. */
export async function resetOcrEngine(): Promise<void> {
  const s = singleton;
  singleton = null;
  if (s) await s.shutdown();
}

/** Test-only: replace the engine. Pass `null` to clear. */
export function setOcrEngineForTests(e: OcrEngine | null): void {
  singleton = e;
}
