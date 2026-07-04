/**
 * Capture-time resolution for the Imports feature (ticket #1752).
 *
 * Split out of `imports/scan.ts` to keep that file under the repo's file-size
 * budget (see `CONTRIBUTING.md`) — this is a self-contained EXIF-read
 * concern, not part of the walk/pair/destination-precedence logic.
 */

import { readExif } from '../indexer/exif.ts';

/** Max concurrent EXIF reads while resolving capture times for a scan.
 * `readExif` is async I/O + parsing (the indexer's own `exif` stage runs it
 * at `cpus/2` concurrency for the same reason) — reading thousands of files
 * one at a time in a straight loop would make a big import's scan/create
 * request needlessly slow. */
export const EXIF_READ_CONCURRENCY = 4;

/** Run `fn` over `items` with at most `limit` calls in flight at once,
 * preserving output order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Resolve the timestamp used to bucket/place a file: its EXIF capture time
 * (`DateTimeOriginal`, or `CreateDate` — via `indexer/exif.ts`'s `readExif`,
 * the same reader the indexer's `exif` stage uses) when present and
 * parseable, otherwise `fallbackMs` (the file's own mtime). A read failure
 * (corrupt file, unsupported format, permission error) also falls back to
 * mtime — EXIF is a nicety for placement, not a requirement; it must never
 * fail the import.
 */
export async function resolveCapturedAtMs(absPath: string, fallbackMs: number): Promise<number> {
  try {
    const exif = await readExif(absPath);
    const capturedAt = exif?.captured_at;
    if (capturedAt) {
      const ms = new Date(capturedAt).getTime();
      if (Number.isFinite(ms)) return ms;
    }
  } catch {
    // Fall through to the mtime fallback below.
  }
  return fallbackMs;
}

/** Resolve capture times for a batch of `{ src, mtime }` items (bounded
 * concurrency — see `EXIF_READ_CONCURRENCY`), preserving order. */
export async function resolveCapturedTimesFor(
  items: readonly { src: string; mtime: number }[],
): Promise<number[]> {
  return mapWithConcurrency(items, EXIF_READ_CONCURRENCY, (it) =>
    resolveCapturedAtMs(it.src, it.mtime),
  );
}
