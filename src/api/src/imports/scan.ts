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
 * Symlinked directories are NOT followed: the scan stays within the source
 * subtree the caller already jailed to `MAPLE_ROOTS`.
 */

import fs from 'node:fs/promises';
import type { Dirent, Stats } from 'node:fs';
import path from 'node:path';
import { SUPPORTED_EXTS } from '../workers/discover/types.ts';
import { canonicalBaseFromSidecarFilename } from '../fs/browse.ts';
import { bucketForMtime, destRelPath } from './dest.ts';
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

/** Recursively collect classifiable files under `root`. Skips symlinks. */
async function walk(root: string): Promise<{
  primaries: RawFile[];
  sidecars: RawFile[];
}> {
  const primaries: RawFile[] = [];
  const sidecars: RawFile[] = [];
  const stack: string[] = [root];

  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir — skip rather than abort the whole scan
    }
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue; // don't follow symlinks out of jail
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
      if (ent.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!ent.isFile()) continue;
      const kind = classify(ent.name);
      if (!kind) continue;
      let st: Stats;
      try {
        st = await fs.stat(abs);
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

/**
 * Re-scan `absRoot` and flatten it into the per-file destination list stored
 * on the import doc, applying the user's per-bucket label overrides (keyed on
 * the `${year}/${mm}` bucket key). Default label is the two-digit month.
 *
 * Each label and filename is run through `destRelPath`, which throws on an
 * unsafe segment. Rather than letting one bad file abort the whole batch, we
 * catch per-file: an unsafe file is SKIPPED and recorded as a `state:'failed'`
 * entry (with the reason) so the operator sees it in the per-file error UI and
 * the import still completes with the good files. The failure is also logged
 * structured (filename + reason + source root) so it reaches SigNoz. A sidecar
 * lands in the SAME bucket/label as its parent image; if the parent image is
 * unsafe, its sidecars are failed too so they don't silently vanish (an
 * unattachable sidecar is dropped by the worker's `groupFiles`).
 */
export async function buildImportFiles(
  absRoot: string,
  labels: Record<string, string>,
): Promise<ImportFileEntry[]> {
  const { primaries, sidecars } = await walk(absRoot);
  const { items } = pair(primaries, sidecars);

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
    year: string,
    label: string,
    reason: string,
  ): void => {
    log.warn({ source_root: absRoot, filename, kind, reason }, 'skipping unsafe import file');
    files.push({
      src,
      dest: `${year}/${label}/${filename}`,
      size,
      mtime,
      kind,
      state: 'failed',
      error: reason,
    });
  };

  for (const it of items) {
    const { year, mm } = bucketForMtime(it.mtime);
    const label = (labels[`${year}/${mm}`] ?? mm).trim();

    // Resolve the image's destination first: if it's unsafe, the whole group
    // (image + its sidecars) is failed, since a sidecar with no landed image
    // is meaningless.
    let primaryDest: string | null = null;
    try {
      primaryDest = destRelPath({ year, label, filename: it.filename });
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
          year,
          label,
          `parent image rejected: ${reason}`,
        );
      }
      recordSkipped(it.src, it.filename, it.size, it.mtime, it.kind, year, label, reason);
      continue;
    }

    // Place sidecars first so the worker can copy edits before the image,
    // then hand the image to the indexer with its `.xmp` already on disk.
    for (const sc of it.sidecars) {
      try {
        files.push({
          src: sc.src,
          dest: destRelPath({ year, label, filename: sc.filename }),
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
          year,
          label,
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
