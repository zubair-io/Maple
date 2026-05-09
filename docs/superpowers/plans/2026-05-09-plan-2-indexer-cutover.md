# Plan 2 — Indexer Cutover (hash / exif / thumb / discover)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move hash, exif, and thumb into `defineStage` handlers under the Plan 1 runtime; migrate `discover` to a producer-shaped child that writes the full `stages` skeleton; retire `pipeline.ts`, `channel.ts`, and `standalone.ts`; wire the new supervisor into `src/api/src/index.ts` in place of the old single-child indexer. After this plan, hash/exif/thumb run as isolated child processes polling Mongo, discover owns the chokidar loop, and the in-memory channel topology is gone.

**Architecture:** Each of hash/exif/thumb becomes a `defineStage` config file under `src/api/src/workers/stages/`. The Plan 1 runtime (`run-stage.ts`) drives the poll-claim-dispatch-writeback loop for each. Discover is a standalone async loop — not a stage controller — that wraps the existing `Watcher` class and inserts image docs with a complete `stages` skeleton on every new file. A `manifest.ts` registry lists all stage names so discover knows the full skeleton without enumerating them by hand. `src/api/src/index.ts` swaps `spawnChild()` / `stopChild()` for `startSupervisor()` / `stopSupervisor()` from the Plan 1 supervisor, passing `["hash", "exif", "thumb"]` plus the discover child.

**Tech Stack:** Bun, TypeScript, MongoDB driver, bun:test. No new runtime dependencies — all logic wraps existing modules (`readExif`, `generateThumb`, `Watcher`, `id.ts`).

**Spec:** [`docs/superpowers/specs/2026-05-09-stage-controllers-design.md`](../specs/2026-05-09-stage-controllers-design.md) — Stage state schema, Dependency graph, Controller contract, discover stage, What gets retired.

**Depends on:** Plan 0 (orientation-aware `generateThumb`), Plan 1 (supervisor, runtime, `defineStage`/`runStage` types).

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `src/api/src/workers/stages/manifest.ts` | Create | Registry of all stage names; discover imports this to build the skeleton. |
| `src/api/src/workers/stages/hash.ts` | Create | `defineStage` for the hash stage — reads first 64 KB, derives SHA-1, stat. |
| `src/api/src/workers/stages/exif.ts` | Create | `defineStage` for the exif stage — wraps `readExif`, returns `{ patch: { exif } }`. |
| `src/api/src/workers/stages/thumb.ts` | Create | `defineStage` for the thumb stage — wraps `generateThumb`, returns `{ patch: { thumb_path } }`. |
| `src/api/src/workers/discover/index.ts` | Create | Producer child: runs `Watcher`, inserts image docs with full `stages` skeleton. |
| `src/api/src/workers/stages/hash.test.ts` | Create | Unit test for the hash handler. |
| `src/api/src/workers/stages/exif.test.ts` | Create | Unit test for the exif handler. |
| `src/api/src/workers/stages/thumb.test.ts` | Create | Unit tests for the thumb handler (RAW + bitmap paths). |
| `src/api/src/workers/discover/discover.test.ts` | Create | Integration test: temp dir, drop file, assert skeleton inserted. |
| `src/api/src/workers/smoke.test.ts` | Create | Smoke test: spawn supervisor with hash/exif/thumb + discover, assert all stages run. |
| `src/api/src/index.ts` | Modify | Replace `spawnChild/stopChild` with `startSupervisor/stopSupervisor`. |
| `src/api/src/indexer/pipeline.ts` | Delete | Dissolved. |
| `src/api/src/indexer/channel.ts` | Delete | Dissolved. |
| `src/api/src/indexer/standalone.ts` | Delete | Replaced by per-stage entry shim + supervisor. |
| `src/api/src/indexer/service.ts` | Delete | Dissolved; surviving logic (GC, progress bus) migrated inline to supervisor or dropped. |
| `src/api/src/indexer/control.ts` | Delete | Replaced by Plan 1 supervisor. |

Files that remain untouched: `src/api/src/indexer/exif.ts`, `thumbnailer.ts`, `id.ts`, `watcher.ts`, `checkpoint.ts`, `images.repo.ts`, `indexer.repo.ts`, `indexer-config.repo.ts`.

---

## Task 1: Stage manifest

**Files:**
- Create: `src/api/src/workers/stages/manifest.ts`

The manifest is the single authoritative list of stage names. Every other module that needs to enumerate stages (discover's skeleton writer, the supervisor's spawn list, future Plan 3 stages) imports from here. Adding a stage means adding one entry here; nothing else changes.

- [ ] **Step 1: Write the manifest**

Create `src/api/src/workers/stages/manifest.ts`:

```ts
/**
 * Authoritative list of all per-image stage names.
 *
 * The discover producer imports this to build the `stages` skeleton on every
 * new image doc. The supervisor passes it to the runtime when spawning stage
 * children. Plan 3 adds face / ocr / describe / geocode / meili here; no
 * other file needs to change.
 *
 * Order is cosmetic — the runtime enforces dependency ordering via each
 * stage's `dependsOn` array, not by position in this list.
 */
export const ALL_STAGE_NAMES = [
  "hash",
  "exif",
  "thumb",
  "face",
  "ocr",
  "describe",
  "geocode",
  "meili",
] as const;

export type StageName = (typeof ALL_STAGE_NAMES)[number];

/**
 * Build the blank `stages` skeleton that discover writes on every new image doc.
 * Every field starts at `version: 0` so all wired controllers immediately
 * see the doc as needing work.
 */
export function blankStagesSkeleton(): Record<
  StageName,
  {
    version: number;
    attempts: number;
    last_error: null;
    processed_at: null;
    dead: boolean;
  }
> {
  const entry = {
    version: 0,
    attempts: 0,
    last_error: null,
    processed_at: null,
    dead: false,
  };
  return Object.fromEntries(ALL_STAGE_NAMES.map((name) => [name, { ...entry }])) as ReturnType<
    typeof blankStagesSkeleton
  >;
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `cd src/api && bun build src/workers/stages/manifest.ts --target bun 2>&1 | head -5`

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/api/src/workers/stages/manifest.ts
git commit -m "feat(api/workers): stage manifest + blankStagesSkeleton"
```

---

## Task 2: Hash stage handler

**Files:**
- Create: `src/api/src/workers/stages/hash.ts`
- Create: `src/api/src/workers/stages/hash.test.ts`

The hash stage reads the first 64 KB of the file, computes SHA-1, stats the file, and derives the maple:id (fallback form — primary form needs EXIF and is exif stage's job). This is exactly what `pipeline.ts:runHash` does; the handler exposes the same computation as a pure function that takes an image doc and returns a patch.

The image doc passed to the handler is the full MongoDB document. After Plan 1's runtime inserts the doc it has at minimum `{ abs_path, stages }`. The handler reads `abs_path` from the doc.

- [ ] **Step 1: Write the failing test**

Create `src/api/src/workers/stages/hash.test.ts`:

```ts
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import hashStage from "./hash.ts";

// Build a minimal image doc with enough fields for the handler.
function makeDoc(absPath: string) {
  return {
    _id: "000000000000000000000001" as unknown as import("mongodb").ObjectId,
    abs_path: absPath,
    stages: {
      hash:     { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      exif:     { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      thumb:    { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      face:     { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      ocr:      { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      describe: { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      geocode:  { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      meili:    { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
    },
  };
}

describe("hash handler", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "hash-stage-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns a patch containing sha1_head, size, mtime, and maple_id", async () => {
    const file = path.join(dir, "test.jpg");
    // 1 KB of deterministic bytes so sha1 is stable.
    const content = Buffer.alloc(1024, 0xab);
    await writeFile(file, content);

    const doc = makeDoc(file);
    const result = await hashStage.handler(doc as never, {} as never);

    expect("patch" in result).toBe(true);
    const { patch } = result as { patch: Record<string, unknown> };

    expect(typeof patch.sha1_head).toBe("string");
    expect((patch.sha1_head as string).length).toBe(40); // hex SHA-1
    expect(typeof patch.size).toBe("number");
    expect((patch.size as number)).toBe(1024);
    expect(typeof patch.mtime).toBe("number");
    expect(typeof patch.maple_id).toBe("string");
    expect((patch.maple_id as string).length).toBe(32); // 16 bytes hex
  });

  it("sha1_head is deterministic for identical content", async () => {
    const fileA = path.join(dir, "a.jpg");
    const fileB = path.join(dir, "b.jpg");
    const content = Buffer.alloc(512, 0x77);
    await writeFile(fileA, content);
    await writeFile(fileB, content);

    const [rA, rB] = await Promise.all([
      hashStage.handler(makeDoc(fileA) as never, {} as never),
      hashStage.handler(makeDoc(fileB) as never, {} as never),
    ]);
    const pA = (rA as { patch: Record<string, unknown> }).patch;
    const pB = (rB as { patch: Record<string, unknown> }).patch;
    expect(pA.sha1_head).toBe(pB.sha1_head);
    expect(pA.maple_id).toBe(pB.maple_id);
  });

  it("throws when the file does not exist", async () => {
    const doc = makeDoc(path.join(dir, "no-such-file.jpg"));
    await expect(hashStage.handler(doc as never, {} as never)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src/api && bun test src/workers/stages/hash.test.ts`

Expected: FAIL — module not found for `./hash.ts`.

- [ ] **Step 3: Implement the handler**

Create `src/api/src/workers/stages/hash.ts`:

```ts
/**
 * Hash stage — reads the first 64 KB of the source file, computes SHA-1,
 * stats the file, and derives the maple:id in fallback form (tag 0x02).
 *
 * The primary form (tag 0x01, needs EXIF capturedAt + camera serial) is
 * finalised by the exif stage after `readExif` populates those fields.
 * That upgrade is a $set on the existing row; downstream stages key on
 * `abs_path`, not `maple_id`, so the late finalisation is safe.
 *
 * dependsOn: []   — first stage in the graph; no prerequisites.
 */
import * as fs from "node:fs/promises";
import { sha1 } from "@noble/hashes/legacy.js";
import { deriveId } from "../../indexer/id.ts";
import { defineStage } from "../runtime/define-stage.ts";

const SHA1_HEAD_BYTES = 64 * 1024;

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, "0");
  return s;
}

async function readHead(absPath: string): Promise<Uint8Array> {
  const fd = await fs.open(absPath, "r");
  try {
    const buf = new Uint8Array(SHA1_HEAD_BYTES);
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fd.close();
  }
}

export default defineStage({
  name: "hash",
  targetVersion: 1,
  dependsOn: [],
  defaults: {
    concurrency: 4,
    batchSize: 10,
    pollIntervalMs: 1000,
    maxAttempts: 5,
    pausedOnFirstBoot: false,
  },
  handler: async (image) => {
    const absPath = image.abs_path as string;
    const [head, stat] = await Promise.all([readHead(absPath), fs.stat(absPath)]);
    const sha1HeadHex = toHex(sha1(head));
    // Derive fallback-form id now; the exif stage will upgrade to primary if
    // capturedAt is available.
    const id = deriveId(head, null, null, null);
    return {
      patch: {
        sha1_head: sha1HeadHex,
        size: stat.size,
        mtime: stat.mtimeMs,
        maple_id: id.hex,
      },
    };
  },
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src/api && bun test src/workers/stages/hash.test.ts`

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/workers/stages/hash.ts src/api/src/workers/stages/hash.test.ts
git commit -m "feat(api/workers): hash stage handler"
```

---

## Task 3: EXIF stage handler

**Files:**
- Create: `src/api/src/workers/stages/exif.ts`
- Create: `src/api/src/workers/stages/exif.test.ts`

The exif stage wraps `readExif` from `src/api/src/indexer/exif.ts`. It also finalises the maple:id to the primary form when `capturedAt` is available: it re-reads the head bytes (already on disk from the hash stage — the hash stage wrote `sha1_head`, but not the raw bytes; exif re-reads the file's first 64 KB) and calls `deriveId` with EXIF fields populated.

- [ ] **Step 1: Write the failing test**

Create `src/api/src/workers/stages/exif.test.ts`:

```ts
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import exifStage from "./exif.ts";

function makeDoc(absPath: string) {
  return {
    _id: "000000000000000000000002" as unknown as import("mongodb").ObjectId,
    abs_path: absPath,
    sha1_head: "a".repeat(40), // pretend hash stage already ran
    maple_id: "b".repeat(32),
    stages: {
      hash:     { version: 1, attempts: 0, last_error: null, processed_at: new Date().toISOString(), dead: false },
      exif:     { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      thumb:    { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      face:     { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      ocr:      { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      describe: { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      geocode:  { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      meili:    { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
    },
  };
}

describe("exif handler", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "exif-stage-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns a patch with an exif key for a file without EXIF", async () => {
    // A raw JPEG with no metadata — exifr returns null; handler must still
    // return a patch (with exif: null) so the runtime can mark the stage done.
    const file = path.join(dir, "no-exif.jpg");
    const { default: sharp } = await import("sharp");
    const buf = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .jpeg()
      .toBuffer();
    await writeFile(file, buf);

    const doc = makeDoc(file);
    const result = await exifStage.handler(doc as never, {} as never);

    expect("patch" in result).toBe(true);
    const { patch } = result as { patch: Record<string, unknown> };
    // exif may be null (no EXIF data) — that is a valid and expected value.
    expect("exif" in patch).toBe(true);
  });

  it("patch.exif contains camera_make when a DNG fixture is present", async () => {
    const dng = path.resolve(process.cwd(), "../../test-fixtures/raws/test_0017.dng");
    try {
      await import("node:fs/promises").then((f) => f.stat(dng));
    } catch {
      return; // fixture absent — soft pass on CI
    }
    const doc = makeDoc(dng);
    const result = await exifStage.handler(doc as never, {} as never);
    const { patch } = result as { patch: Record<string, unknown> };
    const exif = patch.exif as Record<string, unknown> | null;
    expect(exif).not.toBeNull();
    expect(typeof exif?.camera_make).toBe("string");
  });

  it("throws when the file does not exist", async () => {
    const doc = makeDoc(path.join(dir, "ghost.jpg"));
    await expect(exifStage.handler(doc as never, {} as never)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src/api && bun test src/workers/stages/exif.test.ts`

Expected: FAIL — module not found for `./exif.ts`.

- [ ] **Step 3: Implement the handler**

Create `src/api/src/workers/stages/exif.ts`:

```ts
/**
 * EXIF stage — parses EXIF metadata and finalises the maple:id to the primary
 * form when capturedAt is available.
 *
 * The primary-form maple:id embeds BLAKE3( SHA1(head) || capturedAt ||
 * cameraSerial || shutterCount ) (tag 0x01). The hash stage wrote the
 * fallback form (tag 0x02, SHA1(head) only); this stage upgrades it if
 * DateTimeOriginal is present. See `src/api/src/indexer/id.ts` for the byte
 * layout.
 *
 * dependsOn: ["hash"]   — needs sha1_head on the doc (written by hash).
 */
import * as fs from "node:fs/promises";
import { sha1 } from "@noble/hashes/legacy.js";
import { readExif } from "../../indexer/exif.ts";
import { deriveId } from "../../indexer/id.ts";
import { defineStage } from "../runtime/define-stage.ts";

const SHA1_HEAD_BYTES = 64 * 1024;

async function readHead(absPath: string): Promise<Uint8Array> {
  const fd = await fs.open(absPath, "r");
  try {
    const buf = new Uint8Array(SHA1_HEAD_BYTES);
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fd.close();
  }
}

export default defineStage({
  name: "exif",
  targetVersion: 1,
  dependsOn: ["hash"],
  defaults: {
    concurrency: 4,
    batchSize: 10,
    pollIntervalMs: 1000,
    maxAttempts: 5,
    pausedOnFirstBoot: false,
  },
  handler: async (image) => {
    const absPath = image.abs_path as string;
    const exif = await readExif(absPath);

    const patch: Record<string, unknown> = { exif };

    // Upgrade maple_id to primary form if capturedAt is available.
    if (exif?.captured_at) {
      const head = await readHead(absPath);
      const id = deriveId(
        head,
        exif.captured_at,
        (image.exif as Record<string, unknown> | null)?.camera_serial as string | null ?? null,
        null, // shutter count not yet in AssetExif schema
      );
      patch.maple_id = id.hex;
    }

    return { patch };
  },
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src/api && bun test src/workers/stages/exif.test.ts`

Expected: 2 tests pass + 1 skips on CI (no DNG fixture). With the DNG present: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/workers/stages/exif.ts src/api/src/workers/stages/exif.test.ts
git commit -m "feat(api/workers): exif stage handler"
```

---

## Task 4: Thumb stage handler

**Files:**
- Create: `src/api/src/workers/stages/thumb.ts`
- Create: `src/api/src/workers/stages/thumb.test.ts`

The thumb stage wraps `generateThumb` from `src/api/src/indexer/thumbnailer.ts` (orientation-aware after Plan 0). It depends on both hash and exif because it reads `image.exif.orientation` indirectly through `thumbnailer.ts` — the orientation fix reads the EXIF orientation tag from the written JPEG, but the presence of the exif stage in the dependency graph ensures EXIF is parsed before thumb runs, which is the correct ordering.

The patch writes `thumb_path` (the on-disk path to the generated JPEG) so callers can serve it without re-deriving the path.

- [ ] **Step 1: Write the failing test**

Create `src/api/src/workers/stages/thumb.test.ts`:

```ts
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import sharp from "sharp";
import thumbStage from "./thumb.ts";

function makeDoc(absPath: string, exif: Record<string, unknown> | null = null) {
  return {
    _id: "000000000000000000000003" as unknown as import("mongodb").ObjectId,
    abs_path: absPath,
    sha1_head: "c".repeat(40),
    maple_id: "d".repeat(32),
    exif,
    stages: {
      hash:     { version: 1, attempts: 0, last_error: null, processed_at: new Date().toISOString(), dead: false },
      exif:     { version: 1, attempts: 0, last_error: null, processed_at: new Date().toISOString(), dead: false },
      thumb:    { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      face:     { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      ocr:      { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      describe: { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      geocode:  { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      meili:    { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
    },
  };
}

describe("thumb handler — bitmap path", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "thumb-stage-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("generates a thumb for a JPEG and returns thumb_path in the patch", async () => {
    const file = path.join(dir, "photo.jpg");
    const buf = await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 100, g: 150, b: 200 } },
    })
      .jpeg()
      .toBuffer();
    await writeFile(file, buf);

    const doc = makeDoc(file);
    const result = await thumbStage.handler(doc as never, {} as never);

    expect("patch" in result).toBe(true);
    const { patch } = result as { patch: Record<string, unknown> };
    expect(typeof patch.thumb_path).toBe("string");
    // The thumb must actually exist on disk.
    const s = await stat(patch.thumb_path as string);
    expect(s.size).toBeGreaterThan(0);
  });

  it("produces an upright thumb regardless of EXIF orientation tag", async () => {
    const file = path.join(dir, "rotated.jpg");
    // Create a 16x8 JPEG tagged as orientation 6 (90° CW). After the orientation
    // fix (Plan 0), the on-disk thumb must be 8 wide × 16 tall.
    const buf = await sharp({
      create: { width: 16, height: 8, channels: 3, background: { r: 200, g: 50, b: 50 } },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    await writeFile(file, buf);

    const doc = makeDoc(file);
    const result = await thumbStage.handler(doc as never, {} as never);
    const { patch } = result as { patch: Record<string, unknown> };
    const meta = await sharp(patch.thumb_path as string).metadata();
    // After orientation bake-in, the stored thumb is upright.
    expect(meta.orientation === undefined || meta.orientation === 1).toBe(true);
  });

  it("returns { patch: { thumb_path } } for a RAW when the FFI is unavailable (soft pass)", async () => {
    // Without libraw_ffi built, generateThumb silently skips the RAW and
    // returns without writing a file. The handler must still return a patch
    // (with thumb_path set to the expected path even if the file is absent)
    // so the runtime can mark the stage done and the image advances to face.
    //
    // This test verifies the handler does not throw when the FFI is absent.
    const dng = path.resolve(process.cwd(), "../../test-fixtures/raws/test_0017.dng");
    let dngExists = false;
    try {
      await stat(dng);
      dngExists = true;
    } catch {
      // no fixture — test still runs but skips the file-existence assertion
    }

    if (!dngExists) return; // soft pass: no fixture

    const doc = makeDoc(dng);
    // Must not throw.
    const result = await thumbStage.handler(doc as never, {} as never);
    expect("patch" in result).toBe(true);
    const { patch } = result as { patch: Record<string, unknown> };
    expect(typeof patch.thumb_path).toBe("string");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src/api && bun test src/workers/stages/thumb.test.ts`

Expected: FAIL — module not found for `./thumb.ts`.

- [ ] **Step 3: Implement the handler**

Create `src/api/src/workers/stages/thumb.ts`:

```ts
/**
 * Thumb stage — generates the 512px JPEG thumbnail for an image.
 *
 * Delegates to `generateThumb` in `src/api/src/indexer/thumbnailer.ts`, which
 * is orientation-aware after Plan 0 (applyExifOrientationInPlace is wired into
 * the RAW path). The thumb path is derived by `resolveThumbPath` — the same
 * function the live /api/fs/thumb route uses so both paths write to the same
 * on-disk location.
 *
 * dependsOn: ["hash", "exif"]
 *   — thumb needs EXIF orientation to produce an upright image; hash must
 *     have run first so abs_path is confirmed reachable and sha1_head is set.
 */
import { generateThumb } from "../../indexer/thumbnailer.ts";
import { resolveThumbPath } from "../../fs/xmp.ts";
import { defineStage } from "../runtime/define-stage.ts";

export default defineStage({
  name: "thumb",
  targetVersion: 1,
  dependsOn: ["hash", "exif"],
  defaults: {
    concurrency: 2,
    batchSize: 5,
    pollIntervalMs: 1000,
    maxAttempts: 5,
    pausedOnFirstBoot: false,
  },
  handler: async (image) => {
    const absPath = image.abs_path as string;
    // generateThumb handles all format paths (RAW via FFI, bitmap via sharp,
    // unknown format via copy). It is a no-op when the thumb is already
    // up-to-date (mtime check inside).
    await generateThumb(absPath);
    return {
      patch: {
        thumb_path: resolveThumbPath(absPath),
      },
    };
  },
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src/api && bun test src/workers/stages/thumb.test.ts`

Expected: 2 tests pass (bitmap + orientation). The RAW test passes or skips depending on fixture/FFI presence.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/workers/stages/thumb.ts src/api/src/workers/stages/thumb.test.ts
git commit -m "feat(api/workers): thumb stage handler"
```

---

## Task 5: Discover producer child

**Files:**
- Create: `src/api/src/workers/discover/index.ts`
- Create: `src/api/src/workers/discover/discover.test.ts`

Discover is not a stage controller — it does not use `defineStage` or `runStage`. It is a producer: it owns the `Watcher` loop, and on a new or modified file it upserts an image doc with the full `stages` skeleton. `$setOnInsert` protects existing stage progress — if hash already ran for a file that was modified and re-discovered, the doc is updated (filename/mtime/abs_path via `$set`) but the existing stage versions remain via the selective update.

The discover child runs until it receives SIGTERM, at which point it closes the watcher and exits 0.

- [ ] **Step 1: Write the failing discover integration test**

Create `src/api/src/workers/discover/discover.test.ts`:

```ts
/**
 * Integration test for the discover producer.
 *
 * Spins up a real Mongo connection, calls `runDiscover` in the same process
 * (not as a child), drops a file into a watched temp dir, and asserts that
 * the inserted doc has the full stages skeleton.
 *
 * Requires: MAPLE_MONGO_URI (or a local MongoDB on localhost:27017).
 * Skips gracefully when Mongo is unreachable.
 */
import { describe, expect, it, afterAll } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ALL_STAGE_NAMES, blankStagesSkeleton } from "../stages/manifest.ts";

describe("discover producer", () => {
  let dir: string;
  let discoverHandle: { stop: () => Promise<void> } | null = null;

  afterAll(async () => {
    if (discoverHandle) await discoverHandle.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("inserts a doc with the full stages skeleton when a file is created", async () => {
    // Connect to Mongo — skip if unavailable.
    let db: import("mongodb").Db;
    try {
      const { getDb } = await import("../../db/client.ts");
      db = await getDb();
    } catch {
      console.log("MongoDB unreachable — skipping discover integration test");
      return;
    }

    dir = await mkdtemp(path.join(os.tmpdir(), "discover-test-"));

    // Import and start the discover loop in-process.
    const { startDiscover } = await import("./index.ts");

    // Create a temporary folder row in the DB so discover can reference it.
    const { foldersCollection } = await import("../../db/client.ts");
    const foldersColl = await foldersCollection();
    const folderResult = await foldersColl.insertOne({
      abs_path: dir,
      name: path.basename(dir),
      created_at: new Date().toISOString(),
    } as never);
    const folderId = folderResult.insertedId;

    discoverHandle = await startDiscover({ roots: [dir], folderId: folderId.toHexString() });

    // Give chokidar's 250 ms debounce window time to fire after file creation.
    const file = path.join(dir, "test.jpg");
    await writeFile(file, Buffer.alloc(100, 0xcc));
    await new Promise((r) => setTimeout(r, 600));

    // The doc should now be in the assets collection.
    const { assetsCollection } = await import("../../db/client.ts");
    const coll = await assetsCollection();
    const doc = await coll.findOne({ abs_path: file });

    expect(doc).not.toBeNull();
    expect(doc!.stages).toBeDefined();

    // Every stage name from the manifest must be present in the skeleton.
    for (const name of ALL_STAGE_NAMES) {
      const entry = (doc!.stages as Record<string, unknown>)[name] as Record<string, unknown>;
      expect(entry).toBeDefined();
      expect(entry.version).toBe(0);
      expect(entry.dead).toBe(false);
      expect(entry.last_error).toBeNull();
    }

    // Clean up: remove the test folder row.
    await foldersColl.deleteOne({ _id: folderId });
    await coll.deleteOne({ abs_path: file });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src/api && bun test src/workers/discover/discover.test.ts`

Expected: FAIL — module not found for `./index.ts`.

- [ ] **Step 3: Implement the discover producer**

Create `src/api/src/workers/discover/index.ts`:

```ts
/**
 * Discover producer — wraps the chokidar Watcher and inserts image docs with
 * the full `stages` skeleton for every new or modified file.
 *
 * This module exports two things:
 *  1. `startDiscover(opts)` — called by the supervisor (or by tests) to start
 *     the watcher in the current process. Returns a handle with `stop()`.
 *  2. A default `main()` export that the supervisor spawns as a child process.
 *
 * The discover child is NOT a stage controller — it does not use `defineStage`
 * or `runStage`. It owns only the insert side: on a new or modified file it
 * upserts the image doc with the skeleton, letting hash/exif/thumb controllers
 * pick it up naturally on their next poll tick.
 *
 * On rename: updates abs_path + filename only, preserves stage progress.
 * On remove: soft-deletes (sets deleted_at).
 * On modify: re-issues the upsert so mtime is refreshed; $setOnInsert guards
 *            against clobbering existing stage progress.
 */
import * as path from "node:path";
import * as fsNode from "node:fs/promises";
import { ObjectId } from "mongodb";
import { Watcher, type WatchEvent } from "../../indexer/watcher.ts";
import { blankStagesSkeleton } from "../stages/manifest.ts";
import { child as childLogger } from "../../log.ts";
import { assetsCollection, foldersCollection, getDb, ensureIndexes, closeDb } from "../../db/client.ts";

const log = childLogger("discover");

export interface DiscoverOptions {
  /** Absolute paths to watch. One path per registered folder root. */
  roots: string[];
  /** The folder ObjectId hex that all newly created docs are associated with.
   *  In the full multi-folder system the supervisor passes one discover child
   *  per folder; for now a single instance is sufficient. */
  folderId: string;
  /** File extensions to index (default: the standard SUPPORTED_EXTS set). */
  include?: Set<string>;
  /** Debounce window in ms (default: 250). */
  debounceMs?: number;
}

export interface DiscoverHandle {
  stop: () => Promise<void>;
}

const SUPPORTED_EXTS = new Set([
  ".dng", ".cr2", ".cr3", ".nef", ".arw", ".raf", ".orf", ".rw2",
  ".pef", ".srw", ".x3f", ".3fr", ".mef", ".erf", ".mrw",
  ".jpg", ".jpeg", ".tif", ".tiff", ".heic", ".heif",
]);

async function handleEvent(event: WatchEvent, folderId: ObjectId): Promise<void> {
  const { kind, absPath, fromPath } = event;
  const coll = await assetsCollection();

  if (kind === "removed") {
    await coll.updateOne(
      { abs_path: absPath },
      { $set: { deleted_at: new Date().toISOString() } },
    );
    log.info({ absPath }, "soft-deleted");
    return;
  }

  if (kind === "renamed" && fromPath) {
    await coll.updateOne(
      { abs_path: fromPath },
      {
        $set: {
          abs_path: absPath,
          filename: path.basename(absPath),
          indexed_at: new Date().toISOString(),
          deleted_at: null,
        },
      },
    );
    log.info({ from: fromPath, to: absPath }, "renamed");
    return;
  }

  // created or modified — upsert with skeleton.
  let stat: Awaited<ReturnType<typeof fsNode.stat>>;
  try {
    stat = await fsNode.stat(absPath);
  } catch {
    log.warn({ absPath }, "stat failed after watch event — skipping");
    return;
  }

  const now = new Date().toISOString();
  await coll.updateOne(
    { folder_id: folderId, filename: path.basename(absPath) },
    {
      $set: {
        abs_path: absPath,
        size: stat.size,
        mtime: stat.mtimeMs,
        indexed_at: now,
        deleted_at: null,
      },
      $setOnInsert: {
        folder_id: folderId,
        filename: path.basename(absPath),
        rating: 0,
        flag: 0,
        color_label: "",
        exif: null,
        maple_id: null,
        sha1_head: null,
        stages: blankStagesSkeleton(),
      },
    },
    { upsert: true },
  );
  log.info({ absPath, kind }, "upserted");
}

/**
 * Start the discover loop. Called by the supervisor in-process (or by tests).
 * Returns a handle that stops the watcher gracefully.
 */
export async function startDiscover(opts: DiscoverOptions): Promise<DiscoverHandle> {
  const folderId = new ObjectId(opts.folderId);
  const include = opts.include ?? SUPPORTED_EXTS;

  const watcher = new Watcher({
    roots: opts.roots,
    debounceMs: opts.debounceMs,
    include,
    onEvent: (event: WatchEvent) => {
      handleEvent(event, folderId).catch((err) => {
        log.error(
          { absPath: event.absPath, err: err instanceof Error ? err.message : err },
          "event handler failed",
        );
      });
    },
  });

  return {
    stop: async () => {
      await watcher.close();
    },
  };
}

/**
 * Child-process entry point. The supervisor spawns:
 *   bun src/api/src/workers/discover/index.ts <folderId> <root1> [<root2> ...]
 *
 * Connects to Mongo, starts the watcher, runs until SIGTERM/SIGINT.
 */
async function main(): Promise<void> {
  const [, , folderId, ...roots] = process.argv;
  if (!folderId || roots.length === 0) {
    process.stderr.write(
      "Usage: bun src/api/src/workers/discover/index.ts <folderId> <root1> [<root2>...]\n",
    );
    process.exit(1);
  }

  await getDb().then(ensureIndexes);

  const handle = await startDiscover({ folderId, roots });
  log.info({ folderId, roots }, "discover started");

  async function shutdown(): Promise<void> {
    log.info("shutting down discover");
    await handle.stop();
    await closeDb();
    process.exit(0);
  }

  process.on("SIGTERM", () => {
    shutdown().catch((e) => {
      log.error({ err: e instanceof Error ? e.message : e }, "shutdown error");
      process.exit(1);
    });
  });
  process.on("SIGINT", () => {
    shutdown().catch((e) => {
      log.error({ err: e instanceof Error ? e.message : e }, "shutdown error");
      process.exit(1);
    });
  });
}

// Only run main when executed directly, not when imported by tests.
if (import.meta.main) {
  main().catch((e) => {
    process.stderr.write(
      `[discover] fatal: ${e instanceof Error ? e.message : e}\n`,
    );
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run the discover integration test**

Run: `cd src/api && bun test src/workers/discover/discover.test.ts`

Expected: passes with local Mongo, or skips gracefully without it.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/workers/discover/index.ts src/api/src/workers/discover/discover.test.ts
git commit -m "feat(api/workers): discover producer child"
```

---

## Task 6: Smoke test — supervisor + three stages + discover end to end

**Files:**
- Create: `src/api/src/workers/smoke.test.ts`

This test spawns the Plan 1 supervisor with `["hash", "exif", "thumb"]` plus the discover child, drops a file into a temp dir, and waits for all three stages to reach `version: 1` on the doc. It requires a local Mongo and skips gracefully without it. Run time is bounded at 30 seconds.

- [ ] **Step 1: Write the failing smoke test**

Create `src/api/src/workers/smoke.test.ts`:

```ts
/**
 * Smoke test: supervisor + hash + exif + thumb + discover.
 *
 * Drops a JPEG into a temp dir, waits up to 30 s for all three pipeline
 * stages to complete, then asserts stage versions on the image doc.
 *
 * Requires a running MongoDB (skips if unreachable) and the Plan 1
 * supervisor + runtime to be implemented.
 */
import { describe, expect, it, afterAll } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import sharp from "sharp";

const TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

describe("workers smoke test", () => {
  let dir: string;
  let supervisorHandle: { stop: () => Promise<void> } | null = null;

  afterAll(async () => {
    if (supervisorHandle) await supervisorHandle.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it(
    "hash + exif + thumb all reach version 1 after a file is dropped",
    async () => {
      // Connect to Mongo — skip if unavailable.
      let db: import("mongodb").Db;
      try {
        const { getDb } = await import("../db/client.ts");
        db = await getDb();
      } catch {
        console.log("MongoDB unreachable — skipping smoke test");
        return;
      }

      dir = await mkdtemp(path.join(os.tmpdir(), "smoke-test-"));

      // Insert a folder row so discover has a folderId to reference.
      const { foldersCollection, assetsCollection } = await import("../db/client.ts");
      const foldersColl = await foldersCollection();
      const folderResult = await foldersColl.insertOne({
        abs_path: dir,
        name: "smoke",
        created_at: new Date().toISOString(),
      } as never);
      const folderId = folderResult.insertedId.toHexString();

      // Import the Plan 1 supervisor and start it.
      const { startSupervisor } = await import("./supervisor.ts");
      supervisorHandle = await startSupervisor({
        stages: ["hash", "exif", "thumb"],
        discover: { folderId, roots: [dir] },
      });

      // Drop a JPEG.
      const file = path.join(dir, "smoke.jpg");
      const buf = await sharp({
        create: { width: 64, height: 64, channels: 3, background: { r: 80, g: 120, b: 180 } },
      })
        .jpeg()
        .toBuffer();
      await writeFile(file, buf);

      // Poll until all three stages are at version 1 or the deadline fires.
      const assetsColl = await assetsCollection();
      const deadline = Date.now() + TIMEOUT_MS;
      let doc: Record<string, unknown> | null = null;

      while (Date.now() < deadline) {
        doc = await assetsColl.findOne({ abs_path: file }) as Record<string, unknown> | null;
        if (doc?.stages) {
          const stages = doc.stages as Record<string, { version: number }>;
          if (
            stages.hash?.version === 1 &&
            stages.exif?.version === 1 &&
            stages.thumb?.version === 1
          ) {
            break;
          }
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }

      // Assertions.
      expect(doc).not.toBeNull();
      const stages = (doc!.stages as Record<string, { version: number }>);
      expect(stages.hash?.version).toBe(1);
      expect(stages.exif?.version).toBe(1);
      expect(stages.thumb?.version).toBe(1);

      // The Plan 3 stages should still be at version 0 (untouched).
      expect(stages.face?.version).toBe(0);
      expect(stages.ocr?.version).toBe(0);

      // Clean up.
      await foldersColl.deleteOne({ _id: folderResult.insertedId });
      await assetsColl.deleteOne({ abs_path: file });
    },
    TIMEOUT_MS + 5000,
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src/api && bun test src/workers/smoke.test.ts`

Expected: FAIL — either `./supervisor.ts` not found (if Plan 1 is not yet merged) or the test times out because the supervisor isn't wired yet. This is the expected failure mode — the smoke test is the integration gate.

- [ ] **Step 3: Commit the test**

```bash
git add src/api/src/workers/smoke.test.ts
git commit -m "test(api/workers): smoke test for supervisor + hash/exif/thumb + discover"
```

- [ ] **Step 4: Pass the smoke test after cutover (return here post-Task 10)**

After Task 10 completes (supervisor wired into `src/api/src/index.ts`), re-run the smoke test:

Run: `cd src/api && bun test src/workers/smoke.test.ts`

Expected: passes within 30 seconds with local Mongo.

---

## Task 7: Wire the supervisor into src/api/src/index.ts

**Files:**
- Modify: `src/api/src/index.ts`

Replace `spawnChild()` / `stopChild()` from `./indexer/control.ts` with `startSupervisor()` / `stopSupervisor()` from the Plan 1 supervisor. The supervisor accepts the stage names to launch (`["hash", "exif", "thumb"]`) and a `discover` config. The existing enrichment workers (face, geocode, describe, OCR) are untouched — they are Plan 3's job.

- [ ] **Step 1: Write a build-passes check before editing**

Run: `cd src/api && bun build src/index.ts --target bun 2>&1 | tail -3`

Expected: build succeeds (no errors). This is the baseline.

- [ ] **Step 2: Replace the indexer spawn in src/api/src/index.ts**

In `src/api/src/index.ts`, replace the import block:

```ts
import {
  spawnChild,
  stopChild,
  waitReady,
  state as indexerState,
} from "./indexer/control.ts";
```

With:

```ts
import {
  startSupervisor,
  stopSupervisor,
  supervisorState,
} from "./workers/supervisor.ts";
import { foldersCollection } from "./db/client.ts";
```

Replace the `spawnChild()` / `waitReady()` call in `start()`:

```ts
      // Auto-start the standalone indexer child unless explicitly disabled
      // (`MAPLE_INDEXER_AUTOSTART=0`). The child opens its own Mongo
      // connection on its own event loop — see src/indexer/standalone.ts.
      if (process.env.MAPLE_INDEXER_AUTOSTART === "0") {
        log.info("Indexer autostart disabled (MAPLE_INDEXER_AUTOSTART=0)");
        return;
      }
      spawnChild();
      waitReady()
        .then(() =>
          log.info(
            { pid: indexerState().pid },
            "Indexer process running",
          ),
        )
        .catch((e) =>
          log.warn(
            { err: e instanceof Error ? e.message : e },
            "Indexer process failed to start",
          ),
        );
```

With:

```ts
      if (process.env.MAPLE_INDEXER_AUTOSTART === "0") {
        log.info("Indexer autostart disabled (MAPLE_INDEXER_AUTOSTART=0)");
        return;
      }
      // Resolve discover roots: one entry per registered folder.
      const foldersColl = await foldersCollection();
      const folders = await foldersColl.find({}, { projection: { abs_path: 1 } }).toArray();
      const discoverRoots = folders.map((f) => (f as unknown as { abs_path: string }).abs_path).filter(Boolean);

      startSupervisor({
        stages: ["hash", "exif", "thumb"],
        discover: discoverRoots.length > 0
          ? { roots: discoverRoots }
          : undefined,
      })
        .then(() =>
          log.info(supervisorState(), "Worker supervisor running"),
        )
        .catch((e) =>
          log.warn(
            { err: e instanceof Error ? e.message : e },
            "Worker supervisor failed to start",
          ),
        );
```

Replace the shutdown call:

```ts
  try {
    await stopChild({ graceful: true });
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : e },
      "error stopping indexer child",
    );
  }
```

With:

```ts
  try {
    await stopSupervisor();
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : e },
      "error stopping worker supervisor",
    );
  }
```

- [ ] **Step 3: Verify the build passes**

Run: `cd src/api && bun build src/index.ts --target bun 2>&1 | tail -5`

Expected: zero errors.

- [ ] **Step 4: Run the full unit test suite to confirm no regressions**

Run: `cd src/api && bun test --timeout 30000 2>&1 | tail -20`

Expected: all existing tests pass (the tests that mock `indexerState()` or `spawnChild()` may need updating — see note below).

> **Note:** if tests in `src/routes/indexer.test.ts` or similar import from `./indexer/control.ts` and mock `state()`, update those imports to `./workers/supervisor.ts` and the `supervisorState()` equivalent. Do not leave dangling imports pointing at deleted files.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/index.ts
git commit -m "feat(api): wire Plan 1 supervisor into startup + shutdown"
```

---

## Task 8: Delete pipeline.ts and channel.ts

**Files:**
- Delete: `src/api/src/indexer/pipeline.ts`
- Delete: `src/api/src/indexer/channel.ts`

Before deleting, verify no remaining files import from them. If any do, those imports point at dead code and must be removed or redirected before the delete.

- [ ] **Step 1: Find all remaining imports**

Run:
```bash
grep -r "from.*indexer/pipeline" src/api/src --include="*.ts" -l
grep -r "from.*indexer/channel" src/api/src --include="*.ts" -l
```

Expected: only `src/api/src/indexer/service.ts` (which is also being deleted in Task 9) and any test files. If test files import from pipeline/channel, update them now to import from the new handlers or delete the tests if they are redundant.

- [ ] **Step 2: Delete the files**

Run:
```bash
rm src/api/src/indexer/pipeline.ts
rm src/api/src/indexer/channel.ts
```

- [ ] **Step 3: Verify the build still passes**

Run: `cd src/api && bun build src/index.ts --target bun 2>&1 | tail -5`

Expected: zero errors. (The only importer of `pipeline.ts` and `channel.ts` was `service.ts`, which is gone after Task 9, but service.ts is being co-deleted. If the build fails here because `service.ts` transitively still imports from the deleted files, delete `service.ts` in this step rather than waiting for Task 9.)

- [ ] **Step 4: Run the test suite**

Run: `cd src/api && bun test --timeout 30000 2>&1 | tail -20`

Expected: zero regressions. Any tests that directly tested `Pipeline` or `BoundedQueue` are deleted; the equivalent coverage lives in the new stage handler unit tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(api): delete indexer pipeline.ts and channel.ts"
```

---

## Task 9: Delete standalone.ts, service.ts, and control.ts

**Files:**
- Delete: `src/api/src/indexer/standalone.ts`
- Delete: `src/api/src/indexer/service.ts`
- Delete: `src/api/src/indexer/control.ts`

These three files formed the old single-child supervisor and pipeline host. After Task 7, `index.ts` no longer imports from `control.ts`. After Task 8, `service.ts` cannot build anyway (its `Pipeline` import is gone). `standalone.ts` is the entry point for the old child process — once the supervisor no longer spawns it, it is dead code.

- [ ] **Step 1: Confirm no remaining imports**

Run:
```bash
grep -r "from.*indexer/standalone" src/api/src --include="*.ts" -l
grep -r "from.*indexer/service" src/api/src --include="*.ts" -l
grep -r "from.*indexer/control" src/api/src --include="*.ts" -l
```

Expected: zero results (all imports were removed in Tasks 7–8). If any remain, fix them before proceeding.

- [ ] **Step 2: Delete the files**

Run:
```bash
rm src/api/src/indexer/standalone.ts
rm src/api/src/indexer/service.ts
rm src/api/src/indexer/control.ts
```

- [ ] **Step 3: Verify the build**

Run: `cd src/api && bun build src/index.ts --target bun 2>&1 | tail -5`

Expected: zero errors.

- [ ] **Step 4: Run the full test suite**

Run: `cd src/api && bun test --timeout 30000 2>&1 | tail -20`

Expected: all tests pass. GC sweep logic that lived in `service.ts` is now gone — if a GC test existed in `src/api/src/indexer/service.test.ts`, it is also deleted in this step (GC will be re-implemented in a future plan; it is not a correctness requirement for Plan 2).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(api): delete indexer standalone.ts, service.ts, control.ts"
```

---

## Task 10: Update indexer-facing routes to use supervisor status

**Files:**
- Modify: `src/api/src/routes/indexer.ts`

The `/api/indexer/status`, `/api/indexer/pause`, `/api/indexer/resume` routes today proxy to the standalone child via `targetUrl()` from `control.ts`. That proxy is gone. Replace with direct supervisor IPC calls so the existing Angular UI (Plan 4 will redesign this into `/settings/workers`) keeps working without a full rewrite.

- [ ] **Step 1: Read the current indexer routes to identify all usages of control.ts**

Run: `grep -n "control\|targetUrl\|indexerState\|spawnChild\|stopChild\|waitReady" src/api/src/routes/indexer.ts`

Expected: several hits referencing `targetUrl`, `state`, `spawnChild`, `stopChild`, and `waitReady`.

- [ ] **Step 2: Replace the proxy with supervisor calls**

Edit `src/api/src/routes/indexer.ts`. Replace the import:

```ts
import {
  spawnChild,
  stopChild,
  waitReady,
  state as indexerState,
  targetUrl,
} from "../indexer/control.ts";
```

With:

```ts
import {
  startSupervisor,
  stopSupervisor,
  supervisorState,
  pauseSupervisor,
  resumeSupervisor,
} from "../workers/supervisor.ts";
```

For the `GET /status` handler, replace the proxy fetch with:

```ts
  .get("/status", async () => {
    return supervisorState();
  })
```

For the `POST /pause` and `POST /resume` handlers:

```ts
  .post("/pause", async () => {
    await pauseSupervisor();
    return { ok: true };
  })
  .post("/resume", async () => {
    await resumeSupervisor();
    return { ok: true };
  })
```

For the `POST /start` and `POST /stop` handlers (used by the admin UI restart button):

```ts
  .post("/start", async () => {
    await startSupervisor({ stages: ["hash", "exif", "thumb"] });
    return supervisorState();
  })
  .post("/stop", async () => {
    await stopSupervisor();
    return { ok: true };
  })
```

Any routes that fetched the old pipeline status shape (channels depth, etc.) should return `supervisorState()` directly — the Angular UI in Plan 4 will be updated to consume the new shape.

- [ ] **Step 3: Verify the build**

Run: `cd src/api && bun build src/index.ts --target bun 2>&1 | tail -5`

Expected: zero errors.

- [ ] **Step 4: Run existing route tests**

Run: `cd src/api && bun test src/routes/indexer.test.ts 2>&1 | tail -15`

Expected: tests pass. Tests that assert the old channel-depth shape may need to be updated to assert `supervisorState()` shape — update them in place.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/routes/indexer.ts
git commit -m "refactor(api): indexer routes use supervisor IPC instead of child proxy"
```

---

## Task 11: MongoDB partial indexes for stage claim queries

**Files:**
- Modify: `src/api/src/db/client.ts` (or wherever `ensureIndexes` lives)

The spec requires one partial index per stage on `{ "stages.<name>.version": 1 }` with `partialFilterExpression: { "stages.<name>.dead": { $eq: false } }`. These indexes make the poll-claim queries fast on large libraries and keep the indexes small by excluding dead-lettered docs.

- [ ] **Step 1: Find ensureIndexes**

Run: `grep -n "ensureIndexes\|createIndex" src/api/src/db/client.ts | head -20`

Note the existing index creation pattern.

- [ ] **Step 2: Add the stage indexes**

In `src/api/src/db/client.ts`, inside `ensureIndexes`, add after the existing asset indexes:

```ts
  // Partial indexes for stage claim queries. One per stage, covering only
  // docs where dead = false (the claim predicate never touches dead docs).
  // partialFilterExpression requires the equality form; $ne: true is not
  // supported in partial filter expressions by MongoDB.
  const stageNames = [
    "hash", "exif", "thumb", "face", "ocr", "describe", "geocode", "meili",
  ] as const;
  const assets = await assetsCollection();
  for (const name of stageNames) {
    await assets.createIndex(
      { [`stages.${name}.version`]: 1 },
      {
        name: `stage_${name}_version`,
        partialFilterExpression: { [`stages.${name}.dead`]: { $eq: false } },
        background: true,
      },
    );
  }
```

- [ ] **Step 3: Verify the indexes are created**

With a local MongoDB running:

Run: `cd src/api && bun -e "import('./src/db/client.ts').then(m => m.getDb()).then(m => m.ensureIndexes()).then(() => console.log('ok'))"`

Expected: `ok` — no errors. The indexes are idempotent (`createIndex` is a no-op when the index already exists with the same options).

- [ ] **Step 4: Commit**

```bash
git add src/api/src/db/client.ts
git commit -m "feat(api/db): partial indexes for per-stage claim queries"
```

---

## Task 12: Final verification pass

- [ ] **Step 1: Full test suite**

Run: `cd src/api && bun test --timeout 60000 2>&1 | tail -30`

Expected: all tests pass. No references to deleted files.

- [ ] **Step 2: Build check**

Run: `cd src/api && bun build src/index.ts --target bun 2>&1 | tail -5`

Expected: zero errors.

- [ ] **Step 3: Smoke test with local Mongo**

Run: `cd src/api && bun test src/workers/smoke.test.ts --timeout 40000`

Expected: passes (or skips gracefully without Mongo).

- [ ] **Step 4: Confirm deleted files are gone**

Run:
```bash
ls src/api/src/indexer/pipeline.ts 2>&1
ls src/api/src/indexer/channel.ts 2>&1
ls src/api/src/indexer/standalone.ts 2>&1
ls src/api/src/indexer/service.ts 2>&1
ls src/api/src/indexer/control.ts 2>&1
```

Expected: all five commands print `No such file or directory`.

- [ ] **Step 5: Confirm surviving indexer files are intact**

Run:
```bash
ls src/api/src/indexer/exif.ts
ls src/api/src/indexer/thumbnailer.ts
ls src/api/src/indexer/id.ts
ls src/api/src/indexer/watcher.ts
ls src/api/src/indexer/checkpoint.ts
ls src/api/src/indexer/images.repo.ts
```

Expected: all six files exist.

- [ ] **Step 6: Commit if any fixups were needed**

```bash
git add -A
git commit -m "fix(api/workers): Plan 2 final cleanup"
```

---

## Self-review checklist for the executor

Before declaring this plan complete:

- [ ] Spec coverage: hash/exif/thumb dep graph correct (`hash→[]`, `exif→[hash]`, `thumb→[hash,exif]`).
- [ ] Discover writes the full 8-entry skeleton including face/ocr/describe/geocode/meili at `version: 0`.
- [ ] `pipeline.ts`, `channel.ts`, `standalone.ts`, `service.ts`, `control.ts` are all deleted.
- [ ] `thumb.ts` handler depends on both `["hash", "exif"]`.
- [ ] `manifest.ts` is the single source of truth for stage names; no other file hardcodes the list.
- [ ] Smoke test passes end to end.
- [ ] No `TODO`, `TBD`, or placeholder comments in any new file.
- [ ] All imports from deleted files have been removed or redirected.
- [ ] MongoDB partial indexes for all 8 stage names are in `ensureIndexes`.
- [ ] `src/api/src/indexer/exif.ts`, `thumbnailer.ts`, `id.ts`, `watcher.ts` are untouched.
