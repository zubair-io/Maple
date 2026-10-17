/**
 * Guard for the executable paths an operator may save in the pano config
 * (#4743). The server runs `maple_cli_path` and loads `ort_dylib_path`, so a
 * path that resolves inside a registered library root would let anyone able to
 * place a file in a library (upload, SMB share) choose what the service user
 * executes. Candidates and roots are compared by real path, resolving through
 * the nearest existing ancestor when the leaf does not exist yet, so neither a
 * symlinked alias nor a not-yet-planted binary sidesteps the check; mirror roots
 * count as library roots because they receive the same member writes. Only the
 * canonical path that passed is saved, probed or spawned. Paths stored before
 * this guard existed are neutralised when the config is read.
 */

import path from 'node:path';
import { isWithinRoot, resolveRealPath } from '../fs/root.ts';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';
import { BackupRepository } from '../cloud-backup/repository.ts';
import { child as childLogger } from '../log.ts';
import {
  loadPanoConfig,
  resolvePanoConfig,
  type PanoConfigResolution,
} from './pano-config.repo.ts';

const log = childLogger('pano:config-paths');

export type ExecutableField = 'maple_cli_path' | 'ort_dylib_path';
const EXECUTABLE_FIELDS: readonly ExecutableField[] = ['maple_cli_path', 'ort_dylib_path'];

/** Real path of `absPath`, resolving the deepest existing ancestor when the leaf is missing. */
async function canonical(absPath: string): Promise<string> {
  const resolved = path.resolve(absPath);
  const missing: string[] = [];
  let probe = resolved;
  while (true) {
    try {
      return path.join(await resolveRealPath(probe), ...missing.reverse());
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return resolved;
      missing.push(path.basename(probe));
      probe = parent;
    }
  }
}

/** Every root a member's bytes can reach: the registered libraries and each
 * folder mirror destination, read fresh from the database on every check. A
 * paused mirror counts too — it still holds bytes replicated while it was
 * enabled — and reading persisted state (not this process's registry snapshot)
 * means a mirror enabled, repointed or disabled from the API process is seen
 * by the worker before it spawns. */
async function memberWritableRoots(): Promise<{ root: string; via: string }[]> {
  const [libraries, destinations] = await Promise.all([
    loadLibraryRoots(),
    new BackupRepository().destinations(),
  ]);
  const candidates = [
    ...[...libraries.values()].map((root) => ({ root, via: 'library root' })),
    ...destinations
      .filter((d) => d.kind === 'folder' && typeof d.path === 'string' && d.path.length > 0)
      .map((d) => ({ root: d.path as string, via: 'library mirror root' })),
  ];
  return Promise.all(
    candidates.map(async ({ root, via }) => ({ root: await canonical(root), via })),
  );
}

type ExecutableJailVerdict = { ok: true; canonical: string } | { ok: false; error: string };

/** Canonicalise one executable path and refuse it when it sits under any
 * member-writable root. The canonical path is what callers must save, probe and
 * spawn — never the pathname as typed, whose symlinks a library writer could
 * swing between check and open. */
async function jailExecutablePath(
  field: ExecutableField,
  value: string,
): Promise<ExecutableJailVerdict> {
  const [real, roots] = await Promise.all([canonical(value.trim()), memberWritableRoots()]);
  const hit = roots.find(({ root }) => isWithinRoot(root, real));
  return hit
    ? {
        ok: false,
        error: `${field} must not point inside a ${hit.via} (${hit.root}); the server executes it`,
      }
    : { ok: true, canonical: real };
}

/** Canonicalise the executable paths in `patch`, or the first rejection. */
export async function jailExecutablePaths(
  patch: Partial<Record<ExecutableField, string | null>>,
): Promise<
  { ok: true; canonical: Partial<Record<ExecutableField, string>> } | { ok: false; error: string }
> {
  const canonicalPaths: Partial<Record<ExecutableField, string>> = {};
  for (const field of EXECUTABLE_FIELDS) {
    const value = patch[field];
    if (typeof value !== 'string' || value.trim().length === 0) continue;
    const verdict = await jailExecutablePath(field, value);
    if (!verdict.ok) return verdict;
    canonicalPaths[field] = verdict.canonical;
  }
  return { ok: true, canonical: canonicalPaths };
}

/** The effective pano config with any stored executable path that sits inside a
 * library root treated as unset, so it is never probed or run. */
export async function loadEffectivePanoConfig(): Promise<PanoConfigResolution> {
  const cfg = resolvePanoConfig(await loadPanoConfig());
  for (const field of EXECUTABLE_FIELDS) {
    const value = cfg[field];
    if (value === null) continue;
    const verdict = await jailExecutablePath(field, value);
    if (verdict.ok) {
      cfg[field] = verdict.canonical;
      continue;
    }
    log.warn({ field, path: value, reason: verdict.error }, 'pano config: ignoring executable');
    cfg[field] = null;
    cfg.source[field] = 'unset';
  }
  return cfg;
}
