/**
 * Folder scan + bucketing for the Imports feature (ticket #742).
 *
 * Walks a server-local source folder (and its subfolders), classifies each
 * file, pairs `.xmp` sidecars to their parent image, and groups everything
 * into `YEAR/MM` buckets keyed on file mtime (UTC). The result drives the
 * UI's editable-bucket review; the create route turns it (plus the user's
 * label edits) into the per-file destination list on the import doc.
 *
 * Sidecars inherit their parent image's bucket so a RAW and its `.xmp` never
 * land in different folders. Orphan sidecars (no matching image in the scan)
 * are ignored — a sidecar with no image is meaningless to copy.
 *
 * Symlinked directories and files ARE followed (a source folder is often a
 * tree of symlinks into a NAS/removable-media mount). A cyclic symlink can't
 * loop forever: each symlinked directory's realpath is recorded the first
 * time it's queued, and a repeat realpath is skipped.
 */

import fs from 'node:fs/promises';
import type { Dirent, Stats } from 'node:fs';
import path from 'node:path';
import { SUPPORTED_EXTS } from '../workers/discover/types.ts';
import { canonicalBaseFromSidecarFilename } from '../fs/browse.ts';
import {
  bucketForMtime,
  destRelPath,
  destRelPathDefault,
  destRelPathInFolder,
  destRelPathShotFolder,
  isNumberedShotFolder,
} from './dest.ts';
import { child as childLogger } from '../log.ts';
import type { ImportFileEntry, ImportFileKind } from '../db/schema.ts';

const log = childLogger('import-scan');

/** Movie extensions copied (but not indexed — the watcher is image-only). */
export const MOVIE_EXTS = new Set<string>([
  '.mov',
  '.mp4',
  '.m4v',
  '.avi',
  '.mts',
  '.m2ts',
  '.mxf',
  '.mkv',
  '.webm',
]);

interface RawFile {
  src: string;
  filename: string;
  dir: string; // absolute parent dir
  size: number;
  mtime: number;
}

/** A primary item (image or movie) plus any sidecars paired to it. */
interface ScanItem extends RawFile {
  kind: Exclude<ImportFileKind, 'sidecar'>;
  sidecars: RawFile[];
}

export interface ScanBucket {
  /** Stable key `${year}/${mm}` — the label-override map is keyed on this. */
  key: string;
  year: string;
  /** Two-digit month; also the default bucket label. */
  mm: string;
  /** Number of files (primaries + sidecars) destined for this bucket. */
  fileCount: number;
  imageCount: number;
  movieCount: number;
  sidecarCount: number;
  totalBytes: number;
}

export interface ScanResult {
  source_root: string;
  buckets: ScanBucket[];
  totals: {
    files: number;
    images: number;
    movies: number;
    sidecars: number;
    bytes: number;
  };
}

function classify(filename: string): ImportFileKind | null {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.xmp') return 'sidecar';
  if (SUPPORTED_EXTS.has(ext)) return 'image';
  if (MOVIE_EXTS.has(ext)) return 'movie';
  return null;
}

/** Recursively collect classifiable files under `root`, following symlinks
 * (both symlinked directories and symlinked files). Every directory is
 * de-duplicated by its REALPATH the moment it's dequeued (not just when it's
 * a symlink), so a cyclic symlink (A → B → A) — or two different paths
 * landing on the same real directory — can't cause an infinite loop or
 * double-count the same files. */
async function walk(root: string): Promise<{
  primaries: RawFile[];
  sidecars: RawFile[];
}> {
  const primaries: RawFile[] = [];
  const sidecars: RawFile[] = [];
  const stack: string[] = [root];
  const visitedRealDirs = new Set<string>();

  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let realDir: string;
    try {
      realDir = await fs.realpath(dir);
    } catch {
      continue; // dangling symlink or vanished dir — skip
    }
    if (visitedRealDirs.has(realDir)) continue;
    visitedRealDirs.add(realDir);

    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir — skip rather than abort the whole scan
    }
    for (const ent of entries) {
      // Skip hidden/temp entries (files AND dirs): Lightroom temp files
      // (`.LrTmp-*`), macOS AppleDouble (`._*`), `.DS_Store`, dotdirs like
      // `.git`/`.thumbnails`. None are real asset sources, and leading-dot
      // names are rejected downstream by isSafeFilename/isSafeLabel anyway —
      // skipping them here keeps one temp file from failing the whole import.
      // Mirrors workers/cache-gc.ts. Placed before the dir branch so dotdirs
      // never get pushed onto the walk stack. Sidecars are `photo.xmp` (no
      // leading dot) so this does not affect sidecar pairing.
      if (ent.name.startsWith('.')) continue;
      const abs = path.join(dir, ent.name);

      let isDir = ent.isDirectory();
      let isFile = ent.isFile();
      if (ent.isSymbolicLink()) {
        let st: Stats;
        try {
          st = await fs.stat(abs); // follows the link
        } catch {
          continue; // dangling symlink
        }
        isDir = st.isDirectory();
        isFile = st.isFile();
      }

      if (isDir) {
        stack.push(abs);
        continue;
      }
      if (!isFile) continue;
      const kind = classify(ent.name);
      if (!kind) continue;
      let st: Stats;
      try {
        st = await fs.stat(abs); // follows a symlinked file
      } catch {
        continue;
      }
      const rec: RawFile = {
        src: abs,
        filename: ent.name,
        dir,
        size: st.size,
        mtime: st.mtimeMs,
      };
      if (kind === 'sidecar') sidecars.push(rec);
      else primaries.push({ ...rec });
    }
  }
  return { primaries, sidecars };
}

/** Pair sidecars to a primary (image or movie) in the SAME directory by primary key. */
function pair(
  primaries: RawFile[],
  sidecars: RawFile[],
): { items: ScanItem[]; orphanSidecars: number } {
  const items: ScanItem[] = primaries.map((p) => ({
    ...p,
    kind: MOVIE_EXTS.has(path.extname(p.filename).toLowerCase()) ? 'movie' : 'image',
    sidecars: [],
  }));

  // Index every primary by the key its sidecar resolves to:
  //   - images: `${dir}\0${stem}`          (stem-swap `IMG_1.xmp` → IMG_1)
  //   - videos: `${dir}\0${full filename}`  (full-name `clip.mov.xmp` → clip.mov)
  // `canonicalBaseFromSidecarFilename` mirrors this split, so a video's
  // full-name sidecar resolves to a different key than a same-stem photo's
  // `.xmp` — no collision, no orphan, each its own separate file (M5 — #1635).
  const keyForPrimary = (it: ScanItem): string => {
    const base =
      it.kind === 'movie' ? it.filename : path.basename(it.filename, path.extname(it.filename));
    return `${it.dir}\0${base}`;
  };
  const byKey = new Map<string, ScanItem>(items.map((it) => [keyForPrimary(it), it]));

  let orphans = 0;
  for (const sc of sidecars) {
    const base = canonicalBaseFromSidecarFilename(sc.filename);
    const parent = base ? byKey.get(`${sc.dir}\0${base}`) : undefined;
    if (parent) parent.sidecars.push(sc);
    else orphans++;
  }
  return { items, orphanSidecars: orphans };
}

/** Scan a folder tree into mtime-bucketed groups for UI review. */
export async function scanFolder(absRoot: string): Promise<ScanResult> {
  const { primaries, sidecars } = await walk(absRoot);
  const { items } = pair(primaries, sidecars);

  const buckets = new Map<string, ScanBucket>();
  let images = 0;
  let movies = 0;
  let sidecarCount = 0;
  let bytes = 0;

  for (const it of items) {
    const { year, mm } = bucketForMtime(it.mtime);
    const key = `${year}/${mm}`;
    let b = buckets.get(key);
    if (!b) {
      b = {
        key,
        year,
        mm,
        fileCount: 0,
        imageCount: 0,
        movieCount: 0,
        sidecarCount: 0,
        totalBytes: 0,
      };
      buckets.set(key, b);
    }
    b.fileCount += 1;
    b.totalBytes += it.size;
    bytes += it.size;
    if (it.kind === 'image') {
      b.imageCount += 1;
      images += 1;
    } else {
      b.movieCount += 1;
      movies += 1;
    }
    for (const sc of it.sidecars) {
      b.fileCount += 1;
      b.sidecarCount += 1;
      b.totalBytes += sc.size;
      bytes += sc.size;
      sidecarCount += 1;
    }
  }

  const ordered = [...buckets.values()].sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );

  return {
    source_root: absRoot,
    buckets: ordered,
    totals: {
      files: images + movies + sidecarCount,
      images,
      movies,
      sidecars: sidecarCount,
      bytes,
    },
  };
}

export interface BuildImportFilesOptions {
  /**
   * Look up whether an asset already indexed in the target library was
   * captured within 30 minutes of `mtimeMs`, and if so return the folder it
   * already lives in (so this file lands next to it). Injected so this
   * module stays Mongo-free (see file header) — the real implementation is
   * `imports/repo.ts`'s `findNearbyAssetFolder`. Omitted (e.g. in unit tests)
   * means "never match."
   */
  findNearbyFolder?: (mtimeMs: number) => Promise<string | null>;
}

/**
 * Re-scan `absRoot` and flatten it into the per-file destination list stored
 * on the import doc. Each file's destination directory is resolved through
 * this precedence chain (highest first):
 *
 *   1. The user's explicit per-bucket label override, keyed on the
 *      `${year}/${mm}` bucket key → `${year}/${label}/filename`.
 *   2. A nearby (within 30 min) already-indexed photo in the same library →
 *      the SAME folder that photo already lives in.
 *   3. The source folder's own name is an anonymous camera dump-folder name
 *      (`Shot0123`, `0123`, `012`) → `${year}/${parentFolderName}/${folderName}`,
 *      keeping the parent directory name for context.
 *   4. Otherwise → `${year}/misc/${folderName}`, the default.
 *
 * Each candidate destination is built through the `dest.ts` helpers, which
 * throw on an unsafe segment. Rather than letting one bad file abort the
 * whole batch, we catch per-file: an unsafe file is SKIPPED and recorded as a
 * `state:'failed'` entry (with the reason) so the operator sees it in the
 * per-file error UI and the import still completes with the good files. The
 * failure is also logged structured (filename + reason + source root) so it
 * reaches SigNoz. A sidecar lands in the SAME folder as its parent image; if
 * the parent image is unsafe, its sidecars are failed too so they don't
 * silently vanish (an unattachable sidecar is dropped by the worker's
 * `groupFiles`).
 */
export async function buildImportFiles(
  absRoot: string,
  labels: Record<string, string>,
  opts: BuildImportFilesOptions = {},
): Promise<ImportFileEntry[]> {
  const { primaries, sidecars } = await walk(absRoot);
  const { items } = pair(primaries, sidecars);
  const findNearbyFolder = opts.findNearbyFolder ?? (async () => null);

  const folderName = path.basename(absRoot);
  const parentFolderName = path.basename(path.dirname(absRoot));
  const useShotFolderFallback = isNumberedShotFolder(folderName);

  const files: ImportFileEntry[] = [];

  /** Record a file we couldn't build a safe destination for: skip it from the
   * copy run, but surface it as a failed entry (with a best-effort display
   * dest) and log the reason. The dest is for display only — the worker never
   * copies a `failed` entry, so an unvalidated path never reaches the FS. */
  const recordSkipped = (
    src: string,
    filename: string,
    size: number,
    mtime: number,
    kind: ImportFileKind,
    displayDir: string,
    reason: string,
  ): void => {
    log.warn({ source_root: absRoot, filename, kind, reason }, 'skipping unsafe import file');
    files.push({
      src,
      dest: `${displayDir}/${filename}`,
      size,
      mtime,
      kind,
      state: 'failed',
      error: reason,
    });
  };

  for (const it of items) {
    const { year, mm } = bucketForMtime(it.mtime);
    const rawOverride = labels[`${year}/${mm}`];
    const overrideLabel = rawOverride !== undefined ? rawOverride.trim() : '';
    const nearbyFolder = await findNearbyFolder(it.mtime);

    const resolveDestFor = (filename: string): string => {
      if (overrideLabel.length > 0) return destRelPath({ year, label: overrideLabel, filename });
      if (nearbyFolder != null) return destRelPathInFolder({ folderPath: nearbyFolder, filename });
      if (useShotFolderFallback) {
        return destRelPathShotFolder({ year, parentFolderName, folderName, filename });
      }
      return destRelPathDefault({ year, folderName, filename });
    };
    const displayDir = `${year}/${overrideLabel || folderName}`;

    // Resolve the image's destination first: if it's unsafe, the whole group
    // (image + its sidecars) is failed, since a sidecar with no landed image
    // is meaningless.
    let primaryDest: string | null = null;
    try {
      primaryDest = resolveDestFor(it.filename);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // Place the failed sidecars first (UI ordering parity with the happy
      // path), then the failed image.
      for (const sc of it.sidecars) {
        recordSkipped(
          sc.src,
          sc.filename,
          sc.size,
          sc.mtime,
          'sidecar',
          displayDir,
          `parent image rejected: ${reason}`,
        );
      }
      recordSkipped(it.src, it.filename, it.size, it.mtime, it.kind, displayDir, reason);
      continue;
    }

    // Place sidecars first so the worker can copy edits before the image,
    // then hand the image to the indexer with its `.xmp` already on disk.
    for (const sc of it.sidecars) {
      try {
        files.push({
          src: sc.src,
          dest: resolveDestFor(sc.filename),
          size: sc.size,
          mtime: sc.mtime,
          kind: 'sidecar',
          state: 'pending',
          error: null,
        });
      } catch (err) {
        recordSkipped(
          sc.src,
          sc.filename,
          sc.size,
          sc.mtime,
          'sidecar',
          displayDir,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    files.push({
      src: it.src,
      dest: primaryDest,
      size: it.size,
      mtime: it.mtime,
      kind: it.kind,
      state: 'pending',
      error: null,
    });
  }
  return files;
}
