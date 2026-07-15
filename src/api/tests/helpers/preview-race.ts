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
 * duration of the race. Each reader reuses ONE private scratch file
 * (`read-<readerId>.avif`) — the file is overwritten in place each iteration
 * (a single writer per path, so no torn read here) and removed once after the
 * loop, rather than churning a fresh create+unlink per iteration; `readerId`
 * keeps concurrent readers off each other's scratch file.
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
  const scratchPath = join(scratchDir, `read-${readerId}.avif`);
  try {
    while (!shouldStop()) {
      let bytes: Buffer;
      try {
        bytes = await readFile(previewPath);
      } catch (err) {
        // A missing shared path is only legitimate before it has ever been
        // published — callers pre-seed before starting readers, so an ENOENT
        // here just means this reader raced ahead of the very first publish;
        // retry without recording a spurious observation. ANY OTHER error
        // (EACCES, EIO, …) is a genuine failure the test must not swallow —
        // rethrow it so the reader promise rejects loudly instead of masking
        // it as an infinite retry.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
      await writeFile(scratchPath, bytes);
      const result = await validateAvifOutput(scratchPath, PREVIEW_LONG_EDGE_PX);
      observations.push(result.ok ? { ok: true } : { ok: false, reason: result.reason });
    }
  } finally {
    await unlink(scratchPath).catch(() => {});
  }
}

/** Run `readerCount` concurrent `raceReaderLoop`s against `previewPath`,
 * stopping them ~`graceMs` after `work` resolves. Returns the collected
 * observations plus the settled result of `work`.
 *
 * `stop` is set in a `finally` so a throwing/rejecting `work()` still tears
 * the reader loops down before this function rethrows — otherwise the readers
 * would spin forever and hang the suite (their `while (!shouldStop())` would
 * never exit). `Promise.all(readers)` is awaited on both the success and
 * error paths so their scratch-file cleanup (and any reader-side rejection)
 * is surfaced rather than left dangling. */
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

  try {
    const result = await work();
    await new Promise((r) => setTimeout(r, graceMs));
    return { observations, result };
  } finally {
    // Runs on BOTH the normal return above and a throwing `work()` — either
    // way the readers must be told to stop and be awaited to completion
    // before this frame unwinds.
    stop = true;
    await Promise.all(readers);
  }
}
