/**
 * Short-lived panorama preview artifacts (#4580). Each `pano_preview` job owns
 * one directory under the process temp dir holding the preview PNG, the solved
 * alignment a follow-up stitch can start from, and the CLI report.
 *
 * Lifetime: a failed or cancelled preview removes its own directory; the stitch
 * that consumed an alignment removes that preview's directory once it lands;
 * anything left behind (an abandoned dialog, a server restart) is swept once it
 * is older than {@link PREVIEW_TTL_MS} whenever another preview starts or a
 * stitch finishes.
 */

import { readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { child as childLogger } from '../log.ts';

const log = childLogger('pano:previews');

export const PREVIEW_TTL_MS = 60 * 60 * 1000;

export const PREVIEW_FILES = {
  image: 'preview.png',
  alignment: 'alignment.json',
  report: 'report.json',
} as const;

function previewsRoot(): string {
  return path.join(os.tmpdir(), 'maple-pano-previews');
}

export function newPreviewDir(): string {
  return path.join(previewsRoot(), randomBytes(8).toString('hex'));
}

/** A job payload's directory, only when it is one this module hands out. */
export function ownedPreviewDir(dir: unknown): string | null {
  if (typeof dir !== 'string') return null;
  const resolved = path.resolve(dir);
  return path.dirname(resolved) === previewsRoot() ? resolved : null;
}

export async function removePreviewDir(dir: string): Promise<void> {
  const owned = ownedPreviewDir(dir);
  if (owned === null) return;
  await rm(owned, { recursive: true, force: true }).catch((err) => {
    log.warn({ err, dir: owned }, 'pano: failed to remove preview dir');
  });
}

export async function sweepStalePreviews(now: number = Date.now()): Promise<number> {
  const root = previewsRoot();
  const names = await readdir(root).catch(() => [] as string[]);
  const stale = await Promise.all(
    names.map(async (name) => {
      const dir = path.join(root, name);
      const mtime = await stat(dir)
        .then((s) => s.mtimeMs)
        .catch(() => now);
      return now - mtime > PREVIEW_TTL_MS ? dir : null;
    }),
  );
  const doomed = stale.filter((dir): dir is string => dir !== null);
  await Promise.all(doomed.map(removePreviewDir));
  return doomed.length;
}
