/**
 * Pure destination-layout helpers for the Imports feature (ticket #742).
 *
 * Four ways a file's destination directory is resolved (highest priority
 * first — see `buildImportFiles` in `scan.ts` for the actual precedence
 * chain):
 *
 *   1. `destRelPath`          — `<YEAR>/<label>/<filename>`, when the user
 *      typed an explicit per-bucket label override in the review screen.
 *   2. `destRelPathInFolder`  — `<existing-asset-folder>/<filename>`, when a
 *      photo already indexed in the target library was captured within 30
 *      minutes of this file (it lands next to its neighbor).
 *   3. `destRelPathShotFolder` — `<YEAR>/<parent-folder>/<source-folder>/<filename>`,
 *      the fallback for an unlabeled camera dump folder (`Shot0123`, `0123`,
 *      `012`) — those names carry no information on their own, so the parent
 *      directory name is kept for context.
 *   4. `destRelPathDefault`   — `<YEAR>/misc/<source-folder>/<filename>`, the
 *      default when nothing more specific applies.
 *
 *   - YEAR comes from a file's CAPTURE time (EXIF `DateTimeOriginal`/
 *     `CreateDate`, falling back to file mtime when no EXIF time is
 *     available — see `scan.ts`'s `resolveCapturedAtMs`), in **UTC** (parity
 *     with `backup/path-formatter.ts`, which also buckets on UTC wall-clock).
 *
 * No Mongo, no filesystem — these are the safety + assembly primitives the
 * scan/copy/worker layers and the create route all funnel through, so the
 * traversal guard can't be bypassed by one caller forgetting it.
 *
 * Deliberately NOT routed through `formatBackupPath`: that formatter emits a
 * `<MM>-<DD>` (or `.../MM-DD`) day segment we don't want here.
 */

import path from 'node:path';
import { isSafeFilename } from '../backup/path-formatter.ts';

export interface Bucket {
  /** 4-digit UTC year, zero-padded. */
  year: string;
  /** 2-digit UTC month, zero-padded. Also the default bucket label. */
  mm: string;
}

/**
 * Derive the `{ year, mm }` bucket for a file from its CAPTURE time (epoch
 * ms, UTC) — the EXIF `DateTimeOriginal`/`CreateDate`, or the file's mtime
 * when no EXIF capture time is available (see `scan.ts`'s
 * `resolveCapturedAtMs`, which resolves that value before this is called).
 */
export function bucketForCapturedAt(capturedAtMs: number): Bucket {
  const d = new Date(capturedAtMs);
  const year = d.getUTCFullYear().toString().padStart(4, '0');
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  return { year, mm };
}

/** The fixed default-bucket directory name (see `destRelPathDefault`). */
export const MISC_SEGMENT = 'misc';

/** Proximity window for the nearby-asset-folder match (see `imports/nearby.ts`). */
export const NEARBY_ASSET_WINDOW_MS = 30 * 60 * 1000;

export interface NearbyAssetCandidate {
  /** Epoch ms of the candidate asset's `exif.captured_at`. */
  capturedAtMs: number;
  /** The library-root-relative folder the candidate already lives in. */
  folderPath: string;
}

/** Nearest candidate to `capturedAtMs` within `NEARBY_ASSET_WINDOW_MS`, or
 * null. Pure — the Mongo query that produces `candidates` lives in
 * `imports/nearby.ts`'s `loadNearbyAssetCandidates`. */
export function nearestCandidateFolder(
  candidates: readonly NearbyAssetCandidate[],
  capturedAtMs: number,
): string | null {
  let best: NearbyAssetCandidate | null = null;
  let bestDeltaMs = Infinity;
  for (const cand of candidates) {
    const deltaMs = Math.abs(cand.capturedAtMs - capturedAtMs);
    if (deltaMs <= NEARBY_ASSET_WINDOW_MS && deltaMs < bestDeltaMs) {
      best = cand;
      bestDeltaMs = deltaMs;
    }
  }
  return best?.folderPath ?? null;
}

/**
 * Generic camera "dump folder" names that carry no information about their
 * contents on their own — `Shot0123`/`shot0123`, or a bare zero-padded number
 * like `0123`/`012`. When the imported source folder's own name matches one
 * of these, `destRelPathShotFolder` keeps the parent directory name too, so
 * the destination isn't just an anonymous number.
 */
const SHOT_FOLDER_PATTERNS: readonly RegExp[] = [/^shot0\d{3}$/i, /^0\d{3}$/, /^0\d{2}$/];

/** True when a source folder's own name is an anonymous camera dump-folder
 * name (`Shot0123`, `0123`, `012`, …) rather than a meaningful label. */
export function isNumberedShotFolder(folderName: string): boolean {
  return SHOT_FOLDER_PATTERNS.some((re) => re.test(folderName));
}

/**
 * Validate a user-supplied bucket label as a single safe directory segment.
 *
 * A label becomes a directory name on disk, so it is a path-traversal vector.
 * This is the server-side guard the create route reuses — never trust a
 * client-validated label.
 *
 * Allowed: ordinary free text including internal spaces and unicode
 * (e.g. `Vacation 2024`, `March — Iceland`).
 * Rejected: empty / whitespace-only, > 255 chars, path separators, `.`/`..`,
 * a leading dot, and any ASCII control character (NUL, tab, newline, …).
 */
export function isSafeLabel(label: string): boolean {
  if (!label || label.length === 0 || label.length > 255) return false;
  if (label.trim().length === 0) return false;
  if (label.includes('/') || label.includes('\\')) return false;
  if (label === '.' || label === '..') return false;
  if (label.startsWith('.')) return false;
  // Reject C0 control chars (0x00–0x1F) and DEL (0x7F).
  for (let i = 0; i < label.length; i++) {
    const code = label.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

/**
 * Assemble the library-root-relative destination path
 * `<year>/<label>/<filename>` (POSIX separators).
 *
 * Throws if the label or filename is unsafe — every caller building a
 * destination goes through here, so an unsafe segment can never reach the
 * filesystem.
 */
export function destRelPath(args: { year: string; label: string; filename: string }): string {
  if (!isSafeLabel(args.year)) {
    throw new Error(`unsafe year: ${JSON.stringify(args.year)}`);
  }
  if (!isSafeLabel(args.label)) {
    throw new Error(`unsafe import bucket label: ${JSON.stringify(args.label)}`);
  }
  if (!isSafeFilename(args.filename)) {
    throw new Error(`unsafe filename: ${JSON.stringify(args.filename)}`);
  }
  return `${args.year}/${args.label}/${args.filename}`;
}

/**
 * The no-override default: `<year>/misc/<source-folder-name>/<filename>`.
 * `folderName` is the basename of the folder the user picked as the import
 * source — same validation as a bucket label (it becomes a directory name).
 */
export function destRelPathDefault(args: {
  year: string;
  folderName: string;
  filename: string;
}): string {
  if (!isSafeLabel(args.year)) {
    throw new Error(`unsafe year: ${JSON.stringify(args.year)}`);
  }
  if (!isSafeLabel(args.folderName)) {
    throw new Error(`unsafe source folder name: ${JSON.stringify(args.folderName)}`);
  }
  if (!isSafeFilename(args.filename)) {
    throw new Error(`unsafe filename: ${JSON.stringify(args.filename)}`);
  }
  return `${args.year}/${MISC_SEGMENT}/${args.folderName}/${args.filename}`;
}

/**
 * The anonymous-dump-folder default: `<year>/<parent-folder-name>/<source-folder-name>/<filename>`.
 * Used instead of `destRelPathDefault` when the source folder's own name is
 * an uninformative camera dump-folder name (see `isNumberedShotFolder`) — the
 * parent directory's name is kept for context instead of filing everything
 * under a flat `misc`.
 */
export function destRelPathShotFolder(args: {
  year: string;
  parentFolderName: string;
  folderName: string;
  filename: string;
}): string {
  if (!isSafeLabel(args.year)) {
    throw new Error(`unsafe year: ${JSON.stringify(args.year)}`);
  }
  if (!isSafeLabel(args.parentFolderName)) {
    throw new Error(`unsafe parent folder name: ${JSON.stringify(args.parentFolderName)}`);
  }
  if (!isSafeLabel(args.folderName)) {
    throw new Error(`unsafe source folder name: ${JSON.stringify(args.folderName)}`);
  }
  if (!isSafeFilename(args.filename)) {
    throw new Error(`unsafe filename: ${JSON.stringify(args.filename)}`);
  }
  return `${args.year}/${args.parentFolderName}/${args.folderName}/${args.filename}`;
}

/**
 * Place a file next to an existing asset: `<folderPath>/<filename>`, where
 * `folderPath` is another asset's live `fileinfo[].path` (library-root
 * relative, POSIX-separated, arbitrary depth). Every segment is re-validated
 * as a safe label even though it originated from our own DB — defense in
 * depth against a legacy row written before a stricter check existed.
 */
export function destRelPathInFolder(args: { folderPath: string; filename: string }): string {
  const segments = args.folderPath.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) {
    throw new Error(`empty existing-asset folder path: ${JSON.stringify(args.folderPath)}`);
  }
  for (const seg of segments) {
    if (!isSafeLabel(seg)) {
      throw new Error(`unsafe existing-asset folder segment: ${JSON.stringify(seg)}`);
    }
  }
  if (!isSafeFilename(args.filename)) {
    throw new Error(`unsafe filename: ${JSON.stringify(args.filename)}`);
  }
  return `${segments.join('/')}/${args.filename}`;
}

/** Properties of the chosen source folder that drive the no-override default
 * destination (see `defaultDestDir`) — computed once per scan/build call
 * (`scan.ts`), not per file, since they only depend on `absRoot` itself. */
export interface SourceFolderContext {
  folderName: string;
  parentFolderName: string;
  /** True when `folderName` is an anonymous camera dump name (`Shot0123`,
   * `0123`, `012`) AND `parentFolderName` is non-empty/safe. */
  useShotFolderFallback: boolean;
}

export function resolveSourceFolderContext(absRoot: string): SourceFolderContext {
  const folderName = path.basename(absRoot);
  const parentFolderName = path.basename(path.dirname(absRoot));
  // `path.basename(path.dirname(absRoot))` is '' when `absRoot` is itself a
  // filesystem root (e.g. importing directly from `/0123`) — isSafeLabel
  // rejects an empty segment, so destRelPathShotFolder would throw for every
  // file. Fall through to the misc default in that case instead.
  const useShotFolderFallback = isNumberedShotFolder(folderName) && isSafeLabel(parentFolderName);
  return { folderName, parentFolderName, useShotFolderFallback };
}

/** The no-override default destination DIRECTORY (no filename) for `year`,
 * mirroring `destRelPathDefault`/`destRelPathShotFolder` minus the filename
 * segment and the throwing validation — used for both the review-screen
 * preview (`scan.ts`'s `scanFolder`) and a failed entry's display-only dest
 * (`buildImportFiles`'s `recordSkipped`). */
export function defaultDestDir(year: string, ctx: SourceFolderContext): string {
  return ctx.useShotFolderFallback
    ? `${year}/${ctx.parentFolderName}/${ctx.folderName}`
    : `${year}/${MISC_SEGMENT}/${ctx.folderName}`;
}
