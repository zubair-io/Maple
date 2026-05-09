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

const log = childLogger("enrichment:ocr-engine");

/** Bumped when the engine's output shape changes meaningfully (e.g.
 * a new tesseract major version, or a switch in OEM). Workers compare
 * this against `enrichment.ocr.version` to decide whether to rerun. */
export const OCR_ENGINE_VERSION = "tesseract@5.1";

/** The duration of inactivity after which the scheduler tears itself
 * down. Tunable via env mostly so tests can shrink it. */
const IDLE_TEARDOWN_MS_DEFAULT = 5 * 60 * 1_000;

export interface RecognitionResult {
  /** Recognised text, normalised to LF newlines. Empty when nothing
   * was readable (still a valid result — the worker writes `""` to
   * `ocr_text` and marks the stage done). */
  text: string;
  /** Engine name. Stable across versions. */
  engine: "tesseract";
  /** Engine version string for provenance. */
  engine_version: string;
}

/** Pluggable engine surface so tests can swap the real Tesseract for a
 * captured-call stub. */
export interface OcrEngine {
  recognizeText(jpegBytes: Uint8Array): Promise<RecognitionResult>;
  /** Tear down any background resources. Idempotent. */
  shutdown(): Promise<void>;
}

interface TesseractWorker {
  recognize(image: unknown): Promise<{ data: { text: string } }>;
  terminate(): Promise<unknown>;
}

interface TesseractScheduler {
  addWorker(worker: TesseractWorker): string;
  addJob(action: "recognize", image: unknown): Promise<{ data: { text: string } }>;
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
        return {
          text,
          engine: "tesseract",
          engine_version: OCR_ENGINE_VERSION,
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
