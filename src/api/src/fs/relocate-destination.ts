/**
 * Step 1 of `relocateFile` (`fs/relocate.ts`): collision resolution. Split out
 * of `relocate.ts` to keep that file under its file-size headroom.
 */
import * as fs from './mirrored.ts';
import * as path from 'node:path';
import { child as childLogger } from '../log.ts';
import { assetDestinationOccupied } from './sidecar-ownership.ts';
import { companionNameTaken, stackCompanionTarget } from './relocate-stack.ts';
import type { CollisionPolicy, RelocateRequest } from './relocate.ts';

const log = childLogger('fs/relocate');

/** Append `.N.<ext>` until the path is free. Bounded to 1000 attempts.
 *
 * Pass `caller` so the warn log identifies which code path triggered the
 * collision (e.g. `'moveToTrash'`, `'moveToDuplicates'`, `'migration:primary'`).
 * A collision means the destination already held a file with that name — the
 * returned suffixed path is what actually ends up on disk and in the DB, which
 * is how `_MG_4226.1.ARW`-style names are created.
 *
 * Throws after exhausting all candidates rather than returning the last
 * (occupied) one — the prior behaviour would have let the subsequent
 * `fs.rename` overwrite an existing file, causing data loss.
 *
 * Extensionless-input edge case: `path.extname("/x/foo")` returns `""`, and
 * `basePath.slice(0, -0)` is `""` — naively building `${stem}.${n}${ext}`
 * would produce `.1` (a root-level dotfile), losing the basename entirely.
 * Guard the slice on a non-empty ext so an extensionless input simply gets
 * the suffix appended (`/x/foo` → `/x/foo.1`). */
export async function pickFreePath(
  basePath: string,
  caller?: string,
  occupied: (candidate: string) => Promise<boolean> = pathExists,
): Promise<string> {
  if (!(await occupied(basePath))) return basePath;
  const ext = path.extname(basePath);
  const stem = ext ? basePath.slice(0, -ext.length) : basePath;
  for (let n = 1; n <= 1000; n++) {
    const cand = `${stem}.${n}${ext}`;
    if (!(await occupied(cand))) {
      log.warn(
        { caller: caller ?? 'unknown', collision: basePath, chosen: cand },
        'pickFreePath: destination occupied — suffixed path chosen (this creates a .N. filename)',
      );
      return cand;
    }
  }
  throw new Error(`pickFreePath: collision — exceeded 1000 candidate paths for ${basePath}`);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

type DestinationResolution =
  | { kind: 'proceed'; finalDest: string }
  | { kind: 'skip'; collidedAt: string };

/** Step 1: resolve the destination per the caller's collision policy.
 * `'auto-suffix'` / `'keep-both'` pick the next free `.N` sibling;
 * `'skip'` declines outright when the destination is occupied; `'replace'`
 * (and a `'skip'` that finds nothing occupying the destination) proceeds
 * with `destAbsPath` exactly as given. A stack's JPEG name counts too: a
 * suffix is free only for both, and a taken JPEG name skips the pair unless
 * the JPEG may replace it (#5929). */
export async function resolveDestination(
  req: RelocateRequest,
  ownSidecars: readonly string[],
): Promise<DestinationResolution> {
  const occupied = (candidate: string) =>
    req.carrySidecars === false
      ? pathExists(candidate)
      : assetDestinationOccupied(candidate, ownSidecars, req.sourceAbsPath);
  const companion = req.stackCompanion;
  if (isSuffixing(req.collision)) {
    const taken = async (candidate: string) =>
      (await occupied(candidate)) || (await companionNameTaken(companion, candidate));
    const finalDest = await pickFreePath(req.destAbsPath, req.callerTag ?? 'relocate', taken);
    return { kind: 'proceed', finalDest };
  }
  if (req.collision === 'skip' && (await occupied(req.destAbsPath))) {
    return { kind: 'skip', collidedAt: req.destAbsPath };
  }
  if (companion && !companion.replace && (await companionNameTaken(companion, req.destAbsPath))) {
    return {
      kind: 'skip',
      collidedAt: stackCompanionTarget(req.destAbsPath, companion.sourceAbsPath),
    };
  }
  return { kind: 'proceed', finalDest: req.destAbsPath };
}

export function isSuffixing(collision: CollisionPolicy): boolean {
  return collision === 'auto-suffix' || collision === 'keep-both';
}

/** Whether a relocate may replace a file at the primary's or the stack JPEG's name. */
export function replacesOccupants(req: RelocateRequest): boolean {
  return (
    req.collision === 'replace' ||
    (!isSuffixing(req.collision) && req.stackCompanion?.replace === true)
  );
}
