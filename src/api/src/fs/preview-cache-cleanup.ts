/**
 * Recognizing and cleaning up previews-cache filenames for one on-disk
 * location.
 *
 * Split out of `xmp.ts` (which owns cache-PATH CONSTRUCTION: filename +
 * suffix -> path) because this is the reverse direction — PARSING a cache
 * filename back to its source, and CLEANUP once a location's `fileinfo`
 * entry is removed. Previews are path-keyed (see `cachePathForAsset`'s doc
 * in `xmp.ts`), so they don't survive a location going away the way
 * `maple_id`-keyed thumbs do, and can't wait for `cache-gc`'s periodic
 * backstop sweep alone — `missing-reaper.ts`/`dedupe.ts` call
 * `cleanPreviewsCacheForLocation` synchronously instead; `cache-gc.ts` uses
 * `sourceFilenameForPreviewCacheName` for its own backstop sweep.
 */
import * as path from 'node:path';
// Mirror-aware drop-in: durable writes/moves replicate to the library's
// configured backup root(s). Same `fs/promises` surface — see `mirrored.ts`.
import * as fs from './mirrored.ts';
import { PREVIEW_CACHE_SUFFIX } from '../indexer/previewer.ts';

/**
 * Every previews-cache suffix currently in real use, spelled out exactly.
 * The preview itself is a single, unversioned file per asset
 * (`PREVIEW_CACHE_SUFFIX`, now the bare `avif` extension — no size or version
 * token; thumbs are a separate tier in a sibling folder). `full.jpg` is
 * `cachePathFor`/`cachePathForAsset`'s own default when no suffix is passed,
 * and `histogram.json` is the histogram sidecar (`routes/assets/histogram.ts`)
 * — both live in the same `previews/` folder and must be reclaimed with the
 * preview when a location goes away.
 *
 * Old `<filename>.1280.avif` and `<filename>.dev_<N>.jpg` files from earlier
 * schemes end in `.avif`/`.jpg` too but recover to a non-live source filename
 * (`<filename>.1280` / `<filename>.dev_<N>`), so they simply orphan out via
 * the not-live check in `cache-gc.ts` — no dedicated pattern needed.
 */
const KNOWN_EXACT_SUFFIXES: readonly string[] = [
  PREVIEW_CACHE_SUFFIX,
  'full.jpg',
  'histogram.json',
];

/**
 * Recover the exact source filename a previews-cache filename was generated
 * for, or `null` if it doesn't end in any recognized suffix (a
 * legacy/unrecognized cache file — unconditionally orphaned).
 *
 * Deliberately NOT prefix-matching against a set of live filenames: since
 * filenames are unique per directory but one filename can still be a
 * strict string-prefix of another (`image.jpg` vs `image.jpg.bak`),
 * `name.startsWith(liveFilename + '.')` can misattribute a cache file to
 * the wrong source — either hiding a genuine orphan (the true source was
 * deleted, but a same-prefix live file's name happens to also match) or
 * deleting a still-live file's preview (jules review, PR #2006). Anchoring
 * on the closed, known suffix vocabulary from the END instead recovers an
 * EXACT candidate filename, which — because filenames really are unique
 * per directory — an exact-equality/Set-membership check resolves with no
 * ambiguity.
 */
export function sourceFilenameForPreviewCacheName(cacheName: string): string | null {
  for (const suffix of KNOWN_EXACT_SUFFIXES) {
    const withDot = `.${suffix}`;
    if (cacheName.endsWith(withDot)) return cacheName.slice(0, -withDot.length);
  }
  return null;
}

/** The two `fs.Dirent` properties this file actually reads — declared
 * locally instead of importing `Dirent` from `node:fs` (real
 * `fs.readdir(..., { withFileTypes: true })` results satisfy this
 * structurally, since `Dirent` has strictly more properties) so this file
 * doesn't need a `.oxlintrc.json` no-restricted-imports allowlist entry for
 * what's really just a type import. */
interface DirEntry {
  name: string;
  isFile(): boolean;
}

/**
 * Unlink the current-scheme previews-cache artefacts for ONE on-disk location
 * — the AVIF preview and the histogram JSON sidecar, which resolve back to
 * `location.filename` via `sourceFilenameForPreviewCacheName`, inside that
 * location's own `.maple/previews/` folder. Pre-KISS files for the same asset
 * (`<filename>.1280.avif`, `<filename>.dev_<N>.jpg`) recover to a DIFFERENT
 * source name and are deliberately NOT matched here; they orphan out via
 * cache-gc's backstop sweep instead (see this module's `KNOWN_EXACT_SUFFIXES`).
 *
 * Matches on the EXACT recovered source filename, not a `${filename}.`
 * string prefix: since filenames are unique per directory but one filename
 * can still be a strict prefix of another (`image.jpg` vs `image.jpg.bak`),
 * prefix matching could delete a still-live `image.jpg.bak`'s preview when
 * `image.jpg` is removed (jules review, PR #2006).
 *
 * Call this wherever a `fileinfo` entry is removed (missing-reaper's
 * prune/hard-delete, dedupe's move-then-pull) rather than leaving the orphan
 * for cache-gc's periodic backstop sweep to find later. Best-effort: a
 * filesystem hiccup here must never block or fail the DB reconciliation
 * that's actually load-bearing; a file left behind by a failed unlink is
 * still reclaimed by cache-gc.
 */
export async function cleanPreviewsCacheForLocation(
  libraryRoot: string,
  location: { path: string; filename: string },
): Promise<void> {
  const segments = location.path === '' ? [] : location.path.split('/');
  const previewsDir = path.join(libraryRoot, ...segments, '.maple', 'previews');
  let entries: DirEntry[];
  try {
    entries = (await fs.readdir(previewsDir, { withFileTypes: true })) as DirEntry[];
  } catch {
    return; // no previews dir at this location
  }
  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isFile() && sourceFilenameForPreviewCacheName(entry.name) === location.filename,
      )
      .map((entry) => fs.unlink(path.join(previewsDir, entry.name)).catch(() => {})),
  );
}
