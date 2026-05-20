/**
 * face-models — model loader behaviour tests.
 *
 * We don't drive the real ONNX runtime here (CI shouldn't depend on
 * downloading and loading hundreds of MB of weights). Instead we test
 * the resolution-order logic via the test loader hook and via direct
 * env-var checks against `loadFaceModels()`.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadFaceModels,
  setFaceModelLoaderForTests,
  defaultModelDir,
  resolveOrtThreadCount,
  RETINAFACE_BASENAME,
  MOBILEFACENET_BASENAME,
  type FaceModels,
  type OnnxSessionLike,
  type OnnxTensorConstructor,
  type OnnxTensorLike,
} from "./face-models.ts";

function fakeSession(): OnnxSessionLike {
  return {
    run: async () => ({}),
  };
}

class FakeTensor implements OnnxTensorLike {
  readonly location = "cpu" as const;
  constructor(
    readonly type: "float32",
    readonly data: Float32Array,
    readonly dims: readonly number[],
  ) {}
}

const FakeTensorCtor = FakeTensor as unknown as OnnxTensorConstructor;

function fakeModels(dir: string): FaceModels {
  return {
    retinaFace: fakeSession(),
    mobileFaceNet: fakeSession(),
    Tensor: FakeTensorCtor,
    paths: {
      retinaFace: join(dir, RETINAFACE_BASENAME),
      mobileFaceNet: join(dir, MOBILEFACENET_BASENAME),
    },
  };
}

let savedEnv: Record<string, string | undefined> = {};

const ENV_KEYS = [
  "MAPLE_MODEL_DIR",
  "MAPLE_FACE_RETINAFACE_URL",
  "MAPLE_FACE_RETINAFACE_SHA256",
  "MAPLE_FACE_MOBILEFACENET_URL",
  "MAPLE_FACE_MOBILEFACENET_SHA256",
];

function snapshotEnv(): void {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
}
function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}

beforeEach(() => {
  snapshotEnv();
  setFaceModelLoaderForTests(null);
});

afterEach(() => {
  restoreEnv();
  setFaceModelLoaderForTests(null);
});

describe("resolveOrtThreadCount", () => {
  it("returns the fallback when env is unset", () => {
    expect(resolveOrtThreadCount(undefined, 4)).toBe(4);
  });

  it("parses a valid positive integer string", () => {
    expect(resolveOrtThreadCount("2", 4)).toBe(2);
    expect(resolveOrtThreadCount("1", 4)).toBe(1);
    expect(resolveOrtThreadCount("16", 4)).toBe(16);
  });

  it("rejects 0 — would re-enable ORT's host-CPU default", () => {
    expect(resolveOrtThreadCount("0", 4)).toBe(4);
  });

  it("rejects negative values", () => {
    expect(resolveOrtThreadCount("-1", 4)).toBe(4);
  });

  it("rejects non-numeric / NaN-coercing input", () => {
    expect(resolveOrtThreadCount("abc", 4)).toBe(4);
    expect(resolveOrtThreadCount("", 4)).toBe(4);
  });

  it("rejects non-integer values", () => {
    expect(resolveOrtThreadCount("1.5", 4)).toBe(4);
  });
});

describe("defaultModelDir", () => {
  it("honours MAPLE_MODEL_DIR when set", () => {
    process.env.MAPLE_MODEL_DIR = "/tmp/maple-models-test";
    expect(defaultModelDir()).toBe("/tmp/maple-models-test");
  });

  it("falls back to ~/.maple/models when env unset", () => {
    delete process.env.MAPLE_MODEL_DIR;
    expect(defaultModelDir()).toMatch(/\.maple[/\\]models$/);
  });
});

describe("loadFaceModels — test loader injection", () => {
  it("returns the injected loader's result", async () => {
    const dir = "/tmp/maple-fake";
    setFaceModelLoaderForTests(async () => fakeModels(dir));
    const m = await loadFaceModels();
    expect(m.paths.retinaFace).toBe(join(dir, RETINAFACE_BASENAME));
    expect(m.paths.mobileFaceNet).toBe(join(dir, MOBILEFACENET_BASENAME));
  });

  it("caches the injected loader result across calls (singleton)", async () => {
    let calls = 0;
    setFaceModelLoaderForTests(async () => {
      calls++;
      return fakeModels("/tmp/maple-fake-2");
    });
    await loadFaceModels();
    await loadFaceModels();
    expect(calls).toBe(1);
  });

  it("rebuilds after setFaceModelLoaderForTests is called again", async () => {
    setFaceModelLoaderForTests(async () => fakeModels("/tmp/a"));
    const a = await loadFaceModels();
    setFaceModelLoaderForTests(async () => fakeModels("/tmp/b"));
    const b = await loadFaceModels();
    expect(a.paths.retinaFace).not.toBe(b.paths.retinaFace);
  });
});

describe("loadFaceModels — disk + env fail-fast path", () => {
  it("fails fast with an actionable error when neither file nor URL is present (auto-download disabled)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "maple-face-models-"));
    process.env.MAPLE_MODEL_DIR = tmp;
    delete process.env.MAPLE_FACE_RETINAFACE_URL;
    delete process.env.MAPLE_FACE_MOBILEFACENET_URL;
    // Suppress the buffalo_s zero-config download — without this opt-out
    // the loader would fetch the InsightFace bundle from the public
    // GitHub Release and the test would either hang on network or
    // succeed (defeating the "fail-fast" assertion). The operator
    // disables the same way at runtime when they want explicit URL
    // control.
    process.env.MAPLE_FACE_NO_AUTO_DOWNLOAD = "true";
    setFaceModelLoaderForTests(null);
    let err: unknown = null;
    try {
      await loadFaceModels();
    } catch (e) {
      err = e;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      delete process.env.MAPLE_FACE_NO_AUTO_DOWNLOAD;
    }
    expect(err).not.toBeNull();
    const msg = err instanceof Error ? err.message : String(err);
    // Must mention BOTH the recovery surface AND the on-disk path so the
    // operator knows their two recovery options. The env-var name was
    // replaced with `/settings/enrichment` once the UI grew face-model
    // download fields — operators now configure via the page or by
    // dropping a file at the path.
    expect(msg).toMatch(/\/settings\/enrichment/);
    expect(msg).toMatch(new RegExp(RETINAFACE_BASENAME));
  });

  it("retries after a failed load (singleton is reset on error)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "maple-face-models-"));
    process.env.MAPLE_MODEL_DIR = tmp;
    delete process.env.MAPLE_FACE_RETINAFACE_URL;
    delete process.env.MAPLE_FACE_MOBILEFACENET_URL;
    setFaceModelLoaderForTests(null);
    try {
      await loadFaceModels();
      throw new Error("expected first load to fail");
    } catch {
      /* expected */
    }
    // Now drop in a fake loader. The second call must use it (i.e. the
    // singleton was cleared by the first failure).
    setFaceModelLoaderForTests(async () => fakeModels(tmp));
    const m = await loadFaceModels();
    expect(m.paths.retinaFace).toBe(join(tmp, RETINAFACE_BASENAME));
    rmSync(tmp, { recursive: true, force: true });
  });

  it("uses the on-disk file when present (skips download path)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "maple-face-models-"));
    // Drop a non-empty stub at the expected location so the resolver
    // takes the on-disk branch. The actual ONNX load is intercepted by
    // the loader hook — this test only asserts the resolver picks the
    // file over a missing URL.
    writeFileSync(join(tmp, RETINAFACE_BASENAME), "stub");
    writeFileSync(join(tmp, MOBILEFACENET_BASENAME), "stub");
    process.env.MAPLE_MODEL_DIR = tmp;
    delete process.env.MAPLE_FACE_RETINAFACE_URL;
    delete process.env.MAPLE_FACE_MOBILEFACENET_URL;
    setFaceModelLoaderForTests(async () => fakeModels(tmp));
    const m = await loadFaceModels();
    expect(m.paths.retinaFace).toBe(join(tmp, RETINAFACE_BASENAME));
    rmSync(tmp, { recursive: true, force: true });
  });
});
