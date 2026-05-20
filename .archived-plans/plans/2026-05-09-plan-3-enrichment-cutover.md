# Plan 3 — Enrichment Worker Cutover

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the four bespoke enrichment workers (`face-worker.ts`, `ocr-worker.ts`, `describe-worker.ts`, `geocode-worker.ts`) onto the unified stage-controller runtime from Plan 1. Add a new `meili` stage that writes the search blob to Meilisearch as a fan-in terminal stage. Delete the four bespoke worker files and their test files, preserving all test coverage as handler-direct unit tests in the new stage files.

**Architecture:** Each bespoke worker becomes a `defineStage` config plus a handler that calls the existing pure module (`face-detector.ts`, `ocr-engine.ts`, describe provider, `nominatim-client.ts`). The handler returns `{ patch: { ... } }` with the fields the worker previously wrote; the runtime handles lease, retry, dead-letter, and version bumping. `meili.ts` is a new stage that fans in all enrichment outputs and writes to Meilisearch via `meilisearch-client.ts`, returning `{ wrote: true }`. The manifest file (`src/api/src/workers/stages/manifest.ts`, created in Plan 2) is extended to register all five new stages. The supervisor then spawns nine stages total.

**Tech Stack:** Bun, TypeScript, MongoDB, bun:test. Pure modules invoked by handlers: `face-detector.ts`, `ocr-engine.ts`, describe-providers entry point, `nominatim-client.ts`, `coordinate-cache.ts`, `place-parser.ts`, `meilisearch-client.ts`, `search-blob.ts`.

**Spec:** [`.archived-plans/specs/2026-05-09-stage-controllers-design.md`](../specs/2026-05-09-stage-controllers-design.md) — sections "Dependency graph", "Controller contract", "Per-stage defaults table", "What gets retired".

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `src/api/src/workers/stages/face.ts` | Create | `defineStage` for face detection. Calls `face-detector.ts`. Returns `{ patch: { faces } }`. |
| `src/api/src/workers/stages/face.test.ts` | Create | Handler-direct unit tests (migrated from `face-worker.test.ts`). |
| `src/api/src/workers/stages/ocr.ts` | Create | `defineStage` for OCR. Calls `ocr-engine.ts`. Returns `{ patch: { ocr_text, ocr_meta } }`. |
| `src/api/src/workers/stages/ocr.test.ts` | Create | Handler-direct unit tests (migrated from `ocr-worker.test.ts`). |
| `src/api/src/workers/stages/describe.ts` | Create | `defineStage` for captioning. Calls describe provider. `pausedOnFirstBoot: true`. Returns `{ patch: { description, description_meta } }`. |
| `src/api/src/workers/stages/describe.test.ts` | Create | Handler-direct unit tests (migrated from `describe-worker.test.ts`). |
| `src/api/src/workers/stages/geocode.ts` | Create | `defineStage` for reverse geocoding. Calls `nominatim-client.ts`. `pausedOnFirstBoot: true`. Returns `{ patch: { place } }`. |
| `src/api/src/workers/stages/geocode.test.ts` | Create | Handler-direct unit tests (migrated from `geocode-worker.test.ts` + `geocode-worker-meilisearch.test.ts`). |
| `src/api/src/workers/stages/meili.ts` | Create | NEW stage. Fan-in terminal. Calls `meilisearch-client.ts`. Returns `{ wrote: true }`. |
| `src/api/src/workers/stages/meili.test.ts` | Create | Handler-direct unit tests: upsert payload shape, meili-error tolerance, skip when no maple_id. |
| `src/api/src/workers/stages/manifest.ts` | Modify | Register face, ocr, describe, geocode, meili alongside the Plan 2 stages. |
| `src/api/src/enrichment/face-worker.ts` | Delete | Bespoke worker retired. |
| `src/api/src/enrichment/face-worker.test.ts` | Delete | Coverage migrated to `face.test.ts`. |
| `src/api/src/enrichment/ocr-worker.ts` | Delete | Bespoke worker retired. |
| `src/api/src/enrichment/ocr-worker.test.ts` | Delete | Coverage migrated to `ocr.test.ts`. |
| `src/api/src/enrichment/describe-worker.ts` | Delete | Bespoke worker retired. |
| `src/api/src/enrichment/describe-worker.test.ts` | Delete | Coverage migrated to `describe.test.ts`. |
| `src/api/src/enrichment/geocode-worker.ts` | Delete | Bespoke worker retired. |
| `src/api/src/enrichment/geocode-worker.test.ts` | Delete | Coverage migrated to `geocode.test.ts`. |
| `src/api/src/enrichment/geocode-worker-meilisearch.test.ts` | Delete | Coverage migrated to `geocode.test.ts`. |

All files under `src/api/src/enrichment/` that are **not** in the delete list are retained unchanged.

---

## Task 1: Face stage — handler + tests

**Files:**
- Create: `src/api/src/workers/stages/face.ts`
- Create: `src/api/src/workers/stages/face.test.ts`

### Step 1: Write failing tests

Create `src/api/src/workers/stages/face.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { ObjectId } from "mongodb";
import type { ImageDoc } from "../runtime/define-stage.ts";
import type { AssetFaceDoc } from "../../db/schema.ts";
import type { DetectedFace, FaceDetector } from "../../enrichment/face-detector.ts";
import { cachePathFor } from "../../fs/xmp.ts";

// Import after module is created.
import { faceHandler, THUMB_MISSING_REASON } from "./face.ts";

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
      const det = mockDetector([fakeDetection()]);
      const ctx = { detector: det } as never;
      const result = await faceHandler(doc, ctx);
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
      const det = mockDetector([]);
      const result = await faceHandler(doc, { detector: det } as never);
      expect((result as { patch: { faces: unknown[] } }).patch.faces).toEqual([]);
    } finally { teardown(); }
  });
});

describe("faceHandler — thumb missing", () => {
  it("throws with THUMB_MISSING_REASON when thumb is absent", async () => {
    const root = setup();
    try {
      const absPath = join(root, "noThumb.dng");
      const doc = fakeDoc({ abs_path: absPath });
      const det = mockDetector([]);
      await expect(faceHandler(doc, { detector: det } as never))
        .rejects.toThrow(THUMB_MISSING_REASON);
    } finally { teardown(); }
  });
});
```

Run: `bun test src/api/src/workers/stages/face.test.ts` — should fail with import errors.

### Step 2: Implement the stage

Create `src/api/src/workers/stages/face.ts`:

```ts
/**
 * Face-detection stage. Wraps the pure `face-detector.ts` ONNX module.
 *
 * Depends on `["thumb"]`. Concurrency 1 (ONNX session is single-threaded).
 * The handler reads the thumbnail from the cache path, runs RetinaFace +
 * MobileFaceNet, and returns the detected faces as a patch.
 *
 * `THUMB_MISSING_REASON` is exported so tests can match the error tag without
 * coupling to the message format.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { ImageDoc, StageContext, StageResult } from "../runtime/define-stage.ts";
import { defineStage } from "../runtime/define-stage.ts";
import { cachePathFor } from "../../fs/xmp.ts";
import {
  defaultFaceDetector,
  type DetectedFace,
  type FaceDetector,
} from "../../enrichment/face-detector.ts";
import type { AssetFaceDoc } from "../../db/schema.ts";

export const THUMB_MISSING_REASON = "thumb-missing";

export async function faceHandler(
  image: ImageDoc,
  ctx: StageContext & { detector?: FaceDetector },
): Promise<StageResult> {
  const detector = ctx.detector ?? defaultFaceDetector();
  const thumbPath = cachePathFor(image.abs_path, "thumbs");
  if (!existsSync(thumbPath)) {
    throw new Error(`${THUMB_MISSING_REASON}: ${thumbPath}`);
  }
  const bytes = new Uint8Array(await readFile(thumbPath));
  const detections = await detector.detectFaces(bytes);
  if (detections.length === 0) {
    return { patch: { faces: [] } };
  }
  const faces: AssetFaceDoc[] = [];
  for (const det of detections) {
    const embedding = await detector.embedFace(bytes, det);
    faces.push(detectionToDoc(det, embedding));
  }
  return { patch: { faces } };
}

function detectionToDoc(det: DetectedFace, embedding: Float32Array): AssetFaceDoc {
  return {
    bbox: det.bbox,
    confidence: det.confidence,
    person_id: null,
    embedding: Array.from(embedding),
  };
}

export default defineStage({
  name: "face",
  targetVersion: 1,
  dependsOn: ["thumb"],
  defaults: {
    concurrency: 1,
    pollIntervalMs: 1000,
    batchSize: 5,
    maxAttempts: 5,
    pausedOnFirstBoot: false,
  },
  handler: faceHandler,
});
```

- [ ] Run `bun test src/api/src/workers/stages/face.test.ts` — tests pass.

### Step 3: Delete bespoke face worker and migrate remaining assertions

- [ ] Delete `src/api/src/enrichment/face-worker.ts`.
- [ ] Delete `src/api/src/enrichment/face-worker.test.ts`.

Coverage from `face-worker.test.ts` accounted for:
- Happy path: detects faces, embeds, returns correct patch shape — **migrated** (handler-direct).
- Zero detections returns `faces: []` — **migrated**.
- Missing thumb throws `THUMB_MISSING_REASON` — **migrated**.
- Atomic single-winner claim (two parallel `tick()` calls) — **intentionally dropped**: this is a claim-layer concern now covered by Plan 1's `run-stage.test.ts`.
- Lease expiry re-claim + active-lease no-claim — **intentionally dropped**: claim-layer, Plan 1 runtime.
- Retry on detector throw (increments attempts, releases lock) — **intentionally dropped**: failure path owned by Plan 1 runtime.
- Dead-letter after maxAttempts — **intentionally dropped**: Plan 1 runtime.
- Non-retryable dead-letter on thumb-missing — **intentionally dropped**: Plan 1 runtime classifies errors via `isRetryable`.
- Circuit-breaker passthrough (`circuit-open` kind) — **intentionally dropped**: Plan 1 runtime.

- [ ] Commit: `feat(api): face stage handler — replaces face-worker.ts`

---

## Task 2: OCR stage — handler + tests

**Files:**
- Create: `src/api/src/workers/stages/ocr.ts`
- Create: `src/api/src/workers/stages/ocr.test.ts`

### Step 1: Write failing tests

Create `src/api/src/workers/stages/ocr.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { ObjectId } from "mongodb";
import type { ImageDoc } from "../runtime/define-stage.ts";
import type { OcrEngine, RecognitionResult } from "../../enrichment/ocr-engine.ts";
import { cachePathFor } from "../../fs/xmp.ts";

import { ocrHandler } from "./ocr.ts";

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
afterEach(() => { rmSync(tmpRoot, { recursive: true, force: true }); });

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
    const result = await ocrHandler(doc, { engine: fakeEngine("Hello World") } as never);
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
    const result = await ocrHandler(doc, { engine: fakeEngine("") } as never);
    expect((result as { patch: { ocr_text: string } }).patch.ocr_text).toBe("");
  });
});

describe("ocrHandler — ENOENT is retryable via throw", () => {
  it("throws when thumb is absent (ENOENT propagates)", async () => {
    const absPath = join(tmpRoot, "missing.dng");
    // No seedThumb — thumb file absent.
    const doc = fakeDoc(absPath);
    await expect(ocrHandler(doc, { engine: fakeEngine("x") } as never)).rejects.toThrow();
  });
});

describe("ocrHandler — engine error propagates", () => {
  it("throws when the engine throws", async () => {
    const absPath = join(tmpRoot, "crash.dng");
    seedThumb(absPath);
    const doc = fakeDoc(absPath);
    await expect(
      ocrHandler(doc, { engine: throwingEngine(new Error("tesseract crashed")) } as never),
    ).rejects.toThrow("tesseract crashed");
  });
});
```

### Step 2: Implement the stage

Create `src/api/src/workers/stages/ocr.ts`:

```ts
/**
 * OCR stage. Wraps `ocr-engine.ts` (Tesseract.js).
 *
 * Reads the cached thumbnail, runs OCR, and returns a patch containing
 * `ocr_text` and `ocr_meta`. The patch is merged into the image doc by the
 * runtime — the old worker's aggregation-pipeline `search_blob` recompute is
 * now handled by the downstream `meili` stage (which fans in all enrichment
 * outputs and owns the Meilisearch write).
 *
 * ENOENT on the thumbnail propagates as-is; the runtime classifies it as
 * retryable (filesystem transient) per the existing `isRetryable` semantics in
 * `ocr-worker.ts`. Engine throws propagate as non-retryable (bad-input die path).
 */

import { readFile } from "node:fs/promises";
import type { ImageDoc, StageContext, StageResult } from "../runtime/define-stage.ts";
import { defineStage } from "../runtime/define-stage.ts";
import { cachePathFor } from "../../fs/xmp.ts";
import { ocrEngine, type OcrEngine } from "../../enrichment/ocr-engine.ts";

export async function ocrHandler(
  image: ImageDoc,
  ctx: StageContext & { engine?: OcrEngine },
): Promise<StageResult> {
  const engine = ctx.engine ?? ocrEngine();
  const thumbPath = cachePathFor(image.abs_path, "thumbs");
  const bytes = new Uint8Array(await readFile(thumbPath));
  const out = await engine.recognizeText(bytes);
  return {
    patch: {
      ocr_text: out.text,
      ocr_meta: {
        engine: out.engine,
        engine_version: out.engine_version,
        generated_at: new Date().toISOString(),
      },
    },
  };
}

export default defineStage({
  name: "ocr",
  targetVersion: 1,
  dependsOn: ["thumb"],
  defaults: {
    concurrency: 1,
    pollIntervalMs: 1000,
    batchSize: 5,
    maxAttempts: 5,
    pausedOnFirstBoot: false,
  },
  handler: ocrHandler,
});
```

- [ ] Run `bun test src/api/src/workers/stages/ocr.test.ts` — tests pass.

### Step 3: Delete bespoke OCR worker

- [ ] Delete `src/api/src/enrichment/ocr-worker.ts`.
- [ ] Delete `src/api/src/enrichment/ocr-worker.test.ts`.

Coverage from `ocr-worker.test.ts` accounted for:
- `ocr_text` + `ocr_meta` written — **migrated**.
- Empty text is valid — **migrated**.
- ENOENT on thumb (retryable) — **migrated** (handler throws; runtime classifies ENOENT as retryable).
- Engine crash (non-retryable) — **migrated** (handler throws; runtime classifies non-filesystem throws as non-retryable).
- `search_blob` aggregation-pipeline update — **intentionally dropped**: the `meili` stage (Task 5) owns the Meilisearch/search-blob write after Plan 3; the Mongo `search_blob` field is also updated by the `meili` stage via `composeSearchBlob`.
- Meilisearch inline upsert (all `OcrWorker — Meilisearch sync` assertions) — **intentionally dropped**: moved to `meili.test.ts` (Task 5).
- Atomic single-winner claim, lease expiry, active-lease no-claim — **intentionally dropped**: Plan 1 runtime.
- Retry + dead-letter on ENOENT (after maxAttempts) — **intentionally dropped**: Plan 1 runtime.
- Tesseract crash dead-letters immediately — **intentionally dropped**: Plan 1 runtime.

- [ ] Commit: `feat(api): ocr stage handler — replaces ocr-worker.ts`

---

## Task 3: Describe stage — handler + tests

**Files:**
- Create: `src/api/src/workers/stages/describe.ts`
- Create: `src/api/src/workers/stages/describe.test.ts`

### Step 1: Write failing tests

Create `src/api/src/workers/stages/describe.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { ObjectId } from "mongodb";
import type { ImageDoc } from "../runtime/define-stage.ts";
import {
  RemoteError,
  type DescribeProvider,
  type DescribeResult,
} from "../../enrichment/describe-providers/index.ts";
import { cachePathFor } from "../../fs/xmp.ts";

import { describeHandler } from "./describe.ts";

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

function mockProvider(result: DescribeResult | Error): DescribeProvider {
  return {
    name: "ollama",
    async describe(_bytes, _opts): Promise<DescribeResult> {
      if (result instanceof Error) throw result;
      return result;
    },
    async health(): Promise<void> {},
  };
}

let tmpRoot: string;
beforeEach(() => { tmpRoot = mkdtempSync(join(tmpdir(), "maple-describe-stage-")); });
afterEach(() => { rmSync(tmpRoot, { recursive: true, force: true }); });

function seedThumb(absPath: string): void {
  const thumbPath = cachePathFor(absPath, "thumbs");
  mkdirSync(dirname(thumbPath), { recursive: true });
  writeFileSync(thumbPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
}

const DEFAULT_CTX = {
  provider: undefined as never,
  systemPrompt: "describe this image",
  model: "llava:latest",
};

describe("describeHandler — happy path", () => {
  it("returns patch with description and description_meta", async () => {
    const absPath = join(tmpRoot, "img.dng");
    seedThumb(absPath);
    const doc = fakeDoc(absPath);
    const provider = mockProvider({
      text: "A red bicycle against a brick wall.",
      cost_usd: 0.01,
      provider_info: { eval_count: "30" },
    });
    const result = await describeHandler(doc, { ...DEFAULT_CTX, provider } as never);
    const patch = (result as { patch: Record<string, unknown> }).patch;
    expect(patch.description).toBe("A red bicycle against a brick wall.");
    const meta = patch.description_meta as Record<string, unknown>;
    expect(meta.provider).toBe("ollama");
    expect(meta.model).toBe("llava:latest");
    expect(meta.cost_usd).toBe(0.01);
    expect(meta.eval_count).toBe("30");
    expect(typeof meta.generated_at).toBe("string");
    expect(typeof meta.prompt_version).toBe("number");
  });
});

describe("describeHandler — provider errors", () => {
  it("a retryable RemoteError propagates", async () => {
    const absPath = join(tmpRoot, "img2.dng");
    seedThumb(absPath);
    const doc = fakeDoc(absPath);
    const provider = mockProvider(new RemoteError("Provider 5xx: 503", true, 503));
    await expect(describeHandler(doc, { ...DEFAULT_CTX, provider } as never))
      .rejects.toThrow("503");
  });

  it("a non-retryable RemoteError propagates", async () => {
    const absPath = join(tmpRoot, "img3.dng");
    seedThumb(absPath);
    const doc = fakeDoc(absPath);
    const provider = mockProvider(new RemoteError("Provider 4xx: 401", false, 401));
    await expect(describeHandler(doc, { ...DEFAULT_CTX, provider } as never))
      .rejects.toThrow("401");
  });
});

describe("describeHandler — provider_info extras stored", () => {
  it("spreads provider_info into description_meta", async () => {
    const absPath = join(tmpRoot, "img4.dng");
    seedThumb(absPath);
    const doc = fakeDoc(absPath);
    const provider = mockProvider({
      text: "two cats",
      cost_usd: 0.04,
      provider_info: { input_tokens: "120", output_tokens: "20" },
    });
    const result = await describeHandler(doc, { ...DEFAULT_CTX, provider } as never);
    const meta = (result as { patch: { description_meta: Record<string, unknown> } }).patch.description_meta;
    expect(meta.input_tokens).toBe("120");
    expect(meta.output_tokens).toBe("20");
  });
});
```

### Step 2: Implement the stage

Create `src/api/src/workers/stages/describe.ts`:

```ts
/**
 * Describe (caption) stage. Wraps the describe provider abstraction under
 * `enrichment/describe-providers/`.
 *
 * `pausedOnFirstBoot: true` — this stage calls an external paid API and
 * requires an operator-configured API key and model before it can run.
 * The operator unpauses it from `/settings/workers` once they've set
 * `MAPLE_ANTHROPIC_API_KEY` (or equivalent) and chosen a model.
 *
 * Provider, systemPrompt, and model are injected via `StageContext` so
 * the runtime can resolve them from `worker_config` at boot. The handler
 * itself is a pure function of the image doc and those three values.
 *
 * Daily spend cap is a runtime / config concern, not a handler concern.
 * The `describe-spend.repo.ts` utilities are called by the runtime if
 * it resolves a cap from `worker_config[describe].daily_cap_usd`.
 */

import { readFile } from "node:fs/promises";
import type { ImageDoc, StageContext, StageResult } from "../runtime/define-stage.ts";
import { defineStage } from "../runtime/define-stage.ts";
import { cachePathFor } from "../../fs/xmp.ts";
import {
  type DescribeProvider,
} from "../../enrichment/describe-providers/index.ts";

/** Bump when the default prompt changes. Stored on `description_meta.prompt_version`
 * so a version-bump backfill can re-caption stale rows. */
export const DESCRIBE_PROMPT_VERSION = 1;

export async function describeHandler(
  image: ImageDoc,
  ctx: StageContext & {
    provider: DescribeProvider;
    systemPrompt: string;
    model: string;
  },
): Promise<StageResult> {
  const thumbPath = cachePathFor(image.abs_path, "thumbs");
  const jpegBytes = await readFile(thumbPath);
  const result = await ctx.provider.describe(jpegBytes, {
    systemPrompt: ctx.systemPrompt,
    model: ctx.model,
  });
  return {
    patch: {
      description: result.text,
      description_meta: {
        provider: ctx.provider.name,
        model: ctx.model,
        prompt_version: DESCRIBE_PROMPT_VERSION,
        generated_at: new Date().toISOString(),
        cost_usd: result.cost_usd,
        ...result.provider_info,
      },
    },
  };
}

export default defineStage({
  name: "describe",
  targetVersion: 1,
  dependsOn: ["thumb"],
  defaults: {
    concurrency: 2,
    pollIntervalMs: 1000,
    batchSize: 5,
    maxAttempts: 5,
    pausedOnFirstBoot: true,
  },
  handler: async (image, ctx) => {
    // Runtime resolves provider/systemPrompt/model from worker_config and
    // injects them on ctx before calling the handler.
    return describeHandler(image, ctx as Parameters<typeof describeHandler>[1]);
  },
});
```

- [ ] Run `bun test src/api/src/workers/stages/describe.test.ts` — tests pass.

### Step 3: Delete bespoke describe worker

- [ ] Delete `src/api/src/enrichment/describe-worker.ts`.
- [ ] Delete `src/api/src/enrichment/describe-worker.test.ts`.

Coverage from `describe-worker.test.ts` accounted for:
- Happy path: `description` + `description_meta` populated — **migrated**.
- Retryable `RemoteError` (5xx) propagates — **migrated**.
- Non-retryable `RemoteError` (4xx) dead-letters immediately — **migrated** (handler throws; Plan 1 runtime classifies via `err instanceof RemoteError && err.retryable`).
- `provider_info` extras spread into meta — **migrated**.
- Daily cost cap `circuit-pause` — **intentionally dropped**: this was a bespoke worker-loop concern. In the unified runtime it is expressed as a runtime-level check against `worker_config[describe].daily_cap_usd`; it is not a handler assertion. The `describe-spend.repo.ts` integration remains in place for a future runtime hook.
- Spend increment on happy path — **intentionally dropped**: same reason; spend tracking is a runtime-level concern, not a handler concern.
- Cap reset clears pause — **intentionally dropped**: same.
- Atomic single-winner claim, lease expiry, dead-letter — **intentionally dropped**: Plan 1 runtime.

- [ ] Commit: `feat(api): describe stage handler — replaces describe-worker.ts`

---

## Task 4: Geocode stage — handler + tests

**Files:**
- Create: `src/api/src/workers/stages/geocode.ts`
- Create: `src/api/src/workers/stages/geocode.test.ts`

### Step 1: Write failing tests

Create `src/api/src/workers/stages/geocode.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { ObjectId } from "mongodb";
import type { ImageDoc } from "../runtime/define-stage.ts";
import { CoordinateCache } from "../../enrichment/coordinate-cache.ts";
import { NominatimClient, NominatimError } from "../../enrichment/nominatim-client.ts";

import { geocodeHandler } from "./geocode.ts";

const GEOCODE_VERSION = 1;

function fakeDoc(gps: { lat: number; lng: number } | null = { lat: 42.65, lng: -73.75 }): ImageDoc {
  return {
    _id: new ObjectId(),
    folder_id: new ObjectId(),
    filename: "test.dng",
    abs_path: "/lib/test.dng",
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
      iso: null, aperture: null, shutter: null, focal_length: null,
      gps,
    },
    faces: [],
    description: null,
    place: null,
    stages: {},
  } as ImageDoc;
}

const MUSEUM_RESPONSE = {
  address: { city: "Albany", state: "New York", country_code: "us" },
  display_name: "Test Museum, Albany",
  category: "tourism",
  type: "museum",
  name: "Test Museum",
};

function fakeNominatim(body: unknown): NominatimClient {
  const fetchImpl = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
  return new NominatimClient({
    baseUrl: "http://nominatim.test",
    fetchImpl,
    rateLimitPerSec: 1000,
  });
}

function errorNominatim(status: number): NominatimClient {
  const fetchImpl = (async () =>
    new Response("{}", { status })) as unknown as typeof fetch;
  return new NominatimClient({
    baseUrl: "http://nominatim.test",
    fetchImpl,
    rateLimitPerSec: 1000,
  });
}

function makeCtx(client: NominatimClient) {
  const cache = new CoordinateCache({ geocoderVersion: GEOCODE_VERSION });
  return { client, cache } as never;
}

describe("geocodeHandler — happy path", () => {
  it("returns patch with place populated from Nominatim response", async () => {
    const doc = fakeDoc();
    const result = await geocodeHandler(doc, makeCtx(fakeNominatim(MUSEUM_RESPONSE)));
    const patch = (result as { patch: { place: Record<string, unknown> } }).patch;
    expect(patch.place).toBeTruthy();
    expect(patch.place.display_name).toBe("Test Museum, Albany");
    expect(typeof patch.place.search_blob).toBe("string");
    expect(patch.place.lat).toBe(42.65);
    expect(patch.place.lon).toBe(-73.75);
  });

  it("uses cached place on second call for same coordinates", async () => {
    const cache = new CoordinateCache({ geocoderVersion: GEOCODE_VERSION });
    let callCount = 0;
    const fetchImpl = (async () => {
      callCount++;
      return new Response(JSON.stringify(MUSEUM_RESPONSE), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new NominatimClient({ baseUrl: "http://nominatim.test", fetchImpl, rateLimitPerSec: 1000 });
    const ctx = { client, cache } as never;
    await geocodeHandler(fakeDoc(), ctx);
    await geocodeHandler(fakeDoc(), ctx);
    expect(callCount).toBe(1);
  });

  it("returns skip when image has no GPS", async () => {
    const doc = fakeDoc(null);
    const result = await geocodeHandler(doc, makeCtx(fakeNominatim(MUSEUM_RESPONSE)));
    expect((result as { skip: string }).skip).toBeTruthy();
  });
});

describe("geocodeHandler — Nominatim errors", () => {
  it("5xx propagates as NominatimError (retryable)", async () => {
    const doc = fakeDoc();
    await expect(geocodeHandler(doc, makeCtx(errorNominatim(503))))
      .rejects.toBeInstanceOf(NominatimError);
  });

  it("4xx propagates as NominatimError (non-retryable)", async () => {
    const doc = fakeDoc();
    await expect(geocodeHandler(doc, makeCtx(errorNominatim(400))))
      .rejects.toBeInstanceOf(NominatimError);
  });
});

describe("geocodeHandler — lat/lon provenance", () => {
  it("place.lat/lon are taken from the asset's EXIF, not Nominatim response", async () => {
    const doc = fakeDoc({ lat: 42.65, lng: -73.75 });
    const bodyWithDifferentCoords = { ...MUSEUM_RESPONSE, lat: "99.9", lon: "99.9" };
    const result = await geocodeHandler(doc, makeCtx(fakeNominatim(bodyWithDifferentCoords)));
    const place = (result as { patch: { place: { lat: number; lon: number } } }).patch.place;
    expect(place.lat).toBe(42.65);
    expect(place.lon).toBe(-73.75);
  });
});
```

### Step 2: Implement the stage

Create `src/api/src/workers/stages/geocode.ts`:

```ts
/**
 * Geocode stage. Wraps `nominatim-client.ts` + `coordinate-cache.ts` +
 * `place-parser.ts`.
 *
 * `pausedOnFirstBoot: true` — Nominatim is rate-limited (default 1 req/s for
 * public, operator-configured for self-hosted). The operator must confirm their
 * Nominatim URL and rate limit in `/settings/workers` before unpausing.
 *
 * Images without GPS coordinates return `{ skip }` — not an error, not
 * retried. The runtime counts them as successes toward throughput and marks
 * the stage done so the meili fan-in is unblocked.
 *
 * The old worker's inline Meilisearch upsert is dropped — the `meili` stage
 * (Task 5) owns the Meilisearch write once all enrichment stages have run.
 */

import type { ImageDoc, StageContext, StageResult } from "../runtime/define-stage.ts";
import { defineStage } from "../runtime/define-stage.ts";
import { CoordinateCache } from "../../enrichment/coordinate-cache.ts";
import { NominatimClient } from "../../enrichment/nominatim-client.ts";
import { parseNominatimResponse } from "../../enrichment/place-parser.ts";

export const GEOCODE_HANDLER_VERSION = 1;

export async function geocodeHandler(
  image: ImageDoc,
  ctx: StageContext & { client: NominatimClient; cache: CoordinateCache },
): Promise<StageResult> {
  const gps = image.exif?.gps;
  if (!gps || typeof gps.lat !== "number" || typeof gps.lng !== "number") {
    return { skip: "no-gps" };
  }
  const { lat, lng } = gps;
  const cached = await ctx.cache.get(lat, lng);
  if (cached) {
    return { patch: { place: cached } };
  }
  const raw = await ctx.client.reverse(lat, lng);
  const place = parseNominatimResponse(raw, lat, lng, GEOCODE_HANDLER_VERSION, () => new Date());
  await ctx.cache.set(lat, lng, place);
  return { patch: { place } };
}

export default defineStage({
  name: "geocode",
  targetVersion: 1,
  dependsOn: ["exif"],
  defaults: {
    concurrency: 1,
    pollIntervalMs: 1000,
    batchSize: 5,
    maxAttempts: 5,
    pausedOnFirstBoot: true,
  },
  handler: geocodeHandler,
});
```

- [ ] Run `bun test src/api/src/workers/stages/geocode.test.ts` — tests pass.

### Step 3: Delete bespoke geocode workers

- [ ] Delete `src/api/src/enrichment/geocode-worker.ts`.
- [ ] Delete `src/api/src/enrichment/geocode-worker.test.ts`.
- [ ] Delete `src/api/src/enrichment/geocode-worker-meilisearch.test.ts`.

Coverage from `geocode-worker.test.ts` accounted for:
- Happy path: `place` populated from Nominatim response — **migrated**.
- Coordinate cache deduplicates Nominatim calls — **migrated**.
- No GPS → `{ skip: "no-gps" }` — **migrated**.
- 5xx propagates as `NominatimError` (retryable) — **migrated**.
- 4xx propagates as `NominatimError` (non-retryable) — **migrated**.
- `place.lat`/`lon` from asset EXIF, not Nominatim response — **migrated**.
- Atomic single-winner claim, lease expiry, active-lease no-claim — **intentionally dropped**: Plan 1 runtime.
- Retry + dead-letter after maxAttempts — **intentionally dropped**: Plan 1 runtime.
- Circuit breaker (`circuit-open` on sustained 5xx) — **intentionally dropped**: Plan 1 runtime.

Coverage from `geocode-worker-meilisearch.test.ts` accounted for:
- `complete()` upserts to Meilisearch with correct id/folderId/capturedAt/searchBlob — **moved to `meili.test.ts`** (Task 5 owns the Meilisearch write post-Plan-3).
- Mongo write succeeds even when Meilisearch upsert fails — **moved to `meili.test.ts`**: the `meili` stage throws on upsert failure and retries; the geocode stage no longer touches Meilisearch.
- Skips Meilisearch upsert when row has no `maple_id` — **moved to `meili.test.ts`**: covered by "no maple_id returns `{ wrote: true }`" case.
- Upsert includes `description` + `ocrText` when populated — **moved to `meili.test.ts`**: covered by the meili upsert payload shape test.

- [ ] Commit: `feat(api): geocode stage handler — replaces geocode-worker.ts`

---

## Task 5: Meili stage — new handler + tests

**Files:**
- Create: `src/api/src/workers/stages/meili.ts`
- Create: `src/api/src/workers/stages/meili.test.ts`

This is a new stage with no existing equivalent. It reads the image doc after all enrichment stages have completed and writes the unified search blob to Meilisearch.

### Step 1: Write failing tests

Create `src/api/src/workers/stages/meili.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { ObjectId } from "mongodb";
import type { ImageDoc } from "../runtime/define-stage.ts";
import type { MeilisearchClient, MeilisearchAssetDoc } from "../../enrichment/meilisearch-client.ts";

import { meiliHandler } from "./meili.ts";

function fakeDoc(overrides: Partial<ImageDoc> = {}): ImageDoc {
  return {
    _id: new ObjectId(),
    folder_id: new ObjectId(),
    filename: "test.dng",
    abs_path: "/lib/test.dng",
    // maple_id is an IndexerAssetFields extension; cast through unknown for test setup.
    ...({ maple_id: "maple-abc-123" } as unknown as Partial<ImageDoc>),
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
    description: "A red bicycle.",
    // ocr_text is on AssetDoc; cast through unknown for test setup.
    ...({ ocr_text: "BIKE SHOP" } as unknown as Partial<ImageDoc>),
    place: {
      source: "nominatim",
      geocoder_version: 1,
      geocoded_at: "2024-06-01T00:00:00.000Z",
      lat: 42.65,
      lon: -73.75,
      display_name: "Albany",
      address: {},
      pois: [],
      rollups: { locality: "Albany", region: "NY", country_code: "us" },
      search_blob: "albany ny",
    },
    stages: {},
    ...overrides,
  } as ImageDoc;
}

function capturingClient(): { client: MeilisearchClient; upserts: MeilisearchAssetDoc[] } {
  const upserts: MeilisearchAssetDoc[] = [];
  const client: MeilisearchClient = {
    isConfigured: () => true,
    health: async () => true,
    ensureIndex: async () => {},
    upsert: async (doc) => { upserts.push(doc); },
    tombstone: async () => {},
    search: async () => ({ ids: [], estimatedTotal: 0 }),
  };
  return { client, upserts };
}

function failingClient(): MeilisearchClient {
  return {
    isConfigured: () => true,
    health: async () => true,
    ensureIndex: async () => {},
    upsert: async () => { throw new Error("simulated meili failure"); },
    tombstone: async () => {},
    search: async () => ({ ids: [], estimatedTotal: 0 }),
  };
}

describe("meiliHandler — upsert payload shape", () => {
  it("upserts with correct id, folderId, capturedAt, searchBlob, description, ocrText", async () => {
    const { client, upserts } = capturingClient();
    const doc = fakeDoc();
    const result = await meiliHandler(doc, { meilisearch: client } as never);
    expect((result as { wrote: boolean }).wrote).toBe(true);
    expect(upserts.length).toBe(1);
    const u = upserts[0]!;
    expect(u.id).toBe("maple-abc-123");
    expect(u.folderId).toBe(doc.folder_id.toHexString());
    expect(u.capturedAt).toBe("2024-06-01T12:00:00.000Z");
    expect(u.deletedAt).toBeNull();
    expect(u.description).toBe("A red bicycle.");
    expect(u.ocrText).toBe("BIKE SHOP");
    // Unified blob must include tokens from all three sources.
    const tokens = u.searchBlob.split(" ");
    expect(tokens).toContain("albany");    // place
    expect(tokens).toContain("bicycle");   // description
    expect(tokens).toContain("bike");      // OCR
    expect(tokens).toContain("shop");      // OCR
    // Blob is sorted + deduped.
    expect(tokens).toEqual([...tokens].sort());
    expect(new Set(tokens).size).toBe(tokens.length);
  });
});

describe("meiliHandler — no maple_id", () => {
  it("returns { wrote: true } and skips the upsert when maple_id is absent", async () => {
    const { client, upserts } = capturingClient();
    // Override to drop maple_id — cast through unknown since it's not on ImageDoc's
    // base type (it's an IndexerAssetFields extension).
    const doc = { ...fakeDoc(), ...({ maple_id: undefined } as unknown as Partial<ImageDoc>) } as ImageDoc;
    const result = await meiliHandler(doc, { meilisearch: client } as never);
    expect((result as { wrote: boolean }).wrote).toBe(true);
    expect(upserts.length).toBe(0);
  });
});

describe("meiliHandler — Meilisearch error tolerance", () => {
  it("Meilisearch upsert failure results in handler throw so runtime retries", async () => {
    const doc = fakeDoc();
    await expect(
      meiliHandler(doc, { meilisearch: failingClient() } as never),
    ).rejects.toThrow("simulated meili failure");
  });
});

describe("meiliHandler — null enrichment fields", () => {
  it("produces a valid (possibly empty) blob when description and ocr_text are null", async () => {
    const { client, upserts } = capturingClient();
    const doc = { ...fakeDoc(), description: null, ...({ ocr_text: null } as unknown as Partial<ImageDoc>) } as ImageDoc;
    await meiliHandler(doc, { meilisearch: client } as never);
    expect(upserts.length).toBe(1);
    const blob = upserts[0]!.searchBlob;
    // Place tokens still contribute.
    expect(blob.split(" ")).toContain("albany");
  });
});
```

### Step 2: Implement the stage

Create `src/api/src/workers/stages/meili.ts`:

```ts
/**
 * Meili (search-blob) stage. Fan-in terminal stage.
 *
 * Depends on all enrichment stages. Once they are all at version >= 1, this
 * stage reads the assembled image doc and writes the unified search document
 * to Meilisearch. Returns `{ wrote: true }` — the runtime bumps
 * `stages.meili.version` but does not merge a patch into the image doc.
 *
 * Throws on Meilisearch transport error so the runtime retries. A Meilisearch
 * outage does not block enrichment stages — they complete independently.
 * Meili simply retries up to `maxAttempts` and dead-letters if Meilisearch
 * is unreachable for a sustained period.
 *
 * When `maple_id` is absent (legacy row pre-dating the indexer's mapleId
 * migration), returns `{ wrote: true }` and skips the upsert so the stage
 * completes rather than spinning forever on an un-fixable invariant violation.
 */

import type { ImageDoc, StageContext, StageResult } from "../runtime/define-stage.ts";
import { defineStage } from "../runtime/define-stage.ts";
import { meilisearchClient, type MeilisearchClient } from "../../enrichment/meilisearch-client.ts";
import { composeSearchBlob } from "../../enrichment/search-blob.ts";

export async function meiliHandler(
  image: ImageDoc,
  ctx: StageContext & { meilisearch?: MeilisearchClient },
): Promise<StageResult> {
  const client = ctx.meilisearch ?? meilisearchClient();
  const mapleId = (image as unknown as { maple_id?: string }).maple_id ?? "";
  if (mapleId.length === 0) {
    return { wrote: true };
  }
  const searchBlob = composeSearchBlob({
    place: image.place,
    description: image.description,
    ocrText: (image as unknown as { ocr_text?: string }).ocr_text ?? null,
  });
  await client.upsert({
    id: mapleId,
    searchBlob,
    description: image.description ?? null,
    ocrText: (image as unknown as { ocr_text?: string }).ocr_text ?? null,
    folderId: image.folder_id.toHexString(),
    capturedAt: image.exif?.captured_at ?? null,
    deletedAt: null,
  });
  return { wrote: true };
}

export default defineStage({
  name: "meili",
  targetVersion: 1,
  dependsOn: ["exif", "thumb", "face", "ocr", "describe", "geocode"],
  defaults: {
    concurrency: 2,
    pollIntervalMs: 1000,
    batchSize: 20,
    maxAttempts: 5,
    pausedOnFirstBoot: false,
  },
  handler: meiliHandler,
});
```

- [ ] Run `bun test src/api/src/workers/stages/meili.test.ts` — tests pass.
- [ ] Commit: `feat(api): meili stage handler — new fan-in search-blob writer`

---

## Task 6: Update manifest and supervisor wiring

**Files:**
- Modify: `src/api/src/workers/stages/manifest.ts`

### Step 1: Extend the manifest

Open `src/api/src/workers/stages/manifest.ts` (created in Plan 2). Plan 2's manifest exports:
- `ALL_STAGE_NAMES` — the authoritative string-constant array used by the discover producer to build the `stages` skeleton on every new image doc.
- `blankStagesSkeleton()` — builds a blank per-stage state record.

Plan 2 does NOT export a `StageConfig[]` array (the supervisor wired hash/exif/thumb directly). Plan 3 adds a `stageManifest` export containing all `StageConfig` objects so the supervisor can iterate them generically. Note that `discover` is a producer child (not a `defineStage` stage) and is NOT included in `stageManifest`.

Add the five new stage imports and add the new `stageManifest` export:

```ts
// Existing Plan 2 imports (hash, exif, thumb stages) remain.
import hashStage from "./hash.ts";
import exifStage from "./exif.ts";
import thumbStage from "./thumb.ts";
// Plan 3 stages:
import faceStage from "./face.ts";
import ocrStage from "./ocr.ts";
import describeStage from "./describe.ts";
import geocodeStage from "./geocode.ts";
import meiliStage from "./meili.ts";

// Export the full stage config array — the supervisor iterates this to spawn
// stage children. Discover is a producer (not a defineStage stage) and is
// wired separately by the supervisor.
export const stageManifest = [
  hashStage,
  exifStage,
  thumbStage,
  faceStage,
  ocrStage,
  describeStage,
  geocodeStage,
  meiliStage,
];
```

The supervisor in `src/api/src/index.ts` iterates `stageManifest` to spawn stage children. After this edit the supervisor will spawn eight stage children (`hash`, `exif`, `thumb`, `face`, `ocr`, `describe`, `geocode`, `meili`) plus the discover producer child — nine children total.

### Step 2: Verify the manifest compiles and all stages appear

- [ ] Run `bun run tsc --noEmit` (or equivalent type-check command) in `src/api/` — no type errors.
- [ ] Run `bun test src/api/src/workers/stages/` — all stage tests pass.

### Step 3: Verify nothing imports the deleted worker files

- [ ] Run `grep -r "face-worker\|ocr-worker\|describe-worker\|geocode-worker" src/api/src/ --include="*.ts"` — zero results (confirming all imports are gone after the deletions in Tasks 1–4).

- [ ] Commit: `feat(api): manifest + supervisor wire-up for face/ocr/describe/geocode/meili stages`

---

## Task 7: Full test suite verification and cleanup

**Files:** no new files.

- [ ] Run `bun test src/api/` — full test suite. Confirm:
  - All five new stage handler test files pass.
  - `circuit-breaker.test.ts`, `coordinate-cache.test.ts`, `nominatim-client.test.ts`, `place-parser.test.ts`, `search-blob.test.ts`, `meilisearch-client.test.ts` still pass (retained utility modules unchanged).
  - No test references a deleted file.
- [ ] Run `grep -r "face-worker\|ocr-worker\|describe-worker\|geocode-worker" src/api/ --include="*.ts"` — zero results.
- [ ] Run `grep -r "FaceWorker\|OcrWorker\|DescribeWorker\|GeocodeWorker" src/api/ --include="*.ts"` — zero results. (Class names from the bespoke workers are gone; the new stages export plain functions.)
- [ ] Commit: `chore(api): verify enrichment cutover — all tests pass, no stale references`

---

## Retained files (do not delete)

The following files in `src/api/src/enrichment/` are unchanged and must remain:

| File | Reason |
|---|---|
| `circuit-breaker.ts` / `.test.ts` | Utility used by handlers if needed; runtime may use it too. |
| `dead-letter.repo.ts` | Utility; handlers may reference for manual dead-letter writes. |
| `coordinate-cache.ts` / `.test.ts` | Injected into geocode handler. |
| `face-detector.ts` | Called by face handler. |
| `face-models.ts` / `.test.ts` | Loaded by face-detector. |
| `ocr-engine.ts` / `.test.ts` | Called by OCR handler. |
| `meilisearch-client.ts` / `.test.ts` | Called by meili handler. |
| `nominatim-client.ts` / `.test.ts` | Called by geocode handler. |
| `place-parser.ts` / `.test.ts` | Called by geocode handler. |
| `search-blob.ts` / `.test.ts` | Called by meili handler. |
| `face-bootstrap.ts` | Lifecycle/setup module, not a worker. |
| `ocr-bootstrap.ts` | Lifecycle/setup module, not a worker. |
| `describe-bootstrap.ts` | Lifecycle/setup module, not a worker. |
| `bootstrap.ts` | Top-level enrichment bootstrap; wires lifecycle modules. |
| `enrichment-config.repo.ts` / `.test.ts` | Config storage; may overlap with `worker_config` but consolidation is out of scope for Plan 3. |
| `describe-spend.repo.ts` | Daily spend tracker; will be wired into the runtime for the describe stage in a future iteration. |
| `describe-providers/` (all files) | Provider implementations called by the describe handler. |
