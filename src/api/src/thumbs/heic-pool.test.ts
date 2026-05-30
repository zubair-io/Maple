/**
 * Parity + off-thread tests for the HEIC/HEIF decode pool. The Worker must
 * write a thumbnail byte-for-byte identical to the synchronous chain that
 * `renderImageThumbToFile` used before the offload — moving the decode off the
 * main thread is a timing change only, never a byte change.
 *
 * The equivalence test renders the same HEIC two ways:
 *   1. through `renderImageThumbToFile` (the real worker path), and
 *   2. through an INLINE literal copy of the pre-offload chain
 *      (readFile → heicConvert q0.9 → sharp.rotate().resize().jpeg q82
 *      mozjpeg → atomic write),
 * then asserts the on-disk bytes are equal. The inline copy is deliberately
 * independent of `renderHeicThumbToFile` so this proves the production chain,
 * not a tautology against the shared helper.
 *
 * Fixture: a tiny committed HEIC at `tests/fixtures/sample.heic`. heic-convert
 * + sharp + mozjpeg are deterministic, so byte equality holds across runs. The
 * soft-pass guard (skip when the fixture is absent) mirrors the repo's
 * fixtures-absent convention so a fixture deletion never hard-fails CI.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import sharp from "sharp";
import heicConvert from "heic-convert";
import { renderImageThumbToFile } from "./render.ts";

// `import.meta.dir` is src/api/src/thumbs; the fixture lives under
// src/api/tests/fixtures. Two levels up to src/api, then into tests/fixtures.
const FIXTURE_HEIC = path.resolve(
  import.meta.dir,
  "..",
  "..",
  "tests",
  "fixtures",
  "sample.heic",
);

const SIZE_PX = 48;

async function fixturePresent(): Promise<boolean> {
  try {
    await stat(FIXTURE_HEIC);
    return true;
  } catch {
    return false;
  }
}

/**
 * The exact HEIC chain as it stood before the worker offload — inlined here
 * so the equivalence assertion compares the production path against an
 * independent reference, not against the shared helper it now calls.
 */
async function renderHeicInlineReference(
  srcPath: string,
  thumbPath: string,
  sizePx: number,
): Promise<void> {
  const inputBuffer = await readFile(srcPath);
  const jpegBuffer = (await heicConvert({
    buffer: inputBuffer,
    format: "JPEG",
    quality: 0.9,
  })) as Buffer;
  const buf = await sharp(jpegBuffer, { failOn: "none" })
    .rotate()
    .resize(sizePx, sizePx, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
  const tmp = `${thumbPath}.${process.pid}.inline.tmp`;
  await writeFile(tmp, buf);
  await rename(tmp, thumbPath);
}

describe("HEIC thumbnail offload", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "heic-pool-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("produces bytes identical to the pre-offload inline chain", async () => {
    if (!(await fixturePresent())) return; // fixture missing, soft pass

    const viaPool = path.join(dir, "via-pool.jpg");
    const viaInline = path.join(dir, "via-inline.jpg");

    // The worker path. Under `bun test`, Worker is available, so this routes
    // through the spawned `heic.worker.ts`, not the in-process fallback.
    const ok = await renderImageThumbToFile(
      FIXTURE_HEIC,
      viaPool,
      SIZE_PX,
      "heic",
    );
    expect(ok).toBe(true);

    await renderHeicInlineReference(FIXTURE_HEIC, viaInline, SIZE_PX);

    const poolBytes = await readFile(viaPool);
    const inlineBytes = await readFile(viaInline);
    expect(poolBytes.equals(inlineBytes)).toBe(true);
  });

  // Proves the decode actually left the main thread. A Worker round-trip
  // settles on a `message` event — a macrotask — so the promise cannot resolve
  // while we drain only the microtask queue. The in-process fallback resolves
  // a `Promise.resolve(...)`, which WOULD settle within microtasks; so a broken
  // worker URL / spawn regression that silently degrades to blocking-in-process
  // makes this assertion fail.
  it("runs genuinely off-thread (does not settle within the microtask queue)", async () => {
    if (!(await fixturePresent())) return; // fixture missing, soft pass

    const out = path.join(dir, "off-thread.jpg");
    let settled = false;
    const p = renderImageThumbToFile(FIXTURE_HEIC, out, SIZE_PX, "heic").then(
      (r) => {
        settled = true;
        return r;
      },
    );
    // Drain microtasks only — never yields to a macrotask, so the worker's
    // reply can't have been delivered yet.
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(settled).toBe(false);
    // Awaiting the real promise lets the event loop process the worker message.
    await p;
    expect(settled).toBe(true);
  });

  it("leaves non-HEIC formats on the inline sharp path (unaffected)", async () => {
    // A generated PNG goes through the `else` branch, which is unchanged.
    const src = path.join(dir, "src.png");
    const out = path.join(dir, "out.jpg");
    const png = await sharp({
      create: {
        width: 96,
        height: 64,
        channels: 3,
        background: { r: 30, g: 160, b: 90 },
      },
    })
      .png()
      .toBuffer();
    await writeFile(src, png);

    const ok = await renderImageThumbToFile(src, out, SIZE_PX, "png");
    expect(ok).toBe(true);

    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("jpeg");
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(
      SIZE_PX,
    );
  });
});
