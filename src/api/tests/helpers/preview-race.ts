/**
 * Shared helpers for the #1997 concurrent-writer / no-partial-AVIF tests
 * (`preview-concurrent-put-race.test.ts`, `preview-stage-vs-put-race.test.ts`).
 * See those files for the write-to-temp-then-rename contract this exercises.
 */

import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { validateAvifOutput } from '../../src/thumbs/validate-avif.ts';
import { PREVIEW_LONG_EDGE_PX } from '../../src/indexer/previewer.ts';

/** A genuine, decodable AVIF distinguishable by its solid background color —
 * large enough (400x300) that encode/write/decode each take a few
 * milliseconds, widening the real race window between writers and readers
 * instead of everything completing inside one microtask tick. */
export async function distinctAvif(r: number, g: number, b: number): Promise<Buffer> {
  return sharp({
    create: { width: 400, height: 300, channels: 3, background: { r, g, b } },
  })
    .avif({ quality: 60, effort: 2 })
    .toBuffer();
}

export type ReadObservation = { ok: boolean; reason?: string };

/**
 * Repeatedly reads `previewPath` with a single atomic `readFile` (whatever
 * inode the path currently resolves to — exactly what a real consumer like
 * `/api/fs/preview`'s `readFile(previewPath)` does) and decode-verifies THOSE
 * bytes via the real #2014 `validateAvifOutput` path, until `shouldStop()`
 * returns true. Bytes are staged to a private scratch file first so the
 * validator's own `sharp(filePath)` open judges the read snapshot, not a
 * second independent look at the (possibly already-rewritten-again) live
 * path — see the module doc on the test files for why that distinction
 * matters.
 *
 * `scratchDir` must be a directory the caller owns exclusively for the
 * duration of the race (each reader instance gets its own counter namespace
 * via `readerId` so concurrent readers never collide on a scratch filename).
 *
 * Not exported — `runReadersAgainst` below is the module's only external
 * entry point; both test files drive readers through it exclusively.
 */
async function raceReaderLoop(
  previewPath: string,
  scratchDir: string,
  readerId: number,
  shouldStop: () => boolean,
  observations: ReadObservation[],
): Promise<void> {
  let counter = 0;
  while (!shouldStop()) {
    let bytes: Buffer | null = null;
    try {
      bytes = await readFile(previewPath);
    } catch {
      // ENOENT is only legitimate before the shared path has ever been
      // published — callers pre-seed before starting readers, so this
      // should not fire during the timed race window. Retry rather than
      // record a spurious observation.
      continue;
    }
    const scratchPath = join(scratchDir, `read-${readerId}-${counter++}.avif`);
    await writeFile(scratchPath, bytes);
    const result = await validateAvifOutput(scratchPath, PREVIEW_LONG_EDGE_PX);
    await unlink(scratchPath).catch(() => {});
    observations.push(result.ok ? { ok: true } : { ok: false, reason: result.reason });
  }
}

/** Run `readerCount` concurrent `raceReaderLoop`s against `previewPath`,
 * stopping them ~`graceMs` after `work` resolves. Returns the collected
 * observations plus the settled result of `work`. */
export async function runReadersAgainst<T>(
  previewPath: string,
  scratchDir: string,
  readerCount: number,
  work: () => Promise<T>,
  graceMs = 20,
): Promise<{ observations: ReadObservation[]; result: T }> {
  let stop = false;
  const observations: ReadObservation[] = [];
  const readers = Array.from({ length: readerCount }, (_, i) =>
    raceReaderLoop(previewPath, scratchDir, i, () => stop, observations),
  );

  const result = await work();
  await new Promise((r) => setTimeout(r, graceMs));
  stop = true;
  await Promise.all(readers);

  return { observations, result };
}
